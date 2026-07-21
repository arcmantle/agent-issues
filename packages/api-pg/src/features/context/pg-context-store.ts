import {
	computeContextContentHash,
	computeContextTermContentHash,
	computeEntityContentHash,
	ContextConflictError,
	ContextRevisionError,
	ContextTermConflictError,
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	DEFAULT_EPIC_TITLE,
	filterContextDirectory,
	mergeContextDirectory,
	materializeContextFromPatches,
	materializeContextTermFromPatches,
	RESERVED_SYSTEM_AUTHOR,
	type ContextDetails,
	type ContextDirectory,
	type ContextListResult,
	type ContextRecord,
	type ContextTermRecord,
	type DefineContextTermResult,
	type EntityRecord,
	type ForgetContextTermResult,
	type MaterializedContextRevision,
	type MaterializedContextTermRevision,
	type QueryContextDirectoryInput,
	type QueryContextDirectoryResult
} from "@agent-issues/core";
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { TenantExecutor as PoolClient } from "../../db/connection.js";
import { contextDeltaEntries, contextTermDeltaEntries, contextTerms, contexts, entities, relations } from "../../schema.js";

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
	revision: number;
	content_hash: string;
	created_at: string;
	updated_at: string;
};

export type ContextTermRow = {
	term: string;
	definition: string;
	avoid_terms: string;
	revision: number;
	content_hash: string;
	tombstone: boolean;
	created_at: string;
	updated_at: string;
};

type ContextTermHead = ContextTermRecord & { tombstone: boolean };

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
	await ensurePgTenant(client, tenantId);

	const [existingRow] = await client
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, tenantId), eq(entities.kind, "project"), eq(entities.title, projectIdentity)))
		.limit(1);
	if (existingRow) {
		return mapEntityRow({
			id: existingRow.id,
			kind: existingRow.kind,
			title: existingRow.title,
			status: existingRow.status,
			body: existingRow.body,
			body_source: existingRow.bodySource,
			revision: existingRow.revision,
			content_hash: existingRow.contentHash,
			project_id: existingRow.projectId,
			created_at: existingRow.createdAt,
			updated_at: existingRow.updatedAt
		});
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
		revision: 1,
		contentHash: computeEntityContentHash(projectIdentity, ""),
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
		revision: 1,
		contentHash: computeEntityContentHash(DEFAULT_EPIC_TITLE, ""),
		createdAt: now,
		updatedAt: now
	});
	await client.insert(relations).values({ tenantId, fromId: projectId, toId: epicId, type: "contains", createdAt: now });

	return getEntityOrThrow(client, tenantId, projectId);
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

// Walks record-to-initiative structural relations from `entityId` up to its
// owning initiative.
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
				AND relations.type IN ('owns', 'records', 'tracks', 'creates', 'decomposes')
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
		revision: row.revision,
		content_hash: row.contentHash,
		created_at: row.createdAt,
		updated_at: row.updatedAt
	};
}

async function fetchContextTermRows(client: PoolClient, tenantId: string, key: string): Promise<ContextTermRow[]> {
	const rows = await client
		.select()
		.from(contextTerms)
		.where(and(eq(contextTerms.tenantId, tenantId), eq(contextTerms.contextKey, key), eq(contextTerms.tombstone, false)))
		.orderBy(sql`lower(${contextTerms.term})`, asc(contextTerms.term));
	return rows.map((row) => ({
		term: row.term,
		definition: row.definition,
		avoid_terms: row.avoidTerms,
		revision: row.revision,
		content_hash: row.contentHash,
		tombstone: row.tombstone,
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
		.where(and(eq(contextTerms.tenantId, tenantId), eq(contextTerms.contextKey, contextKey), eq(contextTerms.tombstone, false)));
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
			revision: initiativeRow.revision,
			contentHash: initiativeRow.contentHash,
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
	const contentHash = computeContextContentHash(scope.defaultTitle, scope.defaultSummary);
	await client.insert(contexts).values({
		tenantId,
		key: scope.key,
		scopeEntityId: scope.scopeEntityId,
		title: scope.defaultTitle,
		summary: scope.defaultSummary,
		revision: 1,
		contentHash,
		createdAt: now,
		updatedAt: now
	});
	await appendContextDeltaEntry(client, tenantId, scope.key, 1, scope.defaultTitle, scope.defaultSummary, undefined, now);

	return scope;
}

async function getContextTermRecord(client: PoolClient, tenantId: string, contextKey: string, term: string): Promise<ContextTermHead | null> {
	const [row] = await client
		.select()
		.from(contextTerms)
		.where(and(eq(contextTerms.tenantId, tenantId), eq(contextTerms.contextKey, contextKey), eq(contextTerms.term, term)))
		.limit(1);
	return row
		? {
			...mapContextTermRow({
			term: row.term,
			definition: row.definition,
			avoid_terms: row.avoidTerms,
			revision: row.revision,
			content_hash: row.contentHash,
			tombstone: row.tombstone,
			created_at: row.createdAt,
			updated_at: row.updatedAt
			}),
			tombstone: row.tombstone
		}
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
	input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }
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
	const existingDetails = await queryContextDetails(client, tenantId, projectIdentity, input.scopeRef);
	const existing = existingDetails.context;
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

		const result = await client.execute(sql`
			UPDATE contexts
			SET title = ${title}, summary = ${summary},
			    revision = ${newRevision}, content_hash = ${newContentHash},
			    updated_at = ${now}
			WHERE tenant_id = ${tenantId}
			  AND key = ${scope.key}
			  AND revision = ${input.expectedRevision}
			  AND content_hash = ${input.expectedContentHash}
		`);

		if ((result.rowCount ?? 0) === 0) {
			const fresh = await fetchContextRow(client, tenantId, scope.key);
			if (!fresh) {
				throw new Error(`Context ${scope.key} disappeared during CAS update.`);
			}
			throw new ContextConflictError(scope.key, fresh.revision, fresh.content_hash);
		}

		await appendContextDeltaEntry(client, tenantId, scope.key, newRevision, existing.title, existing.summary, input.author, now);
	} else {
		await client.insert(contexts).values({
			tenantId,
			key: scope.key,
			scopeEntityId: scope.scopeEntityId,
			title,
			summary,
			revision: 1,
			contentHash: newContentHash,
			createdAt: now,
			updatedAt: now
		});
		await appendContextDeltaEntry(client, tenantId, scope.key, 1, title, summary, input.author, now);
	}

	return queryContextDetails(client, tenantId, projectIdentity, input.scopeRef);
}

async function appendContextDeltaEntry(
	client: PoolClient,
	tenantId: string,
	contextKey: string,
	revision: number,
	priorTitle: string,
	priorSummary: string,
	author: string | undefined,
	createdAt: string,
	restoredFromRevision?: number
): Promise<void> {
	const id = randomUUID();
	const authorValue = author?.trim() || RESERVED_SYSTEM_AUTHOR;
	await client.insert(contextDeltaEntries).values({
		id,
		tenantId,
		contextKey,
		revision,
		author: authorValue,
		priorTitle,
		priorSummary,
		restoredFromRevision: restoredFromRevision ?? null,
		createdAt
	});
}

export async function defineContextTerm(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }
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
	const contentHash = computeContextTermContentHash(definition, normalizedAvoid, false);

	if (existing) {
		assertContextTermHead(scope.key, term, existing, input.expectedRevision, input.expectedContentHash);
		const revision = existing.revision + 1;
		const result = await client.execute(sql`UPDATE context_terms SET definition = ${definition}, avoid_terms = ${JSON.stringify(normalizedAvoid)}, revision = ${revision}, content_hash = ${contentHash}, tombstone = FALSE, updated_at = ${now}
			WHERE tenant_id = ${tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
		if ((result.rowCount ?? 0) === 0) {
			const fresh = await getContextTermRecord(client, tenantId, scope.key, term);
			throw new ContextTermConflictError(scope.key, term, fresh!.revision, fresh!.contentHash);
		}
		await appendContextTermDeltaEntry(client, tenantId, scope.key, term, revision, existing, input.author, now);
	} else {
		await client.insert(contextTerms).values({
			tenantId,
			contextKey: scope.key,
			term,
			definition,
			avoidTerms: JSON.stringify(normalizedAvoid),
			revision: 1,
			contentHash,
			tombstone: false,
			createdAt: now,
			updatedAt: now
		});
		await appendContextTermDeltaEntry(client, tenantId, scope.key, term, 1, { term, definition, avoid: normalizedAvoid, revision: 1, contentHash, createdAt: now, updatedAt: now, tombstone: false }, input.author, now);
	}

	const storedTerm = await getContextTermRecord(client, tenantId, scope.key, term);
	if (!storedTerm) {
		throw new Error(`Failed to persist context term: ${term}`);
	}
	const { tombstone: _tombstone, ...publicTerm } = storedTerm;

	return {
		context: (await queryContextDetails(client, tenantId, projectIdentity, input.scopeRef)).context,
		term: publicTerm,
		created: existing === null
	};
}

export async function forgetContextTerm(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }
): Promise<ForgetContextTermResult> {
	const term = input.term.trim();
	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	const scope = await resolveContextScope(client, tenantId, projectIdentity, input.scopeRef);
	const existing = await getContextTermRecord(client, tenantId, scope.key, term);
	if (!existing) {
		return { context: (await queryContextDetails(client, tenantId, projectIdentity, input.scopeRef)).context, term, removed: false };
	}
	assertContextTermHead(scope.key, term, existing, input.expectedRevision, input.expectedContentHash);
	if (existing.tombstone) {
		return { context: (await queryContextDetails(client, tenantId, projectIdentity, input.scopeRef)).context, term, removed: false, currentRevision: existing.revision, currentContentHash: existing.contentHash };
	}
	const revision = existing.revision + 1;
	const contentHash = computeContextTermContentHash(existing.definition, existing.avoid, true);
	const now = new Date().toISOString();
	const result = await client.execute(sql`UPDATE context_terms SET revision = ${revision}, content_hash = ${contentHash}, tombstone = TRUE, updated_at = ${now}
		WHERE tenant_id = ${tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
	if ((result.rowCount ?? 0) === 0) {
		const fresh = await getContextTermRecord(client, tenantId, scope.key, term);
		throw new ContextTermConflictError(scope.key, term, fresh!.revision, fresh!.contentHash);
	}
	await appendContextTermDeltaEntry(client, tenantId, scope.key, term, revision, existing, input.author, now);

	return {
		context: (await queryContextDetails(client, tenantId, projectIdentity, input.scopeRef)).context,
		term,
		removed: true,
		currentRevision: revision,
		currentContentHash: contentHash
	};
}

export async function materializeContextRevision(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; revision: number }
): Promise<MaterializedContextRevision> {
	const scope = await resolveContextScope(client, tenantId, projectIdentity, input.scopeRef);
	const head = await fetchContextRow(client, tenantId, scope.key);
	if (!head) {
		throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
	}
	const rows = await client.select().from(contextDeltaEntries)
		.where(and(eq(contextDeltaEntries.tenantId, tenantId), eq(contextDeltaEntries.contextKey, scope.key)))
		.orderBy(desc(contextDeltaEntries.revision));
	return materializeContextFromPatches(
		{ key: head.key, title: head.title, summary: head.summary, revision: head.revision, createdAt: head.created_at },
		rows.map((row) => ({ revision: row.revision, author: row.author, createdAt: row.createdAt, priorTitle: row.priorTitle, priorSummary: row.priorSummary, ...(row.restoredFromRevision !== null && { restoredFromRevision: row.restoredFromRevision }) })),
		input.revision
	);
}

export async function restoreContextRevision(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }
): Promise<MaterializedContextRevision> {
	const scope = await resolveContextScope(client, tenantId, projectIdentity, input.scopeRef);
	const current = (await queryContextDetails(client, tenantId, projectIdentity, input.scopeRef)).context;
	if (!current.exists) {
		throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
	}
	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new ContextConflictError(scope.key, current.revision, current.contentHash);
	}
	const source = await materializeContextRevision(client, tenantId, projectIdentity, { scopeRef: input.scopeRef, revision: input.revision });
	const revision = current.revision + 1;
	const contentHash = computeContextContentHash(source.title, source.summary);
	const updatedAt = new Date().toISOString();
	const [updated] = await client.update(contexts).set({
		title: source.title,
		summary: source.summary,
		revision,
		contentHash,
		updatedAt
	}).where(and(eq(contexts.tenantId, tenantId), eq(contexts.key, scope.key), eq(contexts.revision, input.expectedRevision), eq(contexts.contentHash, input.expectedContentHash))).returning({ key: contexts.key });
	if (!updated) {
		const fresh = await fetchContextRow(client, tenantId, scope.key);
		if (!fresh) {
			throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
		}
		throw new ContextConflictError(scope.key, fresh.revision, fresh.content_hash);
	}
	await appendContextDeltaEntry(client, tenantId, scope.key, revision, current.title, current.summary, input.author, updatedAt, input.revision);
	return materializeContextRevision(client, tenantId, projectIdentity, { scopeRef: input.scopeRef, revision });
}

export async function materializeContextTermRevision(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string; revision: number }
): Promise<MaterializedContextTermRevision> {
	const scope = await resolveContextScope(client, tenantId, projectIdentity, input.scopeRef);
	const head = await getContextTermRecord(client, tenantId, scope.key, input.term.trim());
	if (!head) {
		throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${input.term}`, undefined, input.term);
	}
	const rows = await client.select().from(contextTermDeltaEntries)
		.where(and(eq(contextTermDeltaEntries.tenantId, tenantId), eq(contextTermDeltaEntries.contextKey, scope.key), eq(contextTermDeltaEntries.term, head.term)))
		.orderBy(desc(contextTermDeltaEntries.revision));
	return materializeContextTermFromPatches(
		{ contextKey: scope.key, term: head.term, definition: head.definition, avoid: head.avoid, tombstone: head.tombstone, revision: head.revision, createdAt: head.createdAt },
		rows.map((row) => ({ revision: row.revision, author: row.author, createdAt: row.createdAt, priorDefinition: row.priorDefinition, priorAvoid: parseAvoidTerms(row.priorAvoidTerms), priorTombstone: row.priorTombstone, ...(row.restoredFromRevision !== null && { restoredFromRevision: row.restoredFromRevision }) })),
		input.revision
	);
}

export async function restoreContextTermRevision(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }
): Promise<MaterializedContextTermRevision> {
	const scope = await resolveContextScope(client, tenantId, projectIdentity, input.scopeRef);
	const term = input.term.trim();
	const current = await getContextTermRecord(client, tenantId, scope.key, term);
	if (!current) {
		throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${term}`, undefined, term);
	}
	assertContextTermHead(scope.key, term, current, input.expectedRevision, input.expectedContentHash);
	const source = await materializeContextTermRevision(client, tenantId, projectIdentity, { scopeRef: input.scopeRef, term, revision: input.revision });
	const revision = current.revision + 1;
	const contentHash = computeContextTermContentHash(source.definition, source.avoid, source.tombstone);
	const updatedAt = new Date().toISOString();
	const [updated] = await client.update(contextTerms).set({
		definition: source.definition,
		avoidTerms: JSON.stringify(source.avoid),
		revision,
		contentHash,
		tombstone: source.tombstone,
		updatedAt
	}).where(and(eq(contextTerms.tenantId, tenantId), eq(contextTerms.contextKey, scope.key), eq(contextTerms.term, term), eq(contextTerms.revision, input.expectedRevision), eq(contextTerms.contentHash, input.expectedContentHash))).returning({ term: contextTerms.term });
	if (!updated) {
		const fresh = await getContextTermRecord(client, tenantId, scope.key, term);
		if (!fresh) {
			throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${term}`, undefined, term);
		}
		throw new ContextTermConflictError(scope.key, term, fresh.revision, fresh.contentHash);
	}
	await appendContextTermDeltaEntry(client, tenantId, scope.key, term, revision, current, input.author, updatedAt, input.revision);
	return materializeContextTermRevision(client, tenantId, projectIdentity, { scopeRef: input.scopeRef, term, revision });
}

function assertContextTermHead(contextKey: string, term: string, existing: ContextTermHead, expectedRevision: number | undefined, expectedContentHash: string | undefined): void {
	if (existing.revision !== expectedRevision || existing.contentHash !== expectedContentHash) {
		throw new ContextTermConflictError(contextKey, term, existing.revision, existing.contentHash);
	}
}

async function appendContextTermDeltaEntry(client: PoolClient, tenantId: string, contextKey: string, term: string, revision: number, prior: ContextTermHead, author: string | undefined, createdAt: string, restoredFromRevision?: number): Promise<void> {
	await client.insert(contextTermDeltaEntries).values({ id: randomUUID(), tenantId, contextKey, term, revision, author: author?.trim() || RESERVED_SYSTEM_AUTHOR, priorDefinition: prior.definition, priorAvoidTerms: JSON.stringify(prior.avoid), priorTombstone: prior.tombstone, restoredFromRevision: restoredFromRevision ?? null, createdAt });
}
