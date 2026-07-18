import {
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	DEFAULT_EPIC_TITLE,
	filterContextDirectory,
	mergeContextDirectory,
	type ContextDetails,
	type ContextDirectory,
	type ContextListResult,
	type ContextRecord,
	type ContextSyncRecord,
	type ContextTermRecord,
	type ContextTermSyncRecord,
	type DefineContextTermResult,
	type EntityRecord,
	type ForgetContextTermResult,
	type QueryContextDirectoryInput,
	type QueryContextDirectoryResult
} from "@agent-issues/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { TenantExecutor as PoolClient } from "../../db/connection.js";
import { contextTerms, contexts, entities, relations } from "../../schema.js";

import {
	ensurePgTenant,
	getEntityOrThrow,
	mapEntityRow,
	nextEntityId,
	type EntityRow
} from "../entity-store/pg-entity-store.js";

export type ContextRow = {
	key: string;
	scope_entity_id: string | null;
	title: string;
	summary: string;
	created_at: string;
	updated_at: string;
};

export type ContextTermRow = {
	term: string;
	definition: string;
	avoid_terms: string;
	created_at: string;
	updated_at: string;
};

// Mirrors context-store.ts's private ResolvedContextScope: the "default" vs.
// "initiative" scope a context key resolves to, plus the default
// title/summary to synthesize when no row has been saved yet.
type ResolvedContextScope = {
	key: string;
	scopeKind: "default" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	defaultTitle: string;
	defaultSummary: string;
};

function getDefaultContextScope(): ResolvedContextScope {
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
 * A specific project's own shared/default context scope (ISS183, mirroring
 * core's `context-store.ts` `createProjectScope`). Keyed `default:<projectId>`
 * so this lines up with the exact same key shape local `SqliteStore` uses for
 * a non-sentinel project's default context.
 */
function createProjectScope(project: EntityRecord): ResolvedContextScope {
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
 * Finds the `project` entity this tenant already minted for a given
 * client-resolved `projectIdentity` (matched by title, the same field
 * local's one-time consolidation migration wrote the identity into), or
 * mints one plus its own epic (ADR7's full-chain invariant) the first time
 * a request for that identity arrives - mirroring `ensurePgTenant`'s own
 * project+epic+contains seeding, just per-identity instead of once per
 * tenant.
 */
async function getOrCreateProjectByIdentity(client: PoolClient, tenantId: string, projectIdentity: string): Promise<EntityRecord> {
	// Bootstraps the tenant's counters/sentinels (idempotent) so a project-scoped
	// request can arrive before any entity has ever been created for this tenant.
	await ensurePgTenant(client, tenantId);

	const [existingRow] = await client
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, tenantId), eq(entities.kind, "project"), eq(entities.title, projectIdentity)))
		.limit(1);
	if (existingRow) {
		return {
			id: existingRow.id,
			kind: "project",
			title: existingRow.title,
			status: existingRow.status,
			body: existingRow.body,
			bodySource: existingRow.bodySource === "generated" ? "generated" : "authored",
			createdAt: existingRow.createdAt,
			updatedAt: existingRow.updatedAt
		};
	}

	const now = new Date().toISOString();
	const projectId = await nextEntityId(client, tenantId, "project");
	const epicId = await nextEntityId(client, tenantId, "epic");

	await client.insert(entities).values({
		tenantId,
		id: projectId,
		kind: "project",
		title: projectIdentity,
		status: "active",
		body: "",
		bodySource: "generated",
		createdAt: now,
		updatedAt: now
	});
	await client.insert(entities).values({
		tenantId,
		id: epicId,
		kind: "epic",
		title: DEFAULT_EPIC_TITLE,
		status: "active",
		body: "",
		bodySource: "generated",
		createdAt: now,
		updatedAt: now
	});
	await client.insert(relations).values({ tenantId, fromId: projectId, toId: epicId, type: "contains", createdAt: now });

	return {
		id: projectId,
		kind: "project",
		title: projectIdentity,
		status: "active",
		body: "",
		bodySource: "generated",
		createdAt: now,
		updatedAt: now
	};
}

/**
 * Bare (no `--scope`) context resolution (ISS183, mirroring core's
 * project-aware `getDefaultContextScope` from ISS166): resolves to the
 * CURRENT project's own shared glossary when a `projectIdentity` is known
 * for this request, instead of the one tenant-wide sentinel every project
 * in a multi-project tenant would otherwise collide on. Undefined
 * `projectIdentity` (no header sent) keeps today's sentinel-only behavior.
 */
async function resolveDefaultContextScope(client: PoolClient, tenantId: string, projectIdentity: string | undefined): Promise<ResolvedContextScope> {
	if (!projectIdentity) {
		return getDefaultContextScope();
	}

	const project = await getOrCreateProjectByIdentity(client, tenantId, projectIdentity);
	return createProjectScope(project);
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

// Walks owns/records/tracks/creates relations (deliberately narrower than
// isStructuralRelationType's full set, matching context-store.ts) from
// `entityId` up to its owning initiative.
async function getOwningInitiativeOrThrow(client: PoolClient, tenantId: string, entityId: string): Promise<EntityRecord> {
	let currentId = entityId;
	const seen = new Set<string>([entityId]);

	while (true) {
		const result = await client.execute(sql`
			SELECT entities.*
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			WHERE relations.tenant_id = ${tenantId}
				AND relations.to_id = ${currentId}
				AND relations.type IN ('owns', 'records', 'tracks', 'creates')
			ORDER BY entities.id
		`);
		const rows = result.rows as EntityRow[];

		if (rows.length === 0) {
			throw new Error(`No owning initiative found for ${entityId}.`);
		}

		if (rows.length > 1) {
			throw new Error(`Cannot resolve owning initiative for ${entityId} because ${currentId} has multiple structural parents.`);
		}

		const parent = mapEntityRow(rows[0]!);
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

async function resolveContextScope(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	scopeRef?: string
): Promise<ResolvedContextScope> {
	if (!scopeRef || scopeRef === DEFAULT_CONTEXT_KEY) {
		return resolveDefaultContextScope(client, tenantId, projectIdentity);
	}

	const entity = await getEntityOrThrow(client, tenantId, scopeRef);
	if (entity.kind === "initiative") {
		return createInitiativeScope(entity);
	}

	const initiative = await getOwningInitiativeOrThrow(client, tenantId, entity.id);
	return createInitiativeScope(initiative);
}

async function fetchContextRow(client: PoolClient, tenantId: string, key: string): Promise<ContextRow | undefined> {
	const [row] = await client
		.select()
		.from(contexts)
		.where(and(eq(contexts.tenantId, tenantId), eq(contexts.key, key)))
		.limit(1);
	return row && {
		key: row.key,
		scope_entity_id: row.scopeEntityId,
		title: row.title,
		summary: row.summary,
		created_at: row.createdAt,
		updated_at: row.updatedAt
	};
}

async function fetchContextTermRows(client: PoolClient, tenantId: string, key: string): Promise<ContextTermRow[]> {
	const rows = await client
		.select()
		.from(contextTerms)
		.where(and(eq(contextTerms.tenantId, tenantId), eq(contextTerms.contextKey, key)))
		.orderBy(sql`lower(${contextTerms.term})`, asc(contextTerms.term));
	return rows.map((row) => ({
		term: row.term,
		definition: row.definition,
		avoid_terms: row.avoidTerms,
		created_at: row.createdAt,
		updated_at: row.updatedAt
	}));
}

async function queryContextDetails(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	scopeRef?: string
): Promise<ContextDetails> {
	const scope = await resolveContextScope(client, tenantId, projectIdentity, scopeRef);
	const row = await fetchContextRow(client, tenantId, scope.key);
	const termRows = row ? await fetchContextTermRows(client, tenantId, scope.key) : [];

	return {
		context: row ? mapContextRow(row, scope) : createContextRecord(scope),
		terms: termRows.map(mapContextTermRow)
	};
}

export async function queryProjectContextDetails(
	client: PoolClient,
	tenantId: string,
	project: EntityRecord,
	scopeRef?: string
): Promise<ContextDetails> {
	const scope = scopeRef ? await resolveContextScope(client, tenantId, undefined, scopeRef) : createProjectScope(project);
	const row = await fetchContextRow(client, tenantId, scope.key);
	const termRows = row ? await fetchContextTermRows(client, tenantId, scope.key) : [];

	return {
		context: row ? mapContextRow(row, scope) : createContextRecord(scope),
		terms: termRows.map(mapContextTermRow)
	};
}

async function queryContextTermCount(client: PoolClient, tenantId: string, contextKey: string): Promise<number> {
	const [result] = await client
		.select({ count: sql<number>`count(*)` })
		.from(contextTerms)
		.where(and(eq(contextTerms.tenantId, tenantId), eq(contextTerms.contextKey, contextKey)));
	return Number(result?.count ?? 0);
}

async function queryListContexts(client: PoolClient, tenantId: string, projectIdentity: string | undefined): Promise<ContextListResult> {
	const defaultScope = await resolveDefaultContextScope(client, tenantId, projectIdentity);
	const defaultRow = await fetchContextRow(client, tenantId, defaultScope.key);
	const contexts = [
		{
			context: defaultRow ? mapContextRow(defaultRow, defaultScope) : createContextRecord(defaultScope),
			termCount: await queryContextTermCount(client, tenantId, defaultScope.key)
		}
	];

	const initiativeRows = await client
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, tenantId), eq(entities.kind, "initiative")))
		.orderBy(asc(entities.id));

	for (const initiativeRow of initiativeRows) {
		const initiative = {
			id: initiativeRow.id,
			kind: "initiative" as const,
			title: initiativeRow.title,
			status: initiativeRow.status,
			body: initiativeRow.body,
			bodySource: initiativeRow.bodySource === "generated" ? ("generated" as const) : ("authored" as const),
			createdAt: initiativeRow.createdAt,
			updatedAt: initiativeRow.updatedAt
		};
		const scope = createInitiativeScope(initiative);
		const row = await fetchContextRow(client, tenantId, scope.key);
		contexts.push({
			context: row ? mapContextRow(row, scope) : createContextRecord(scope),
			termCount: await queryContextTermCount(client, tenantId, scope.key)
		});
	}

	return { contexts };
}

async function buildContextDirectory(client: PoolClient, tenantId: string, projectIdentity: string | undefined): Promise<ContextDirectory> {
	const shared = await queryContextDetails(client, tenantId, projectIdentity);
	const initiativeRows = await client
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.tenantId, tenantId), eq(entities.kind, "initiative")))
		.orderBy(asc(entities.id));
	const initiatives = await Promise.all(initiativeRows.map((row) => queryContextDetails(client, tenantId, projectIdentity, row.id)));

	return mergeContextDirectory(shared, initiatives);
}

async function ensureContextExists(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	scopeRef?: string
): Promise<ResolvedContextScope> {
	const scope = await resolveContextScope(client, tenantId, projectIdentity, scopeRef);
	const existing = await fetchContextRow(client, tenantId, scope.key);
	if (existing) {
		return scope;
	}

	const now = new Date().toISOString();
	await client.insert(contexts).values({
		tenantId,
		key: scope.key,
		scopeEntityId: scope.scopeEntityId,
		title: scope.defaultTitle,
		summary: scope.defaultSummary,
		createdAt: now,
		updatedAt: now
	});

	return scope;
}

async function getContextTermRecord(client: PoolClient, tenantId: string, contextKey: string, term: string): Promise<ContextTermRecord | null> {
	const [row] = await client
		.select()
		.from(contextTerms)
		.where(and(eq(contextTerms.tenantId, tenantId), eq(contextTerms.contextKey, contextKey), eq(contextTerms.term, term)))
		.limit(1);
	return row
		? mapContextTermRow({
			term: row.term,
			definition: row.definition,
			avoid_terms: row.avoidTerms,
			created_at: row.createdAt,
			updated_at: row.updatedAt
		})
		: null;
}

/**
 * Naming note: this exported function matches `PgStore.getContextDetails`'s
 * method signature exactly (object-shaped `input`), while `queryContextDetails`
 * (exported below) is the internal-shaped helper every other method here
 * (and `getDatabaseSnapshot` in the entity-store feature) calls directly
 * with a raw `scopeRef`.
 */
export async function getContextDetails(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input?: { scopeRef?: string }
): Promise<ContextDetails> {
	return queryContextDetails(client, tenantId, projectIdentity, input?.scopeRef);
}

export { queryContextDetails };

export async function listContexts(client: PoolClient, tenantId: string, projectIdentity: string | undefined): Promise<ContextListResult> {
	return queryListContexts(client, tenantId, projectIdentity);
}

export async function getContextDirectory(client: PoolClient, tenantId: string, projectIdentity: string | undefined): Promise<ContextDirectory> {
	return buildContextDirectory(client, tenantId, projectIdentity);
}

export async function queryContextDirectory(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: QueryContextDirectoryInput = {}
): Promise<QueryContextDirectoryResult> {
	const directory = await buildContextDirectory(client, tenantId, projectIdentity);
	return filterContextDirectory(directory, input);
}

export async function upsertContext(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; title: string; summary: string }
): Promise<ContextDetails> {
	const title = input.title.trim();
	const summary = input.summary.trim();

	if (title.length === 0) {
		throw new Error("Context title must not be empty.");
	}

	if (summary.length === 0) {
		throw new Error("Context summary must not be empty.");
	}

	const scope = await resolveContextScope(client, tenantId, projectIdentity, input.scopeRef);
	const existing = await queryContextDetails(client, tenantId, projectIdentity, input.scopeRef);
	const now = new Date().toISOString();

	await client
		.insert(contexts)
		.values({
			tenantId,
			key: scope.key,
			scopeEntityId: scope.scopeEntityId,
			title,
			summary,
			createdAt: existing.context.createdAt ?? now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: [contexts.tenantId, contexts.key],
			set: { scopeEntityId: scope.scopeEntityId, title, summary, updatedAt: now }
		});

	return queryContextDetails(client, tenantId, projectIdentity, input.scopeRef);
}

export async function defineContextTerm(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string; definition: string; avoid?: string[] }
): Promise<DefineContextTermResult> {
	const term = input.term.trim();
	const definition = input.definition.trim();

	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	if (definition.length === 0) {
		throw new Error("Context term definition must not be empty.");
	}

	const scope = await ensureContextExists(client, tenantId, projectIdentity, input.scopeRef);
	const normalizedAvoid = normalizeAvoidTerms(input.avoid ?? [], term);
	const existing = await getContextTermRecord(client, tenantId, scope.key, term);
	const now = new Date().toISOString();

	await client
		.insert(contextTerms)
		.values({
			tenantId,
			contextKey: scope.key,
			term,
			definition,
			avoidTerms: JSON.stringify(normalizedAvoid),
			createdAt: existing?.createdAt ?? now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: [contextTerms.tenantId, contextTerms.contextKey, contextTerms.term],
			set: { definition, avoidTerms: JSON.stringify(normalizedAvoid), updatedAt: now }
		});

	const storedTerm = await getContextTermRecord(client, tenantId, scope.key, term);
	if (!storedTerm) {
		throw new Error(`Failed to persist context term: ${term}`);
	}

	return {
		context: (await queryContextDetails(client, tenantId, projectIdentity, input.scopeRef)).context,
		term: storedTerm,
		created: existing === null
	};
}

export async function forgetContextTerm(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string }
): Promise<ForgetContextTermResult> {
	const term = input.term.trim();
	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	const scope = await resolveContextScope(client, tenantId, projectIdentity, input.scopeRef);
	const result = await client
		.delete(contextTerms)
		.where(and(eq(contextTerms.tenantId, tenantId), eq(contextTerms.contextKey, scope.key), eq(contextTerms.term, term)))
		.returning({ term: contextTerms.term });

	return {
		context: (await queryContextDetails(client, tenantId, projectIdentity, input.scopeRef)).context,
		term,
		removed: result.length > 0
	};
}

// The read half of synchronize's context sync (ISS62/ADR16): every context
// row this tenant has, for a last-writer-wins merge keyed on `key` and
// driven by `updatedAt` - see core's identical SQLite-side `listAllContexts`
// for the rationale (contexts are actively re-edited via `upsertContext`,
// unlike relations/handoffs).
export async function listAllContexts(client: PoolClient, tenantId: string): Promise<ContextSyncRecord[]> {
	const result = await client.execute(sql`SELECT * FROM contexts WHERE tenant_id = ${tenantId}`);
	return (result.rows as ContextRow[]).map((row) => ({
		key: row.key,
		scopeEntityId: row.scope_entity_id,
		title: row.title,
		summary: row.summary,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	}));
}

// The write half: upserts the already-resolved (last-writer-wins) set of
// contexts by their primary key (tenant_id, key), only overwriting a row
// that already exists here if the incoming one is strictly newer. Must run
// after `applyResolvedFacts` in synchronize's orchestration, so an
// initiative-scoped context's `scope_entity_id` FK target already exists as
// an entity on this side.
export async function applyContexts(client: PoolClient, tenantId: string, contexts: ContextSyncRecord[]): Promise<{ applied: number }> {
	let applied = 0;
	for (const context of contexts) {
		const result = await client.execute(sql`
			INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
			VALUES (${tenantId}, ${context.key}, ${context.scopeEntityId}, ${context.title}, ${context.summary}, ${context.createdAt}, ${context.updatedAt})
			ON CONFLICT (tenant_id, key) DO UPDATE SET
				scope_entity_id = excluded.scope_entity_id,
				title = excluded.title,
				summary = excluded.summary,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at > contexts.updated_at
		`);
		applied += result.rowCount ?? 0;
	}
	return { applied };
}

// The read half for context terms (ISS62/ADR16), same last-writer-wins merge
// rationale as `listAllContexts`.
export async function listAllContextTerms(client: PoolClient, tenantId: string): Promise<ContextTermSyncRecord[]> {
	const result = await client.execute(sql`SELECT * FROM context_terms WHERE tenant_id = ${tenantId}`);
	return (result.rows as Array<ContextTermRow & { context_key: string }>).map((row) => ({
		contextKey: row.context_key,
		term: row.term,
		definition: row.definition,
		avoid: parseAvoidTerms(row.avoid_terms),
		createdAt: row.created_at,
		updatedAt: row.updated_at
	}));
}

// The write half: upserts by primary key (tenant_id, context_key, term),
// only overwriting an existing row if the incoming one is strictly newer.
// Must run after `applyContexts` in synchronize's orchestration, so each
// term's `context_key` FK target already exists as a context on this side.
export async function applyContextTerms(client: PoolClient, tenantId: string, terms: ContextTermSyncRecord[]): Promise<{ applied: number }> {
	let applied = 0;
	for (const term of terms) {
		const result = await client.execute(sql`
			INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
			VALUES (${tenantId}, ${term.contextKey}, ${term.term}, ${term.definition}, ${JSON.stringify(term.avoid)}, ${term.createdAt}, ${term.updatedAt})
			ON CONFLICT (tenant_id, context_key, term) DO UPDATE SET
				definition = excluded.definition,
				avoid_terms = excluded.avoid_terms,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at > context_terms.updated_at
		`);
		applied += result.rowCount ?? 0;
	}
	return { applied };
}
