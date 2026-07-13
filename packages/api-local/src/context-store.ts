import Fuse from "fuse.js";

import {
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	DEFAULT_PROJECT_ID,
	isEntityKind,
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
import type { DatabaseHandle } from "./database.js";

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

export function listContexts(db: DatabaseHandle): ContextListResult {
	const rows = db.prepare(`SELECT * FROM contexts WHERE tenant_id = ? ORDER BY key`).all(db.tenantId) as ContextRow[];
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

	const initiativeRows = db
		.prepare(`SELECT * FROM entities WHERE tenant_id = ? AND kind = 'initiative' ORDER BY id`)
		.all(db.tenantId) as EntityRow[];

	for (const initiativeRow of initiativeRows) {
		const initiative = mapEntityRow(initiativeRow);
		const scope = createInitiativeScope(initiative);
		const row = rowByScopeEntityId.get(initiative.id);
		contexts.push(createContextListItem(scope, row, getContextTermCount(db, row?.key ?? initiative.id)));
	}

	return { contexts };
}

export function getContextDetails(db: DatabaseHandle, input?: { scopeRef?: string }): ContextDetails {
	const scope = resolveContextScope(db, input?.scopeRef);
	const contextRow = db.prepare(`SELECT * FROM contexts WHERE tenant_id = ? AND key = ?`).get(db.tenantId, scope.key) as ContextRow | undefined;
	const termRows = contextRow
		? (db
				.prepare(
					`SELECT term, definition, avoid_terms, created_at, updated_at
					 FROM context_terms
					 WHERE tenant_id = ?
					   AND context_key = ?
					 ORDER BY lower(term), term`
				)
				.all(db.tenantId, scope.key) as ContextTermRow[])
		: [];

	return {
		context: contextRow ? mapContextRow(contextRow, scope) : createContextRecord(scope),
		terms: termRows.map(mapContextTermRow)
	};
}

export function getContextDirectory(db: DatabaseHandle): ContextDirectory {
	const shared = getContextDetails(db);
	const initiativeRows = db
		.prepare(`SELECT * FROM entities WHERE tenant_id = ? AND kind = 'initiative' ORDER BY id`)
		.all(db.tenantId) as EntityRow[];
	const initiatives = initiativeRows.map((row) => getContextDetails(db, { scopeRef: row.id }));
	const termsByKey = new Map<string, ContextDirectoryTerm>();

	for (const details of [shared, ...initiatives]) {
		for (const term of details.terms) {
			const key = term.term.toLowerCase();
			const existing = termsByKey.get(key);
			const source: ContextDirectoryTermSource = {
				avoid: [...term.avoid],
				contextKey: details.context.key,
				contextTitle: details.context.title,
				definition: term.definition,
				scopeEntityId: details.context.scopeEntityId,
				scopeKind: details.context.scopeKind,
				scopeLabel: details.context.scopeLabel,
				updatedAt: term.updatedAt
			};

			if (!existing) {
				termsByKey.set(key, {
					term: term.term,
					sources: [source],
					hasSharedSource: details.context.scopeKind === "default",
					hasDuplicates: false,
					hasConflictingDefinitions: false
				});
				continue;
			}

			existing.sources.push(source);
			existing.hasDuplicates = existing.sources.length > 1;
			existing.hasSharedSource = existing.hasSharedSource || details.context.scopeKind === "default";
			existing.hasConflictingDefinitions = hasConflictingDefinitions(existing.sources);
			if (term.term.localeCompare(existing.term) < 0) {
				existing.term = term.term;
			}
		}
	}

	const terms = [...termsByKey.values()]
		.map((entry) => ({
			...entry,
			sources: entry.sources.sort(compareContextDirectorySources)
		}))
		.sort((left, right) => left.term.localeCompare(right.term));

	return {
		shared,
		initiatives,
		terms,
		duplicateTerms: terms.filter((entry) => entry.hasDuplicates).map((entry) => entry.term)
	};
}

export function queryContextDirectory(db: DatabaseHandle, input: QueryContextDirectoryInput = {}): QueryContextDirectoryResult {
	const directory = getContextDirectory(db);
	const view = input.view ?? "all";
	const query = input.query?.trim() ?? "";
	const conflictsOnly = input.conflictsOnly ?? false;
	const normalizedQuery = query.toLowerCase();
	const shared = view === "initiatives" ? null : filterContextDetails(directory.shared, normalizedQuery);
	const initiatives = view === "global"
		? []
		: directory.initiatives
				.map((details) => filterContextDetails(details, normalizedQuery))
				.filter((details): details is ContextDetails => details !== null);
		let terms = directory.terms
			.map((entry) => filterContextDirectoryTerm(entry, normalizedQuery, view))
			.filter((entry): entry is ContextDirectoryTerm => entry !== null);

	if (conflictsOnly) {
		terms = terms.filter((entry) => entry.hasDuplicates);
	}

	return {
		shared,
		initiatives,
		terms,
		duplicateTerms: terms.filter((entry) => entry.hasDuplicates).map((entry) => entry.term),
		query,
		view,
		conflictsOnly
	};
}

export function upsertContext(db: DatabaseHandle, input: { scopeRef?: string; title: string; summary: string }): ContextDetails {
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

	db.prepare(
		`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
		 VALUES (@tenantId, @key, @scopeEntityId, @title, @summary, @createdAt, @updatedAt)
		 ON CONFLICT(tenant_id, key) DO UPDATE SET
		 	scope_entity_id = excluded.scope_entity_id,
		 	title = excluded.title,
		 	summary = excluded.summary,
		 	updated_at = excluded.updated_at`
	).run(tenantParams(db, {
		key: scope.key,
		scopeEntityId: scope.scopeEntityId,
		title,
		summary,
		createdAt: existing.createdAt ?? now,
		updatedAt: now
	}));

	return getContextDetails(db, { scopeRef: input.scopeRef });
}

export function defineContextTerm(
	db: DatabaseHandle,
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

	db.prepare(
		`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
		 VALUES (@tenantId, @contextKey, @term, @definition, @avoidTerms, @createdAt, @updatedAt)
		 ON CONFLICT(tenant_id, context_key, term) DO UPDATE SET
		 	definition = excluded.definition,
		 	avoid_terms = excluded.avoid_terms,
		 	updated_at = excluded.updated_at`
	).run(tenantParams(db, {
		contextKey: scope.key,
		term,
		definition,
		avoidTerms: JSON.stringify(normalizedAvoid),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	}));

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

export function forgetContextTerm(db: DatabaseHandle, input: { scopeRef?: string; term: string }): ForgetContextTermResult {
	const term = input.term.trim();
	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	const scope = resolveContextScope(db, input.scopeRef);

	const result = db.prepare(`DELETE FROM context_terms WHERE tenant_id = ? AND context_key = ? AND term = ?`).run(db.tenantId, scope.key, term);

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
export function listAllContexts(db: DatabaseHandle): ContextSyncRecord[] {
	const rows = db.prepare(`SELECT * FROM contexts WHERE tenant_id = ?`).all(db.tenantId) as ContextRow[];
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
export function applyContexts(db: DatabaseHandle, contexts: ContextSyncRecord[]): { applied: number } {
	let applied = 0;
	for (const context of contexts) {
		const result = db
			.prepare(
				`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
				 VALUES (@tenantId, @key, @scopeEntityId, @title, @summary, @createdAt, @updatedAt)
				 ON CONFLICT(tenant_id, key) DO UPDATE SET
				   scope_entity_id = excluded.scope_entity_id,
				   title = excluded.title,
				   summary = excluded.summary,
				   updated_at = excluded.updated_at
				 WHERE excluded.updated_at > contexts.updated_at`
			)
			.run(tenantParams(db, context));
		applied += result.changes;
	}

	return { applied };
}

// The read half for context terms (ISS62/ADR16), same last-writer-wins
// merge rationale as `listAllContexts`: term definitions are actively
// re-edited via `defineContextTerm`.
export function listAllContextTerms(db: DatabaseHandle): ContextTermSyncRecord[] {
	const rows = db.prepare(`SELECT * FROM context_terms WHERE tenant_id = ?`).all(db.tenantId) as ContextTermSyncRow[];
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
export function applyContextTerms(db: DatabaseHandle, terms: ContextTermSyncRecord[]): { applied: number } {
	let applied = 0;
	for (const term of terms) {
		const result = db
			.prepare(
				`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
				 VALUES (@tenantId, @contextKey, @term, @definition, @avoidTerms, @createdAt, @updatedAt)
				 ON CONFLICT(tenant_id, context_key, term) DO UPDATE SET
				   definition = excluded.definition,
				   avoid_terms = excluded.avoid_terms,
				   updated_at = excluded.updated_at
				 WHERE excluded.updated_at > context_terms.updated_at`
			)
			.run(tenantParams(db, {
				contextKey: term.contextKey,
				term: term.term,
				definition: term.definition,
				avoidTerms: JSON.stringify(term.avoid),
				createdAt: term.createdAt,
				updatedAt: term.updatedAt
			}));
		applied += result.changes;
	}

	return { applied };
}

function ensureContextExists(db: DatabaseHandle, scopeRef?: string): ResolvedContextScope {
	const scope = resolveContextScope(db, scopeRef);
	const existing = db.prepare(`SELECT key FROM contexts WHERE tenant_id = ? AND key = ?`).get(db.tenantId, scope.key) as { key: string } | undefined;
	if (existing) {
		return scope;
	}

	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(db.tenantId, scope.key, scope.scopeEntityId, scope.defaultTitle, scope.defaultSummary, now, now);

	return scope;
}

function getContextTerm(db: DatabaseHandle, contextKey: string, term: string): ContextTermRecord | null {
	const row = db
		.prepare(
			`SELECT term, definition, avoid_terms, created_at, updated_at
			 FROM context_terms
			 WHERE tenant_id = ? AND context_key = ? AND term = ?`
		)
		.get(db.tenantId, contextKey, term) as ContextTermRow | undefined;

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

function filterContextDetails(details: ContextDetails, normalizedQuery: string): ContextDetails | null {
	if (normalizedQuery.length === 0) {
		return details;
	}

	const contextMatches = matchesContextQuery(
		[details.context.key, details.context.scopeLabel, details.context.summary, details.context.title].join(" "),
		normalizedQuery
	);
	const terms = details.terms.filter((term) =>
		matchesContextQuery([term.term, term.definition, ...term.avoid].join(" "), normalizedQuery)
	);

	if (!contextMatches && terms.length === 0) {
		return null;
	}

	return {
		context: {
			...details.context,
			summary: contextMatches ? details.context.summary : ""
		},
		terms
	};
}

function filterContextDirectoryTerm(
	entry: ContextDirectoryTerm,
	normalizedQuery: string,
	view: ContextDirectoryView
): ContextDirectoryTerm | null {
	const sources = entry.sources.filter((source) => {
		if (view === "global" && source.scopeKind !== "default") {
			return false;
		}

		if (view === "initiatives" && source.scopeKind === "default") {
			return false;
		}

		if (normalizedQuery.length === 0) {
			return true;
		}

		return matchesContextQuery(
			[entry.term, source.scopeLabel, source.contextTitle, source.definition, ...source.avoid].join(" "),
			normalizedQuery
		);
	});

	if (sources.length === 0) {
		return null;
	}

	return {
		term: entry.term,
		sources,
		hasSharedSource: sources.some((source) => source.scopeKind === "default"),
		hasDuplicates: sources.length > 1,
		hasConflictingDefinitions: hasConflictingDefinitions(sources)
	};
}

function hasConflictingDefinitions(sources: ContextDirectoryTermSource[]): boolean {
	const normalizedDefinitions = new Set(
		sources
			.map((source) => source.definition.trim().toLowerCase())
			.filter((definition) => definition.length > 0)
	);

	return normalizedDefinitions.size > 1;
}

function matchesContextQuery(text: string, normalizedQuery: string): boolean {
	const queryTokens = tokenizeContextSearch(normalizedQuery);

	if (queryTokens.length === 0) {
		return true;
	}

	const fuse = new Fuse([{ tokens: tokenizeContextSearch(text) }], {
		ignoreLocation: true,
		isCaseSensitive: false,
		keys: ["tokens"],
		threshold: 0,
		useExtendedSearch: true
	});

	return fuse.search(buildContextQuery(queryTokens)).length > 0;
}

function tokenizeContextSearch(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

function buildContextQuery(queryTokens: string[]): { $and: Array<{ tokens: string }> } | { tokens: string } {
	if (queryTokens.length === 1) {
		return { tokens: `^${queryTokens[0]}` };
	}

	return {
		$and: queryTokens.map((token) => ({ tokens: `^${token}` }))
	};
}

function compareContextDirectorySources(left: ContextDirectoryTermSource, right: ContextDirectoryTermSource): number {
	if (left.scopeKind !== right.scopeKind) {
		return left.scopeKind === "default" ? -1 : 1;
	}

	if (left.scopeLabel !== right.scopeLabel) {
		return left.scopeLabel.localeCompare(right.scopeLabel);
	}

	return left.contextKey.localeCompare(right.contextKey);
}

function resolveContextScope(db: DatabaseHandle, scopeRef?: string): ResolvedContextScope {
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
function getDefaultContextScope(db: DatabaseHandle): ResolvedContextScope {
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

function getContextTermCount(db: DatabaseHandle, contextKey: string): number {
	const row = db.prepare(`SELECT COUNT(*) as count FROM context_terms WHERE tenant_id = ? AND context_key = ?`).get(db.tenantId, contextKey) as { count: number };
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

function getEntityOrThrow(db: DatabaseHandle, entityId: string): EntityRecord {
	const row = db.prepare(`SELECT * FROM entities WHERE tenant_id = ? AND id = ?`).get(db.tenantId, entityId) as EntityRow | undefined;
	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return mapEntityRow(row);
}

function getOwningInitiativeOrThrow(db: DatabaseHandle, entityId: string): EntityRecord {
	let currentId = entityId;
	const seen = new Set<string>([entityId]);

	while (true) {
		const parents = db
			.prepare(
				`SELECT entities.*
				 FROM relations
				 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
				 WHERE relations.tenant_id = @tenantId
				   AND relations.to_id = @entityId
				   AND relations.type IN ('owns', 'records', 'tracks', 'creates')
				 ORDER BY entities.id`
			)
			.all(tenantParams(db, { entityId: currentId })) as EntityRow[];

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

function tenantParams<T extends Record<string, unknown>>(db: DatabaseHandle, values: T): T & { tenantId: string } {
	return {
		tenantId: db.tenantId,
		...values
	};
}