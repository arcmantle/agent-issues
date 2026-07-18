import {
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	DEFAULT_PROJECT_ID,
	filterContextDirectory,
	isEntityKind,
	mergeContextDirectory,
	type ContextDetails,
	type ContextDirectory,
	type ContextDirectoryTerm,
	type ContextDirectoryTermSource,
	type ContextDirectoryView,
	type ContextListItem,
	type ContextListResult,
	type ContextRecord,
	type ContextSyncRecord,
	type ContextTermRecord,
	type ContextTermSyncRecord,
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
	type ContextSyncRecord,
	type ContextTermRecord,
	type ContextTermSyncRecord,
	type DefineContextTermResult,
	type ForgetContextTermResult,
	type QueryContextDirectoryInput,
	type QueryContextDirectoryResult
};

const STRUCTURAL_CONTEXT_RELATIONS = ["owns", "records", "tracks", "creates"] as const;

type ContextRow = {
	key: string;
	scope_entity_id: string | null;
	title: string;
	summary: string;
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
	created_at: string;
	updated_at: string;
};

/** Row shape for the bulk sync read path, which unlike `ContextTermRow` isn't scoped to a single already-known context and so needs `context_key` in the projection. */
type ContextTermSyncRow = ContextTermRow & { context_key: string };

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
				sql`SELECT term, definition, avoid_terms, created_at, updated_at
					FROM context_terms
					WHERE tenant_id = ${db.tenantId}
						AND context_key = ${scope.key}
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

export function upsertContext(db: SqliteExecutor, input: { scopeRef?: string; title: string; summary: string }): ContextDetails {
	const title = input.title.trim();
	const summary = input.summary.trim();

	if (title.length === 0) {
		throw new Error("Context title must not be empty.");
	}

	if (summary.length === 0) {
		throw new Error("Context summary must not be empty.");
	}

	const scope = resolveContextScope(db, input.scopeRef);
	const existing = getContextDetails(db, { scopeRef: input.scopeRef }).context;
	const now = new Date().toISOString();

	db.drizzle.run(sql`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
		VALUES (${db.tenantId}, ${scope.key}, ${scope.scopeEntityId}, ${title}, ${summary}, ${existing.createdAt ?? now}, ${now})
		ON CONFLICT(tenant_id, key) DO UPDATE SET
			scope_entity_id = excluded.scope_entity_id,
			title = excluded.title,
			summary = excluded.summary,
			updated_at = excluded.updated_at`);

	return getContextDetails(db, { scopeRef: input.scopeRef });
}

export function defineContextTerm(
	db: SqliteExecutor,
	input: { scopeRef?: string; term: string; definition: string; avoid?: string[] }
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

	db.drizzle.run(sql`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
		VALUES (${db.tenantId}, ${scope.key}, ${term}, ${definition}, ${JSON.stringify(normalizedAvoid)}, ${existing?.createdAt ?? now}, ${now})
		ON CONFLICT(tenant_id, context_key, term) DO UPDATE SET
			definition = excluded.definition,
			avoid_terms = excluded.avoid_terms,
			updated_at = excluded.updated_at`);

	const storedTerm = getContextTerm(db, scope.key, term);
	if (!storedTerm) {
		throw new Error(`Failed to persist context term: ${term}`);
	}

	return {
		context: getContextDetails(db, { scopeRef: input.scopeRef }).context,
		term: storedTerm,
		created: existing === null
	};
}

export function forgetContextTerm(db: SqliteExecutor, input: { scopeRef?: string; term: string }): ForgetContextTermResult {
	const term = input.term.trim();
	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	const scope = resolveContextScope(db, input.scopeRef);

	const result = db.drizzle.run(
		sql`DELETE FROM context_terms WHERE tenant_id = ${db.tenantId} AND context_key = ${scope.key} AND term = ${term}`
	);

	return {
		context: getContextDetails(db, { scopeRef: input.scopeRef }).context,
		term,
		removed: result.changes > 0
	};
}

// The read half of synchronize's context sync (ISS62/ADR16): every context
// row this tenant has, for a last-writer-wins merge keyed on `key` and
// driven by `updatedAt` (see synchronize.ts's `unionByLastWriter`). Unlike
// relations/handoffs, a context's title/summary are actively re-edited over
// its lifetime via `upsertContext`, so a plain "insert what's missing"
// union would stop propagating edits made after a context's first sync;
// comparing `updatedAt` keeps both sides converging on whichever side has
// the more recent edit instead.
export function listAllContexts(db: SqliteExecutor): ContextSyncRecord[] {
	const rows = db.drizzle.all(sql`SELECT * FROM contexts WHERE tenant_id = ${db.tenantId}`) as ContextRow[];
	return rows.map((row) => ({
		key: row.key,
		scopeEntityId: row.scope_entity_id,
		title: row.title,
		summary: row.summary,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	}));
}

// The write half: upserts the already-resolved (last-writer-wins) set of
// contexts by their primary key (tenantId, key), only overwriting a row
// that already exists here if the incoming one is strictly newer - the
// resolved set can include this side's own current row unchanged, and
// re-applying it must be a no-op. Must run after `applyResolvedFacts` in
// synchronize's orchestration, so an initiative-scoped context's
// `scope_entity_id` FK target already exists as an entity on this side.
export function applyContexts(db: SqliteExecutor, contexts: ContextSyncRecord[]): { applied: number } {
	let applied = 0;
	for (const context of contexts) {
		const result = db.drizzle.run(sql`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
			VALUES (${db.tenantId}, ${context.key}, ${context.scopeEntityId}, ${context.title}, ${context.summary}, ${context.createdAt}, ${context.updatedAt})
			ON CONFLICT(tenant_id, key) DO UPDATE SET
				scope_entity_id = excluded.scope_entity_id,
				title = excluded.title,
				summary = excluded.summary,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at > contexts.updated_at`);
		applied += result.changes;
	}

	return { applied };
}

// The read half for context terms (ISS62/ADR16), same last-writer-wins
// merge rationale as `listAllContexts`: term definitions are actively
// re-edited via `defineContextTerm`.
export function listAllContextTerms(db: SqliteExecutor): ContextTermSyncRecord[] {
	const rows = db.drizzle.all(sql`SELECT * FROM context_terms WHERE tenant_id = ${db.tenantId}`) as ContextTermSyncRow[];
	return rows.map((row) => ({
		contextKey: row.context_key,
		term: row.term,
		definition: row.definition,
		avoid: parseAvoidTerms(row.avoid_terms),
		createdAt: row.created_at,
		updatedAt: row.updated_at
	}));
}

// The write half: upserts by primary key (tenantId, contextKey, term), only
// overwriting an existing row if the incoming one is strictly newer. Must
// run after `applyContexts` in synchronize's orchestration, so each term's
// `context_key` FK target already exists as a context on this side.
export function applyContextTerms(db: SqliteExecutor, terms: ContextTermSyncRecord[]): { applied: number } {
	let applied = 0;
	for (const term of terms) {
		const result = db.drizzle.run(sql`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
			VALUES (${db.tenantId}, ${term.contextKey}, ${term.term}, ${term.definition}, ${JSON.stringify(term.avoid)}, ${term.createdAt}, ${term.updatedAt})
			ON CONFLICT(tenant_id, context_key, term) DO UPDATE SET
				definition = excluded.definition,
				avoid_terms = excluded.avoid_terms,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at > context_terms.updated_at`);
		applied += result.changes;
	}

	return { applied };
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
	db.drizzle.run(sql`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
		VALUES (${db.tenantId}, ${scope.key}, ${scope.scopeEntityId}, ${scope.defaultTitle}, ${scope.defaultSummary}, ${now}, ${now})`);

	return scope;
}

function getContextTerm(db: SqliteExecutor, contextKey: string, term: string): ContextTermRecord | null {
	const row = db.drizzle.all(sql`SELECT term, definition, avoid_terms, created_at, updated_at
		FROM context_terms
		WHERE tenant_id = ${db.tenantId} AND context_key = ${contextKey} AND term = ${term}`)[0] as ContextTermRow | undefined;

	return row ? mapContextTermRow(row) : null;
}

function createContextRecord(scope: ResolvedContextScope): ContextRecord {
	return {
		key: scope.key,
		scopeKind: scope.scopeKind,
		scopeEntityId: scope.scopeEntityId,
		scopeLabel: scope.scopeLabel,
		title: scope.defaultTitle,
		summary: scope.defaultSummary,
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
		sql`SELECT COUNT(*) as count FROM context_terms WHERE tenant_id = ${db.tenantId} AND context_key = ${contextKey}`
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
				AND relations.type IN ('owns', 'records', 'tracks', 'creates')
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