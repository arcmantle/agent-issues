import { randomUUID } from "node:crypto";
import { recordHistoryMaterialization } from "../history-diagnostics.js";

import {
	computeContextContentHash,
	computeContextTermContentHash,
	ContextConflictError,
	ContextRevisionError,
	ContextTermConflictError,
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	DEFAULT_PROJECT_ID,
	filterContextDirectory,
	isEntityKind,
	mergeContextDirectory,
	materializeContextFromPatches,
	materializeContextTermFromPatches,
	RESERVED_SYSTEM_AUTHOR,
	type ContextDetails,
	type ContextDirectory,
	type ContextDirectoryTerm,
	type ContextDirectoryTermSource,
	type ContextDirectoryView,
	type ContextListItem,
	type ContextListResult,
	type ContextRecord,
	type ContextTermRecord,
	type MaterializedContextRevision,
	type MaterializedContextTermRevision,
	type DefineContextTermResult,
	type EntityKind,
	type ForgetContextTermResult,
	type QueryContextDirectoryInput,
	type QueryContextDirectoryResult
} from "@agent-issues/core";
import { sql } from "drizzle-orm";
import type { SqliteExecutor } from "../../db/sqlite-executor.js";


export {
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	type ContextDetails,
	type ContextDirectory,
	type ContextDirectoryTerm,
	type ContextDirectoryTermSource,
	type ContextDirectoryView,
	type ContextListItem,
	type ContextListResult,
	type ContextRecord,
	type ContextTermRecord,
	type DefineContextTermResult,
	type ForgetContextTermResult,
	type QueryContextDirectoryInput,
	type QueryContextDirectoryResult
};

const STRUCTURAL_CONTEXT_RELATIONS = ["owns", "records", "tracks", "creates", "decomposes"] as const;

type ContextRow = {
	key: string;
	scope_entity_id: string | null;
	title: string;
	summary: string;
	revision: number;
	content_hash: string;
	created_at: string;
	updated_at: string;
};

type EntityRow = {
	id: string;
	kind: string;
	title: string;
	status: string;
	created_at: string;
	updated_at: string;
};

type ContextTermRow = {
	term: string;
	definition: string;
	avoid_terms: string;
	revision: number;
	content_hash: string;
	tombstone: number;
	created_at: string;
	updated_at: string;
};

type ContextTermHead = ContextTermRecord & { tombstone: boolean };

type ContextDeltaRow = {
	revision: number;
	author: string;
	prior_title: string;
	prior_summary: string;
	restored_from_revision: number | null;
	created_at: string;
};

type ContextTermDeltaRow = {
	revision: number;
	author: string;
	prior_definition: string;
	prior_avoid_terms: string;
	prior_tombstone: number;
	restored_from_revision: number | null;
	created_at: string;
};

type ResolvedContextScope = {
	key: string;
	scopeKind: "default" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	defaultTitle: string;
	defaultSummary: string;
};

export function listContexts(db: SqliteExecutor): ContextListResult {
	const rows = db.drizzle.all(sql`SELECT * FROM contexts WHERE tenant_id = ${db.tenantId} ORDER BY key`) as ContextRow[];
	const rowByScopeEntityId = new Map<string, ContextRow>();
	const rowByKey = new Map<string, ContextRow>();

	for (const row of rows) {
		rowByKey.set(row.key, row);
		if (row.scope_entity_id) {
			rowByScopeEntityId.set(row.scope_entity_id, row);
		}
	}

	const defaultScope = getDefaultContextScope(db);
	const contexts: ContextListItem[] = [
		createContextListItem(defaultScope, rowByKey.get(defaultScope.key), getContextTermCount(db, defaultScope.key))
	];

	const initiativeRows = db.drizzle.all(
		sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND kind = 'initiative' ORDER BY id`
	) as EntityRow[];

	for (const initiativeRow of initiativeRows) {
		const initiative = mapEntityRow(initiativeRow);
		const scope = createInitiativeScope(initiative);
		const row = rowByScopeEntityId.get(initiative.id);
		contexts.push(createContextListItem(scope, row, getContextTermCount(db, row?.key ?? initiative.id)));
	}

	return { contexts };
}

export function getContextDetails(db: SqliteExecutor, input?: { scopeRef?: string }): ContextDetails {
	const scope = resolveContextScope(db, input?.scopeRef);
	const contextRow = db.drizzle.all(
		sql`SELECT * FROM contexts WHERE tenant_id = ${db.tenantId} AND key = ${scope.key}`
	)[0] as ContextRow | undefined;
	const termRows = contextRow
		? (db.drizzle.all(
				sql`SELECT term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at
					FROM context_terms
					WHERE tenant_id = ${db.tenantId}
						AND context_key = ${scope.key}
						AND tombstone = FALSE
					ORDER BY lower(term), term`
			) as ContextTermRow[])
		: [];

	return {
		context: contextRow ? mapContextRow(contextRow, scope) : createContextRecord(scope),
		terms: termRows.map(mapContextTermRow)
	};
}

export function getContextDirectory(db: SqliteExecutor): ContextDirectory {
	const shared = getContextDetails(db);
	const initiativeRows = db.drizzle.all(
		sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND kind = 'initiative' ORDER BY id`
	) as EntityRow[];
	const initiatives = initiativeRows.map((row) => getContextDetails(db, { scopeRef: row.id }));

	return mergeContextDirectory(shared, initiatives);
}

export function queryContextDirectory(db: SqliteExecutor, input: QueryContextDirectoryInput = {}): QueryContextDirectoryResult {
	const directory = getContextDirectory(db);
	return filterContextDirectory(directory, input);
}

export function upsertContext(db: SqliteExecutor, input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): ContextDetails {
	const title = input.title.trim();
	const summary = input.summary.trim();

	if (title.length === 0) {
		throw new Error("Context title must not be empty.");
	}

	if (summary.length === 0) {
		throw new Error("Context summary must not be empty.");
	}

	const scope = resolveContextScope(db, input.scopeRef);

	return db.transaction(() => {
		const existing = getContextDetails(db, { scopeRef: input.scopeRef }).context;
		const now = new Date().toISOString();
		const newContentHash = computeContextContentHash(title, summary);

		if (existing.exists) {
			const newRevision = existing.revision + 1;

			if (input.expectedRevision === undefined || input.expectedContentHash === undefined) {
				throw new ContextConflictError(scope.key, existing.revision, existing.contentHash);
			}

			if (existing.revision !== input.expectedRevision || existing.contentHash !== input.expectedContentHash) {
				throw new ContextConflictError(scope.key, existing.revision, existing.contentHash);
			}

			const result = db.drizzle.run(
				sql`UPDATE contexts SET title = ${title}, summary = ${summary}, revision = ${newRevision}, content_hash = ${newContentHash}, updated_at = ${now}
					WHERE tenant_id = ${db.tenantId} AND key = ${scope.key} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`
			);

			if (result.changes === 0) {
				const fresh = getContextDetails(db, { scopeRef: input.scopeRef }).context;
				throw new ContextConflictError(scope.key, fresh.revision, fresh.contentHash);
			}

			appendContextDeltaEntry(db, scope.key, newRevision, existing.title, existing.summary, input.author, now);
		} else {
			db.drizzle.run(
				sql`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, revision, content_hash, created_at, updated_at)
					VALUES (${db.tenantId}, ${scope.key}, ${scope.scopeEntityId}, ${title}, ${summary}, 1, ${newContentHash}, ${now}, ${now})`
			);
			appendContextDeltaEntry(db, scope.key, 1, title, summary, input.author, now);
		}

		return getContextDetails(db, { scopeRef: input.scopeRef });
	});
}

export function defineContextTerm(
	db: SqliteExecutor,
	input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }
): DefineContextTermResult {
	const term = input.term.trim();
	const definition = input.definition.trim();

	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	if (definition.length === 0) {
		throw new Error("Context term definition must not be empty.");
	}

	const scope = ensureContextExists(db, input.scopeRef);

	const normalizedAvoid = normalizeAvoidTerms(input.avoid ?? [], term);
	const existing = getContextTerm(db, scope.key, term);
	const now = new Date().toISOString();

	const contentHash = computeContextTermContentHash(definition, normalizedAvoid, false);
	db.transaction(() => {
		if (existing) {
			assertContextTermHead(scope.key, term, existing, input.expectedRevision, input.expectedContentHash);
			const revision = existing.revision + 1;
			const result = db.drizzle.run(sql`UPDATE context_terms
				SET definition = ${definition}, avoid_terms = ${JSON.stringify(normalizedAvoid)}, revision = ${revision}, content_hash = ${contentHash}, tombstone = FALSE, updated_at = ${now}
				WHERE tenant_id = ${db.tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
			if (result.changes === 0) {
				const fresh = getContextTerm(db, scope.key, term)!;
				throw new ContextTermConflictError(scope.key, term, fresh.revision, fresh.contentHash);
			}
			appendContextTermDeltaEntry(db, scope.key, term, revision, existing, input.author, now);
		} else {
			db.drizzle.run(sql`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at)
				VALUES (${db.tenantId}, ${scope.key}, ${term}, ${definition}, ${JSON.stringify(normalizedAvoid)}, 1, ${contentHash}, FALSE, ${now}, ${now})`);
			db.drizzle.run(sql`INSERT INTO context_term_delta_entries (id, tenant_id, context_key, term, revision, author, prior_definition, prior_avoid_terms, prior_tombstone, created_at)
				VALUES (${randomUUID()}, ${db.tenantId}, ${scope.key}, ${term}, 1, ${input.author?.trim() || RESERVED_SYSTEM_AUTHOR}, ${definition}, ${JSON.stringify(normalizedAvoid)}, FALSE, ${now})`);
		}
	});

	const storedTerm = getContextTerm(db, scope.key, term);
	if (!storedTerm) {
		throw new Error(`Failed to persist context term: ${term}`);
	}
	const { tombstone: _tombstone, ...publicTerm } = storedTerm;

	return {
		context: getContextDetails(db, { scopeRef: input.scopeRef }).context,
		term: publicTerm,
		created: existing === null
	};
}

export function forgetContextTerm(db: SqliteExecutor, input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): ForgetContextTermResult {
	const term = input.term.trim();
	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	const scope = resolveContextScope(db, input.scopeRef);
	const existing = getContextTerm(db, scope.key, term);
	if (!existing) {
		return { context: getContextDetails(db, { scopeRef: input.scopeRef }).context, term, removed: false };
	}

	assertContextTermHead(scope.key, term, existing, input.expectedRevision, input.expectedContentHash);
	if (existing.tombstone) {
		return {
			context: getContextDetails(db, { scopeRef: input.scopeRef }).context,
			term,
			removed: false,
			currentRevision: existing.revision,
			currentContentHash: existing.contentHash
		};
	}

	const revision = existing.revision + 1;
	const contentHash = computeContextTermContentHash(existing.definition, existing.avoid, true);
	const now = new Date().toISOString();
	db.transaction(() => {
		const result = db.drizzle.run(sql`UPDATE context_terms SET revision = ${revision}, content_hash = ${contentHash}, tombstone = TRUE, updated_at = ${now}
			WHERE tenant_id = ${db.tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
		if (result.changes === 0) {
			const fresh = getContextTerm(db, scope.key, term)!;
			throw new ContextTermConflictError(scope.key, term, fresh.revision, fresh.contentHash);
		}
		appendContextTermDeltaEntry(db, scope.key, term, revision, existing, input.author, now);
	});

	return {
		context: getContextDetails(db, { scopeRef: input.scopeRef }).context,
		term,
		removed: true,
		currentRevision: revision,
		currentContentHash: contentHash
	};
}

export function materializeContextRevision(
	db: SqliteExecutor,
	input: { scopeRef?: string; revision: number }
): MaterializedContextRevision {
	const scope = resolveContextScope(db, input.scopeRef);
	const head = db.drizzle.all(sql`SELECT * FROM contexts WHERE tenant_id = ${db.tenantId} AND key = ${scope.key}`)[0] as ContextRow | undefined;
	if (!head) {
		throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
	}
	const rows = db.drizzle.all(sql`SELECT revision, author, prior_title, prior_summary, restored_from_revision, created_at
		FROM context_delta_entries
		WHERE tenant_id = ${db.tenantId} AND context_key = ${scope.key}
		ORDER BY revision DESC`) as ContextDeltaRow[];
	const result = materializeContextFromPatches(
		{ key: head.key, title: head.title, summary: head.summary, revision: head.revision, createdAt: head.created_at },
		rows.map((row) => ({ revision: row.revision, author: row.author, createdAt: row.created_at, priorTitle: row.prior_title, priorSummary: row.prior_summary, ...(row.restored_from_revision !== null && { restoredFromRevision: row.restored_from_revision }) })),
		input.revision
	);
	recordHistoryMaterialization(db, "context", result.headRevision, result.targetRevision);
	return result;
}

export function restoreContextRevision(
	db: SqliteExecutor,
	input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }
): MaterializedContextRevision {
	const scope = resolveContextScope(db, input.scopeRef);
	const current = getContextDetails(db, { scopeRef: input.scopeRef }).context;
	if (!current.exists) {
		throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
	}
	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new ContextConflictError(scope.key, current.revision, current.contentHash);
	}
	const source = materializeContextRevision(db, { scopeRef: input.scopeRef, revision: input.revision });

	return db.transaction(() => {
		const revision = current.revision + 1;
		const contentHash = computeContextContentHash(source.title, source.summary);
		const updatedAt = new Date().toISOString();
		const result = db.drizzle.run(sql`UPDATE contexts
			SET title = ${source.title}, summary = ${source.summary}, revision = ${revision}, content_hash = ${contentHash}, updated_at = ${updatedAt}
			WHERE tenant_id = ${db.tenantId} AND key = ${scope.key} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
		if (result.changes === 0) {
			const fresh = getContextDetails(db, { scopeRef: input.scopeRef }).context;
			throw new ContextConflictError(scope.key, fresh.revision, fresh.contentHash);
		}
		appendContextDeltaEntry(db, scope.key, revision, current.title, current.summary, input.author, updatedAt, input.revision);
		return materializeContextRevision(db, { scopeRef: input.scopeRef, revision });
	});
}

export function materializeContextTermRevision(
	db: SqliteExecutor,
	input: { scopeRef?: string; term: string; revision: number }
): MaterializedContextTermRevision {
	const scope = resolveContextScope(db, input.scopeRef);
	const head = getContextTerm(db, scope.key, input.term.trim());
	if (!head) {
		throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${input.term}`, undefined, input.term);
	}
	const rows = db.drizzle.all(sql`SELECT revision, author, prior_definition, prior_avoid_terms, prior_tombstone, restored_from_revision, created_at
		FROM context_term_delta_entries
		WHERE tenant_id = ${db.tenantId} AND context_key = ${scope.key} AND term = ${head.term}
		ORDER BY revision DESC`) as ContextTermDeltaRow[];
	const result = materializeContextTermFromPatches(
		{ contextKey: scope.key, term: head.term, definition: head.definition, avoid: head.avoid, tombstone: head.tombstone, revision: head.revision, createdAt: head.createdAt },
		rows.map((row) => ({ revision: row.revision, author: row.author, createdAt: row.created_at, priorDefinition: row.prior_definition, priorAvoid: parseAvoidTerms(row.prior_avoid_terms), priorTombstone: Boolean(row.prior_tombstone), ...(row.restored_from_revision !== null && { restoredFromRevision: row.restored_from_revision }) })),
		input.revision
	);
	recordHistoryMaterialization(db, "context-term", result.headRevision, result.targetRevision);
	return result;
}

export function restoreContextTermRevision(
	db: SqliteExecutor,
	input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }
): MaterializedContextTermRevision {
	const scope = resolveContextScope(db, input.scopeRef);
	const term = input.term.trim();
	const current = getContextTerm(db, scope.key, term);
	if (!current) {
		throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${term}`, undefined, term);
	}
	assertContextTermHead(scope.key, term, current, input.expectedRevision, input.expectedContentHash);
	const source = materializeContextTermRevision(db, { scopeRef: input.scopeRef, term, revision: input.revision });

	return db.transaction(() => {
		const revision = current.revision + 1;
		const contentHash = computeContextTermContentHash(source.definition, source.avoid, source.tombstone);
		const updatedAt = new Date().toISOString();
		const result = db.drizzle.run(sql`UPDATE context_terms
			SET definition = ${source.definition}, avoid_terms = ${JSON.stringify(source.avoid)}, revision = ${revision}, content_hash = ${contentHash}, tombstone = ${source.tombstone ? 1 : 0}, updated_at = ${updatedAt}
			WHERE tenant_id = ${db.tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
		if (result.changes === 0) {
			const fresh = getContextTerm(db, scope.key, term)!;
			throw new ContextTermConflictError(scope.key, term, fresh.revision, fresh.contentHash);
		}
		appendContextTermDeltaEntry(db, scope.key, term, revision, current, input.author, updatedAt, input.revision);
		return materializeContextTermRevision(db, { scopeRef: input.scopeRef, term, revision });
	});
}


function ensureContextExists(db: SqliteExecutor, scopeRef?: string): ResolvedContextScope {
	const scope = resolveContextScope(db, scopeRef);
	const existing = db.drizzle.all(
		sql`SELECT key FROM contexts WHERE tenant_id = ${db.tenantId} AND key = ${scope.key}`
	)[0] as { key: string } | undefined;
	if (existing) {
		return scope;
	}

	const now = new Date().toISOString();
	const contentHash = computeContextContentHash(scope.defaultTitle, scope.defaultSummary);
	db.drizzle.run(sql`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, revision, content_hash, created_at, updated_at)
		VALUES (${db.tenantId}, ${scope.key}, ${scope.scopeEntityId}, ${scope.defaultTitle}, ${scope.defaultSummary}, 1, ${contentHash}, ${now}, ${now})`);
	appendContextDeltaEntry(db, scope.key, 1, scope.defaultTitle, scope.defaultSummary, undefined, now);

	return scope;
}

function appendContextDeltaEntry(
	db: SqliteExecutor,
	contextKey: string,
	revision: number,
	priorTitle: string,
	priorSummary: string,
	author: string | undefined,
	createdAt: string,
	restoredFromRevision?: number
): void {
	const id = randomUUID();
	const authorValue = author?.trim() || RESERVED_SYSTEM_AUTHOR;
	db.drizzle.run(
		sql`INSERT INTO context_delta_entries (id, tenant_id, context_key, revision, author, prior_title, prior_summary, restored_from_revision, created_at)
			VALUES (${id}, ${db.tenantId}, ${contextKey}, ${revision}, ${authorValue}, ${priorTitle}, ${priorSummary}, ${restoredFromRevision ?? null}, ${createdAt})`
	);
}

function getContextTerm(db: SqliteExecutor, contextKey: string, term: string): ContextTermHead | null {
	const row = db.drizzle.all(sql`SELECT term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at
		FROM context_terms
		WHERE tenant_id = ${db.tenantId} AND context_key = ${contextKey} AND term = ${term}`)[0] as ContextTermRow | undefined;

	return row ? { ...mapContextTermRow(row), tombstone: Boolean(row.tombstone) } : null;
}

function assertContextTermHead(
	contextKey: string,
	term: string,
	existing: ContextTermHead,
	expectedRevision: number | undefined,
	expectedContentHash: string | undefined
): void {
	if (expectedRevision !== existing.revision || expectedContentHash !== existing.contentHash) {
		throw new ContextTermConflictError(contextKey, term, existing.revision, existing.contentHash);
	}
}

function appendContextTermDeltaEntry(
	db: SqliteExecutor,
	contextKey: string,
	term: string,
	revision: number,
	prior: ContextTermHead,
	author: string | undefined,
	createdAt: string,
	restoredFromRevision?: number
): void {
	db.drizzle.run(sql`INSERT INTO context_term_delta_entries (id, tenant_id, context_key, term, revision, author, prior_definition, prior_avoid_terms, prior_tombstone, restored_from_revision, created_at)
		VALUES (${randomUUID()}, ${db.tenantId}, ${contextKey}, ${term}, ${revision}, ${author?.trim() || RESERVED_SYSTEM_AUTHOR}, ${prior.definition}, ${JSON.stringify(prior.avoid)}, ${prior.tombstone ? 1 : 0}, ${restoredFromRevision ?? null}, ${createdAt})`);
}

function createContextRecord(scope: ResolvedContextScope): ContextRecord {
	return {
		key: scope.key,
		scopeKind: scope.scopeKind,
		scopeEntityId: scope.scopeEntityId,
		scopeLabel: scope.scopeLabel,
		title: scope.defaultTitle,
		summary: scope.defaultSummary,
		revision: 0,
		contentHash: "",
		createdAt: null,
		updatedAt: null,
		exists: false
	};
}

function mapContextRow(row: ContextRow, scope: ResolvedContextScope): ContextRecord {
	return {
		key: row.key,
		scopeKind: scope.scopeKind,
		scopeEntityId: row.scope_entity_id,
		scopeLabel: scope.scopeLabel,
		title: row.title,
		summary: row.summary,
		revision: row.revision ?? 1,
		contentHash: row.content_hash ?? "",
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		exists: true
	};
}

function mapContextTermRow(row: ContextTermRow): ContextTermRecord {
	return {
		term: row.term,
		definition: row.definition,
		avoid: parseAvoidTerms(row.avoid_terms),
		revision: row.revision,
		contentHash: row.content_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function parseAvoidTerms(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}

		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function normalizeAvoidTerms(avoid: string[], term: string): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const candidate of avoid) {
		const cleaned = candidate.trim();
		if (cleaned.length === 0 || cleaned.toLowerCase() === term.toLowerCase()) {
			continue;
		}

		const key = cleaned.toLowerCase();
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		normalized.push(cleaned);
	}

	return normalized;
}

function resolveContextScope(db: SqliteExecutor, scopeRef?: string): ResolvedContextScope {
	if (!scopeRef || scopeRef === DEFAULT_CONTEXT_KEY) {
		return getDefaultContextScope(db);
	}

	const entity = getEntityOrThrow(db, scopeRef);
	if (entity.kind === "initiative") {
		return createInitiativeScope(entity);
	}

	if (entity.kind === "project") {
		return createProjectScope(entity);
	}

	const initiative = getOwningInitiativeOrThrow(db, entity.id);
	return createInitiativeScope(initiative);
}

/**
 * The tenant's sentinel default scope (`DEFAULT_PROJECT_ID`/"PROJ0"), used
 * both when a workspace's own project IS that sentinel (the common
 * single-project-tenant case, unchanged since before ISS166) and when an
 * explicit `--scope` names that project directly.
 */
function createSentinelDefaultScope(): ResolvedContextScope {
	return {
		key: DEFAULT_CONTEXT_KEY,
		scopeKind: "default",
		scopeEntityId: null,
		scopeLabel: "Shared",
		defaultTitle: DEFAULT_CONTEXT_TITLE,
		defaultSummary: DEFAULT_CONTEXT_SUMMARY
	};
}

/**
 * A specific project's own shared/default context scope (ISS166). Keyed
 * `default:<projectId>` to match exactly what ISS60's tenant-to-project
 * migration already wrote when it namespaced a folded-in legacy tenant's
 * "default" context row to avoid colliding with every other project now
 * sharing this tenant - so those rows become reachable again once
 * `resolveContextScope` resolves this same key.
 */
function createProjectScope(project: EntityRecord): ResolvedContextScope {
	if (project.id === DEFAULT_PROJECT_ID) {
		return createSentinelDefaultScope();
	}

	return {
		key: `${DEFAULT_CONTEXT_KEY}:${project.id}`,
		scopeKind: "default",
		scopeEntityId: null,
		scopeLabel: project.title,
		defaultTitle: `${project.title} Context`,
		defaultSummary: `Shared glossary of project-specific domain terms and preferred language for ${project.title}.`
	};
}

/**
 * Bare (no `--scope`) context resolution (ISS166): resolves to the CURRENT
 * workspace's own project's shared glossary - `db.currentProjectId`,
 * resolved once per open from `currentWorkingDirectory` - instead of the
 * one tenant-wide literal "default" every project used to collide on.
 */
function getDefaultContextScope(db: SqliteExecutor): ResolvedContextScope {
	if (db.currentProjectId === DEFAULT_PROJECT_ID) {
		return createSentinelDefaultScope();
	}

	return createProjectScope(getEntityOrThrow(db, db.currentProjectId));
}

function createInitiativeScope(initiative: EntityRecord): ResolvedContextScope {
	return {
		key: initiative.id,
		scopeKind: "initiative",
		scopeEntityId: initiative.id,
		scopeLabel: initiative.title,
		defaultTitle: `${initiative.title} Context`,
		defaultSummary: `Glossary of initiative-specific domain terms for ${initiative.title}.`
	};
}

function createContextListItem(scope: ResolvedContextScope, row: ContextRow | undefined, termCount: number): ContextListItem {
	return {
		context: row ? mapContextRow(row, scope) : createContextRecord(scope),
		termCount
	};
}

function getContextTermCount(db: SqliteExecutor, contextKey: string): number {
	const row = db.drizzle.all(
		sql`SELECT COUNT(*) as count FROM context_terms WHERE tenant_id = ${db.tenantId} AND context_key = ${contextKey} AND tombstone = FALSE`
	)[0] as { count: number };
	return row.count;
}

type EntityRecord = {
	id: string;
	kind: EntityKind;
	title: string;
	status: string;
	createdAt: string;
	updatedAt: string;
};

function getEntityOrThrow(db: SqliteExecutor, entityId: string): EntityRecord {
	const row = db.drizzle.all(
		sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND id = ${entityId}`
	)[0] as EntityRow | undefined;
	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return mapEntityRow(row);
}

function getOwningInitiativeOrThrow(db: SqliteExecutor, entityId: string): EntityRecord {
	let currentId = entityId;
	const seen = new Set<string>([entityId]);

	while (true) {
		const parents = db.drizzle.all(sql`SELECT entities.*
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			WHERE relations.tenant_id = ${db.tenantId}
				AND relations.to_id = ${currentId}
				AND relations.type IN ('owns', 'records', 'tracks', 'creates', 'decomposes')
			ORDER BY entities.id`) as EntityRow[];

		if (parents.length === 0) {
			throw new Error(`No owning initiative found for ${entityId}.`);
		}

		if (parents.length > 1) {
			throw new Error(`Cannot resolve owning initiative for ${entityId} because ${currentId} has multiple structural parents.`);
		}

		const parent = mapEntityRow(parents[0]);
		if (seen.has(parent.id)) {
			throw new Error(`Cannot resolve owning initiative for ${entityId} because the structural graph contains a cycle.`);
		}

		if (parent.kind === "initiative") {
			return parent;
		}

		seen.add(parent.id);
		currentId = parent.id;
	}
}

function mapEntityRow(row: EntityRow): EntityRecord {
	if (!isEntityKind(row.kind)) {
		throw new Error(`Unexpected entity kind in database: ${row.kind}`);
	}

	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function tenantParams<T extends Record<string, unknown>>(db: SqliteExecutor, values: T): T & { tenantId: string } {
	return {
		tenantId: db.tenantId,
		...values
	};
}