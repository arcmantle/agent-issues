import { randomUUID } from "node:crypto";

import {
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	deriveEntityStatuses,
	ENTITY_KINDS,
	getAllowedRelationType,
	getArchiveStatus,
	getInitialStatus,
	isAllowedRelation,
	isBodySource,
	isEntityKind,
	isInitiativeComplete,
	isStructuralRelationType,
	isValidStatus,
	RESERVED_SYSTEM_AUTHOR,
	ID_PREFIX,
	type BodySource,
	type ContextDetails,
	type ContextTermRecord,
	type EntityKind,
	type EntityRecord,
	type HandoffRecord,
	type HistoryEntryRecord,
	type RelationRecord,
	type RelationType
} from "@agent-issues/core";
import type { Pool, PoolClient } from "pg";

import { withTenantTransaction } from "./db/connection.js";

type EntityRow = {
	id: string;
	kind: string;
	title: string;
	status: string;
	body: string;
	body_source: string | null;
	created_at: string;
	updated_at: string;
};

type RelationRow = {
	from_id: string;
	to_id: string;
	type: string;
	created_at: string;
};

type HistoryEntryRow = {
	id: string;
	entity_id: string;
	version: number;
	author: string;
	title: string;
	body: string;
	body_source: string;
	status: string;
	parent_id: string | null;
	created_at: string;
};

type HandoffRow = {
	id: string;
	entity_id: string;
	initiative_id: string | null;
	summary: string;
	body: string;
	created_at: string;
};

export type EntityDetails = {
	entity: EntityRecord;
	incoming: Array<{ relationType: RelationType; entity: EntityRecord }>;
	outgoing: Array<{ relationType: RelationType; entity: EntityRecord }>;
};

export type LinkResult = {
	relation: RelationRecord;
	created: boolean;
};

export type UnlinkResult = {
	relation: RelationRecord;
	removed: boolean;
};

export type StatusUpdateResult = {
	entity: EntityRecord;
	previousStatus: string;
};

export type MoveResult = {
	entity: EntityRecord;
	previousParentId: string | null;
	newParentId: string;
	relationType: RelationType;
};

export type DeleteResult = {
	entity: EntityRecord;
	removed: boolean;
};

export type HandoffDetails = {
	focus: EntityDetails;
	structuralPath: Array<{ relationType: RelationType; entity: EntityRecord }>;
	initiative: InitiativeBundle | null;
	orphaned: boolean;
	activeBlockers: EntityRecord[];
	handoffs: HandoffRecord[];
};

export type HandoffDeleteResult = {
	handoff: HandoffRecord;
	removed: boolean;
};

export type InitiativeBundle = {
	initiative: EntityRecord;
	prds: EntityRecord[];
	userStories: EntityRecord[];
	adrs: EntityRecord[];
	issues: EntityRecord[];
	fixLinks: Array<{ issue: EntityRecord; userStory: EntityRecord }>;
	subIssueLinks: Array<{ parent: EntityRecord; issue: EntityRecord }>;
	blockerLinks: Array<{ source: EntityRecord; target: EntityRecord }>;
	constrainsLinks: Array<{ adr: EntityRecord; issue: EntityRecord }>;
	handoffs: HandoffRecord[];
};

export type DatabaseSnapshot = {
	generatedAt: string;
	entities: EntityRecord[];
	relations: RelationRecord[];
	orphans: EntityRecord[];
	projectAdrs: EntityRecord[];
	initiatives: InitiativeBundle[];
	contexts: {
		shared: ContextDetails;
		initiatives: ContextDetails[];
	};
};

/**
 * Seeds a fresh cloud tenant (per-kind id counters + the PROJ0/EPIC0
 * sentinels the full-chain invariant requires, ADR7) so `PgStore.createEntity`
 * has somewhere to attach a parent-less initiative, exactly like
 * `SqliteStore`'s local bootstrap (`ensureTenantCounters` /
 * `ensureFullChainInvariant` in core's `database.ts`). No legacy-data
 * import or backup step applies here: a cloud tenant starts empty.
 */
export async function ensurePgTenant(client: PoolClient, tenantId: string): Promise<void> {
	for (const kind of [...ENTITY_KINDS, "handoff"]) {
		await client.query(
			`INSERT INTO counters (tenant_id, kind, next_value) VALUES ($1, $2, 1) ON CONFLICT (tenant_id, kind) DO NOTHING`,
			[tenantId, kind]
		);
	}

	const now = new Date().toISOString();
	await client.query(
		`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		 VALUES ($1, $2, 'project', $3, 'active', '', 'generated', $4, $4)
		 ON CONFLICT (tenant_id, id) DO NOTHING`,
		[tenantId, DEFAULT_PROJECT_ID, DEFAULT_PROJECT_TITLE, now]
	);
	await client.query(
		`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		 VALUES ($1, $2, 'epic', $3, 'active', '', 'generated', $4, $4)
		 ON CONFLICT (tenant_id, id) DO NOTHING`,
		[tenantId, DEFAULT_EPIC_ID, DEFAULT_EPIC_TITLE, now]
	);
	await client.query(
		`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
		 VALUES ($1, $2, $3, 'contains', $4)
		 ON CONFLICT (tenant_id, from_id, to_id, type) DO NOTHING`,
		[tenantId, DEFAULT_PROJECT_ID, DEFAULT_EPIC_ID, now]
	);
}

function mapEntityRow(row: EntityRow): EntityRecord {
	if (!isEntityKind(row.kind)) {
		throw new Error(`Unexpected entity kind in database: ${row.kind}`);
	}

	const bodySource = row.body_source;

	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		status: row.status,
		body: row.body ?? "",
		bodySource: bodySource && isBodySource(bodySource) ? bodySource : "authored",
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function mapHistoryEntryRow(row: HistoryEntryRow): HistoryEntryRecord {
	return {
		id: row.id,
		entityId: row.entity_id,
		version: row.version,
		author: row.author,
		title: row.title,
		body: row.body,
		bodySource: isBodySource(row.body_source) ? row.body_source : "authored",
		status: row.status,
		parentId: row.parent_id,
		createdAt: row.created_at
	};
}

async function getEntityOrThrow(client: PoolClient, tenantId: string, entityId: string): Promise<EntityRecord> {
	const result = await client.query<EntityRow>(`SELECT * FROM entities WHERE tenant_id = $1 AND id = $2`, [tenantId, entityId]);
	const row = result.rows[0];

	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return mapEntityRow(row);
}

async function getStructuralParentRelations(client: PoolClient, tenantId: string, entityId: string): Promise<RelationRecord[]> {
	const result = await client.query<RelationRow>(
		`SELECT * FROM relations WHERE tenant_id = $1 AND to_id = $2 ORDER BY from_id, type`,
		[tenantId, entityId]
	);

	return result.rows
		.filter((row) => isStructuralRelationType(row.type))
		.map((row) => ({ fromId: row.from_id, toId: row.to_id, type: row.type as RelationType, createdAt: row.created_at }));
}

// Walks structural-only parent relations up to the root, mirroring core's
// store.ts getStructuralPath, so handoffs can resolve their owning
// initiative the same way locally and in the cloud.
async function getStructuralPath(
	client: PoolClient,
	tenantId: string,
	entityId: string
): Promise<Array<{ relationType: RelationType; entity: EntityRecord }>> {
	const path: Array<{ relationType: RelationType; entity: EntityRecord }> = [];
	const seen = new Set<string>([entityId]);
	let currentId = entityId;

	while (true) {
		const parents = await getStructuralParentRelations(client, tenantId, currentId);

		if (parents.length === 0) {
			return path.reverse();
		}

		if (parents.length > 1) {
			throw new Error(`Cannot build structural path for ${entityId} because ${currentId} has multiple structural parents.`);
		}

		const parent = parents[0]!;
		if (seen.has(parent.fromId)) {
			throw new Error(`Cannot build structural path for ${entityId} because the structural graph contains a cycle.`);
		}

		seen.add(parent.fromId);
		path.push({ relationType: parent.type, entity: await getEntityOrThrow(client, tenantId, parent.fromId) });
		currentId = parent.fromId;
	}
}

async function resolveOwningInitiativeId(client: PoolClient, tenantId: string, focus: EntityRecord): Promise<string | null> {
	if (focus.kind === "initiative") {
		return focus.id;
	}

	const structuralPath = await getStructuralPath(client, tenantId, focus.id);
	return structuralPath.find((entry) => entry.entity.kind === "initiative")?.entity.id ?? null;
}

async function nextEntityId(client: PoolClient, tenantId: string, kind: EntityKind): Promise<string> {
	const result = await client.query<{ next_value: number }>(
		`SELECT next_value FROM counters WHERE tenant_id = $1 AND kind = $2`,
		[tenantId, kind]
	);
	const row = result.rows[0];

	if (!row) {
		throw new Error(`Counter missing for entity kind: ${kind}`);
	}

	await client.query(`UPDATE counters SET next_value = next_value + 1 WHERE tenant_id = $1 AND kind = $2`, [tenantId, kind]);
	return `${ID_PREFIX[kind]}${row.next_value}`;
}

async function getNextHistoryVersion(client: PoolClient, tenantId: string, entityId: string): Promise<number> {
	const result = await client.query<{ max_version: number | null }>(
		`SELECT MAX(version) AS max_version FROM history_entries WHERE tenant_id = $1 AND entity_id = $2`,
		[tenantId, entityId]
	);

	return (result.rows[0]?.max_version ?? 0) + 1;
}

// Appends a full snapshot of `entity`'s current trackable facts as the next
// history version (ADR8), mirroring `appendHistoryEntry` in core's
// `store.ts` so both backends share the same append-only write path.
async function appendHistoryEntry(client: PoolClient, tenantId: string, entity: EntityRecord, author: string | undefined): Promise<void> {
	const parentId = (await getStructuralParentRelations(client, tenantId, entity.id))[0]?.fromId ?? null;
	const version = await getNextHistoryVersion(client, tenantId, entity.id);

	await client.query(
		`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		[
			randomUUID(),
			tenantId,
			entity.id,
			version,
			author?.trim() || RESERVED_SYSTEM_AUTHOR,
			entity.title,
			entity.body,
			entity.bodySource,
			entity.status,
			parentId,
			entity.updatedAt
		]
	);
}

async function getAllEntities(client: PoolClient, tenantId: string): Promise<EntityRecord[]> {
	const result = await client.query<EntityRow>(`SELECT * FROM entities WHERE tenant_id = $1`, [tenantId]);
	return result.rows.map(mapEntityRow);
}

async function getAllRelations(client: PoolClient, tenantId: string): Promise<RelationRecord[]> {
	const result = await client.query<RelationRow>(`SELECT * FROM relations WHERE tenant_id = $1`, [tenantId]);
	return result.rows.map((row) => ({ fromId: row.from_id, toId: row.to_id, type: row.type as RelationType, createdAt: row.created_at }));
}

async function getDerivedStatusMap(client: PoolClient, tenantId: string): Promise<Map<string, string>> {
	const entities = deriveEntityStatuses(await getAllEntities(client, tenantId), await getAllRelations(client, tenantId));
	return new Map(entities.map((entity) => [entity.id, entity.status]));
}

function applyDerivedStatus(entity: EntityRecord, statusMap: Map<string, string>): EntityRecord {
	const derived = statusMap.get(entity.id);
	return derived === undefined || derived === entity.status ? entity : { ...entity, status: derived };
}

async function getRelationOrThrow(
	client: PoolClient,
	tenantId: string,
	input: { fromId: string; toId: string; relationType: string }
): Promise<RelationRecord> {
	const result = await client.query<RelationRow>(
		`SELECT * FROM relations WHERE tenant_id = $1 AND from_id = $2 AND to_id = $3 AND type = $4`,
		[tenantId, input.fromId, input.toId, input.relationType]
	);
	const row = result.rows[0];

	if (!row) {
		throw new Error(`Relation not found: ${input.fromId} -> ${input.toId} as ${input.relationType}`);
	}

	return { fromId: row.from_id, toId: row.to_id, type: row.type as RelationType, createdAt: row.created_at };
}

async function insertRelation(client: PoolClient, tenantId: string, relation: RelationRecord): Promise<{ inserted: boolean }> {
	const result = await client.query(
		`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT DO NOTHING`,
		[tenantId, relation.fromId, relation.toId, relation.type, relation.createdAt]
	);

	return { inserted: (result.rowCount ?? 0) > 0 };
}

function collectReachableIds(relations: RelationRecord[], startId: string): Set<string> {
	const seen = new Set<string>([startId]);
	const queue = [startId];

	while (queue.length > 0) {
		const currentId = queue.shift();
		if (!currentId) {
			continue;
		}

		for (const relation of relations) {
			if (relation.fromId !== currentId || seen.has(relation.toId)) {
				continue;
			}

			seen.add(relation.toId);
			queue.push(relation.toId);
		}
	}

	return seen;
}

async function hasTypedPath(client: PoolClient, tenantId: string, startId: string, targetId: string, relationType: string): Promise<boolean> {
	const relations = (await getAllRelations(client, tenantId)).filter((relation) => relation.type === relationType);
	return collectReachableIds(relations, startId).has(targetId);
}

async function hasStructuralPath(client: PoolClient, tenantId: string, startId: string, targetId: string): Promise<boolean> {
	const relations = (await getAllRelations(client, tenantId)).filter((relation) => isStructuralRelationType(relation.type));
	return collectReachableIds(relations, startId).has(targetId);
}

// Mirrors `wouldOrphanSubtree` in core's `store.ts`: blocks removing a
// structural relation that would leave an entity (and everything under it)
// unreachable from every initiative.
async function wouldOrphanSubtree(client: PoolClient, tenantId: string, relation: RelationRecord): Promise<boolean> {
	if (!isStructuralRelationType(relation.type)) {
		return false;
	}

	const currentRelations = await getAllRelations(client, tenantId);
	const remainingRelations = currentRelations.filter(
		(candidate) => !(candidate.fromId === relation.fromId && candidate.toId === relation.toId && candidate.type === relation.type)
	);
	const entities = await getAllEntities(client, tenantId);
	const stillReachable = new Set<string>();

	for (const entity of entities) {
		if (entity.kind !== "initiative") {
			continue;
		}

		for (const id of collectReachableIds(remainingRelations, entity.id)) {
			stillReachable.add(id);
		}
	}

	if (stillReachable.has(relation.toId)) {
		return false;
	}

	return remainingRelations.some((candidate) => candidate.fromId === relation.toId);
}

// Mirrors `wouldBreakFullChainInvariant` in core's `store.ts`: blocks
// unlinking a "contains" relation that is the sole remaining structural
// parent of an epic or initiative (ADR7's full-chain invariant).
async function wouldBreakFullChainInvariant(client: PoolClient, tenantId: string, relation: RelationRecord): Promise<boolean> {
	if (relation.type !== "contains") {
		return false;
	}

	const target = await getEntityOrThrow(client, tenantId, relation.toId);
	if (target.kind !== "epic" && target.kind !== "initiative") {
		return false;
	}

	const result = await client.query<{ count: string }>(
		`SELECT COUNT(*) AS count FROM relations
		 WHERE tenant_id = $1 AND to_id = $2 AND type = 'contains'
		   AND NOT (from_id = $3 AND to_id = $2 AND type = 'contains')`,
		[tenantId, relation.toId, relation.fromId]
	);

	return Number(result.rows[0]?.count ?? "0") === 0;
}

async function getActiveBlockingIssues(client: PoolClient, tenantId: string, entityId: string): Promise<EntityRecord[]> {
	const result = await client.query<EntityRow>(
		`SELECT entities.*
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		 WHERE relations.tenant_id = $1
		   AND relations.type = 'blocks'
		   AND relations.to_id = $2
		   AND entities.status != 'done'
		 ORDER BY entities.id`,
		[tenantId, entityId]
	);

	return result.rows.map(mapEntityRow);
}

async function getOpenSubIssues(client: PoolClient, tenantId: string, issueId: string): Promise<EntityRecord[]> {
	const statusMap = await getDerivedStatusMap(client, tenantId);
	const result = await client.query<EntityRow>(
		`SELECT entities.*
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		 WHERE relations.tenant_id = $1
		   AND relations.from_id = $2
		   AND relations.type = 'decomposes'
		 ORDER BY entities.id`,
		[tenantId, issueId]
	);

	return result.rows
		.map(mapEntityRow)
		.map((entity) => applyDerivedStatus(entity, statusMap))
		.filter((entity) => entity.status !== "done");
}

async function getFixingIssueStatuses(client: PoolClient, tenantId: string, storyId: string): Promise<string[]> {
	const result = await client.query<{ status: string }>(
		`SELECT entities.status
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		 WHERE relations.tenant_id = $1
		   AND relations.type = 'fixes'
		   AND relations.to_id = $2
		   AND entities.kind = 'issue'`,
		[tenantId, storyId]
	);

	return result.rows.map((row) => row.status);
}

async function getCreatedStoryStatuses(client: PoolClient, tenantId: string, prdId: string): Promise<string[]> {
	const statusMap = await getDerivedStatusMap(client, tenantId);
	const result = await client.query<{ id: string }>(
		`SELECT entities.id
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		 WHERE relations.tenant_id = $1
		   AND relations.type = 'creates'
		   AND relations.from_id = $2
		   AND entities.kind = 'userStory'`,
		[tenantId, prdId]
	);

	return result.rows.map((row) => statusMap.get(row.id) ?? "");
}

async function getConstrainedIssueStatuses(client: PoolClient, tenantId: string, adrId: string): Promise<string[]> {
	const result = await client.query<{ status: string }>(
		`SELECT entities.status
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		 WHERE relations.tenant_id = $1
		   AND relations.type = 'constrains'
		   AND relations.from_id = $2
		   AND entities.kind = 'issue'`,
		[tenantId, adrId]
	);

	return result.rows.map((row) => row.status);
}

async function isAdrSuperseded(client: PoolClient, tenantId: string, adrId: string): Promise<boolean> {
	const result = await client.query(
		`SELECT 1
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		 WHERE relations.tenant_id = $1
		   AND relations.type = 'supersedes'
		   AND relations.to_id = $2
		   AND entities.kind = 'adr'
		 LIMIT 1`,
		[tenantId, adrId]
	);

	return (result.rowCount ?? 0) > 0;
}

async function getInitiativeChildStatuses(
	client: PoolClient,
	tenantId: string,
	initiativeId: string
): Promise<{ trackedIssueStatuses: string[]; ownedPrdStatuses: string[] }> {
	const statusMap = await getDerivedStatusMap(client, tenantId);
	const structuralRelations = (await getAllRelations(client, tenantId)).filter((relation) => isStructuralRelationType(relation.type));
	const reachableIds = collectReachableIds(structuralRelations, initiativeId);
	reachableIds.delete(initiativeId);
	const entities = await getAllEntities(client, tenantId);

	return {
		trackedIssueStatuses: entities
			.filter((entity) => entity.kind === "issue" && reachableIds.has(entity.id))
			.map((entity) => statusMap.get(entity.id) ?? ""),
		ownedPrdStatuses: entities
			.filter((entity) => entity.kind === "prd" && reachableIds.has(entity.id))
			.map((entity) => statusMap.get(entity.id) ?? "")
	};
}

async function getAllDerivedEntities(client: PoolClient, tenantId: string): Promise<EntityRecord[]> {
	return deriveEntityStatuses(await getAllEntities(client, tenantId), await getAllRelations(client, tenantId));
}

function mapHandoffRow(row: HandoffRow): HandoffRecord {
	return {
		id: row.id,
		entityId: row.entity_id,
		initiativeId: row.initiative_id,
		summary: row.summary ?? "",
		body: row.body,
		createdAt: row.created_at
	};
}

async function nextHandoffId(client: PoolClient, tenantId: string): Promise<string> {
	const result = await client.query<{ next_value: number }>(
		`SELECT next_value FROM counters WHERE tenant_id = $1 AND kind = 'handoff'`,
		[tenantId]
	);
	const row = result.rows[0];

	if (!row) {
		throw new Error("Counter missing for handoffs.");
	}

	await client.query(`UPDATE counters SET next_value = next_value + 1 WHERE tenant_id = $1 AND kind = 'handoff'`, [tenantId]);
	return `HO${row.next_value}`;
}

function normalizeHandoffSummary(summary: string | undefined): string {
	return (summary ?? "").trim();
}

function normalizeHandoffBody(body: string): string {
	const trimmed = body.trim();

	if (trimmed.length === 0) {
		throw new Error("Handoff body must not be empty.");
	}

	return trimmed;
}

async function getHandoffOrThrow(client: PoolClient, tenantId: string, handoffId: string): Promise<HandoffRecord> {
	const result = await client.query<HandoffRow>(`SELECT * FROM handoffs WHERE tenant_id = $1 AND id = $2`, [tenantId, handoffId]);
	const row = result.rows[0];

	if (!row) {
		throw new Error(`Handoff not found: ${handoffId}`);
	}

	return mapHandoffRow(row);
}

// Shared query path for both the public listHandoffs seam method and
// getInitiativeBundle/getDatabaseSnapshot's embedded handoff data, so both
// stay in sync with a single tenant-scoped, optionally-filtered query.
async function listHandoffsFiltered(
	client: PoolClient,
	tenantId: string,
	filter?: { initiativeId?: string; entityId?: string }
): Promise<HandoffRecord[]> {
	const conditions = ["tenant_id = $1"];
	const params: unknown[] = [tenantId];

	if (filter?.initiativeId !== undefined) {
		params.push(filter.initiativeId);
		conditions.push(`initiative_id = $${params.length}`);
	}

	if (filter?.entityId !== undefined) {
		params.push(filter.entityId);
		conditions.push(`entity_id = $${params.length}`);
	}

	const result = await client.query<HandoffRow>(
		`SELECT * FROM handoffs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC`,
		params
	);

	return result.rows.map(mapHandoffRow);
}

// Read-only shared/initiative context lookup, scoped to exactly the two
// keys getDatabaseSnapshot needs ("default" and an initiative's own id,
// which is always its own context key). Deliberately does NOT implement
// resolveContextScope's general entity-to-owning-initiative walk, term
// definition/forgetting, or directory search - that is ISS45's full
// context/glossary section. Falls back to the same "not configured yet"
// default shape core's `createContextRecord` produces when no row exists,
// so this is honest about what's actually queryable today, not a fabricated
// placeholder.
async function getContextDetailsForSnapshot(
	client: PoolClient,
	tenantId: string,
	scope: { key: string; scopeKind: "default" | "initiative"; scopeEntityId: string | null; scopeLabel: string; defaultTitle: string; defaultSummary: string }
): Promise<ContextDetails> {
	const result = await client.query<{
		key: string;
		scope_entity_id: string | null;
		title: string;
		summary: string;
		created_at: string;
		updated_at: string;
	}>(`SELECT * FROM contexts WHERE tenant_id = $1 AND key = $2`, [tenantId, scope.key]);
	const row = result.rows[0];
	const termRows = row
		? (
				await client.query<{ term: string; definition: string; avoid_terms: string; created_at: string; updated_at: string }>(
					`SELECT term, definition, avoid_terms, created_at, updated_at FROM context_terms WHERE tenant_id = $1 AND context_key = $2 ORDER BY lower(term), term`,
					[tenantId, scope.key]
				)
			).rows
		: [];
	const terms: ContextTermRecord[] = termRows.map((termRow) => ({
		term: termRow.term,
		definition: termRow.definition,
		avoid: parseAvoidTerms(termRow.avoid_terms),
		createdAt: termRow.created_at,
		updatedAt: termRow.updated_at
	}));

	return {
		context: row
			? {
					key: row.key,
					scopeKind: scope.scopeKind,
					scopeEntityId: row.scope_entity_id,
					scopeLabel: scope.scopeLabel,
					title: row.title,
					summary: row.summary,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					exists: true
				}
			: {
					key: scope.key,
					scopeKind: scope.scopeKind,
					scopeEntityId: scope.scopeEntityId,
					scopeLabel: scope.scopeLabel,
					title: scope.defaultTitle,
					summary: scope.defaultSummary,
					createdAt: null,
					updatedAt: null,
					exists: false
				},
		terms
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

/**
 * Postgres implementation of the entity-lifecycle slice of the
 * storage-driver seam (ADR11, ADR13, ISS39). Every method opens exactly one
 * `withTenantTransaction` (ADR9's `SET LOCAL app.tenant_id`), so RLS is
 * always active for the query.
 *
 * This is a partial implementation: it does not yet `implements
 * StorageDriver` because the context/glossary (beyond the minimal
 * shared/initiative lookup reused here) and tenant-administration sections
 * of that seam are unimplemented (tracked as ISS39 follow-up issues
 * ISS45-ISS46), as is the JSON-RPC gate and change/event stream (ISS47,
 * ISS48). The handoffs section (ISS44) is fully implemented below.
 */
export class PgStore {
	public constructor(
		private readonly pool: Pool,
		public readonly tenantId: string
	) {}

	public async createEntity(input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		author?: string;
	}): Promise<EntityRecord> {
		if (!isEntityKind(input.kind)) {
			throw new Error(`Unknown entity kind: ${input.kind}`);
		}

		const kind = input.kind;
		const title = input.title.trim();
		if (title.length === 0) {
			throw new Error("Entity title must not be empty.");
		}
		const body = input.body ?? "";
		const bodySource: BodySource = "authored";
		const status = input.status ?? getInitialStatus(kind);

		if (!isValidStatus(kind, status)) {
			throw new Error(`Invalid status for ${kind}: ${status}`);
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			// Idempotent (ON CONFLICT DO NOTHING); simplifies this slice by not
			// requiring a separate tenant-bootstrap lifecycle step. SqliteStore
			// bootstraps once at open() instead - worth converging on later.
			await ensurePgTenant(client, this.tenantId);

			const now = new Date().toISOString();
			const parentId = input.parentId ?? (kind === "initiative" ? DEFAULT_EPIC_ID : undefined);
			const parent = parentId ? await getEntityOrThrow(client, this.tenantId, parentId) : null;
			const relationType = parent ? getAllowedRelationType(parent.kind, kind) : null;

			if (parent && !relationType) {
				throw new Error(`Cannot create ${kind} under ${parent.kind}.`);
			}

			const id = await nextEntityId(client, this.tenantId, kind);
			await client.query(
				`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
				[this.tenantId, id, kind, title, status, body, bodySource, now]
			);

			if (parent && relationType) {
				await client.query(
					`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
					[this.tenantId, parent.id, id, relationType, now]
				);
			}

			const entity = await getEntityOrThrow(client, this.tenantId, id);
			await appendHistoryEntry(client, this.tenantId, entity, input.author);
			return entity;
		});
	}

	public async getEntityDetails(entityId: string): Promise<EntityDetails> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const entity = await getEntityOrThrow(client, this.tenantId, entityId);

			const incomingResult = await client.query<EntityRow & { type: string }>(
				`SELECT relations.type, entities.*
				 FROM relations
				 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
				 WHERE relations.tenant_id = $1 AND relations.to_id = $2
				 ORDER BY entities.id`,
				[this.tenantId, entityId]
			);
			const outgoingResult = await client.query<EntityRow & { type: string }>(
				`SELECT relations.type, entities.*
				 FROM relations
				 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
				 WHERE relations.tenant_id = $1 AND relations.from_id = $2
				 ORDER BY entities.id`,
				[this.tenantId, entityId]
			);

			const statusMap = await getDerivedStatusMap(client, this.tenantId);

			return {
				entity: applyDerivedStatus(entity, statusMap),
				incoming: incomingResult.rows.map((row) => ({
					relationType: row.type as RelationType,
					entity: applyDerivedStatus(mapEntityRow(row), statusMap)
				})),
				outgoing: outgoingResult.rows.map((row) => ({
					relationType: row.type as RelationType,
					entity: applyDerivedStatus(mapEntityRow(row), statusMap)
				}))
			};
		});
	}

	public async listEntities(kind: string): Promise<EntityRecord[]> {
		if (!isEntityKind(kind)) {
			throw new Error(`Unknown entity kind: ${kind}`);
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const entities = deriveEntityStatuses(await getAllEntities(client, this.tenantId), await getAllRelations(client, this.tenantId));
			return entities.filter((entity) => entity.kind === kind);
		});
	}

	public async listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const result = await client.query<HistoryEntryRow>(
				`SELECT * FROM history_entries WHERE tenant_id = $1 AND entity_id = $2 ORDER BY version ASC`,
				[this.tenantId, entityId]
			);
			return result.rows.map(mapHistoryEntryRow);
		});
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult> {
		if (input.fromId === input.toId) {
			throw new Error("Cannot create a relation from an entity to itself.");
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const from = await getEntityOrThrow(client, this.tenantId, input.fromId);
			const to = await getEntityOrThrow(client, this.tenantId, input.toId);

			if (!isAllowedRelation(from.kind, to.kind, input.relationType)) {
				throw new Error(`Relation ${input.relationType} is not allowed from ${from.kind} to ${to.kind}.`);
			}

			if (
				(input.relationType === "blocks" || input.relationType === "supersedes") &&
				(await hasTypedPath(client, this.tenantId, to.id, from.id, input.relationType))
			) {
				throw new Error(`Linking ${from.id} -> ${to.id} as ${input.relationType} would create a cycle.`);
			}

			const createdAt = new Date().toISOString();
			const relation: RelationRecord = { fromId: from.id, toId: to.id, type: input.relationType as RelationType, createdAt };
			const { inserted } = await insertRelation(client, this.tenantId, relation);

			return { relation, created: inserted };
		});
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const relation = await getRelationOrThrow(client, this.tenantId, input);

			if (await wouldOrphanSubtree(client, this.tenantId, relation)) {
				throw new Error(
					`Unlinking ${relation.fromId} -> ${relation.toId} as ${relation.type} would orphan a subtree. Relink or delete descendants first.`
				);
			}

			if (await wouldBreakFullChainInvariant(client, this.tenantId, relation)) {
				const target = await getEntityOrThrow(client, this.tenantId, relation.toId);
				throw new Error(
					`Cannot unlink ${relation.fromId} -> ${relation.toId} as ${relation.type}: it is the only remaining structural parent, and every ${target.kind} must have one.`
				);
			}

			const result = await client.query(
				`DELETE FROM relations WHERE tenant_id = $1 AND from_id = $2 AND to_id = $3 AND type = $4`,
				[this.tenantId, relation.fromId, relation.toId, relation.type]
			);

			return { relation, removed: (result.rowCount ?? 0) > 0 };
		});
	}

	public async updateEntityStatus(input: { entityId: string; status: string; author?: string }): Promise<StatusUpdateResult> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const entity = await getEntityOrThrow(client, this.tenantId, input.entityId);

			if (!isValidStatus(entity.kind, input.status)) {
				throw new Error(`Invalid status for ${entity.kind}: ${input.status}`);
			}

			if (entity.kind === "userStory") {
				const fixingIssueStatuses = await getFixingIssueStatuses(client, this.tenantId, entity.id);
				if (fixingIssueStatuses.length > 0) {
					throw new Error(`${entity.id} status is derived from its fixing issues; update those issues instead of setting it directly.`);
				}
			}

			if (entity.kind === "prd") {
				const createdStoryStatuses = await getCreatedStoryStatuses(client, this.tenantId, entity.id);
				if (createdStoryStatuses.length > 0) {
					throw new Error(`${entity.id} status is derived from its user stories; update the underlying issues instead of setting it directly.`);
				}
			}

			if (entity.kind === "adr") {
				if (await isAdrSuperseded(client, this.tenantId, entity.id)) {
					throw new Error(`${entity.id} status is derived (superseded) because another ADR supersedes it.`);
				}
				if ((await getConstrainedIssueStatuses(client, this.tenantId, entity.id)).length > 0) {
					throw new Error(`${entity.id} status is derived from the issues it constrains; update those issues instead of setting it directly.`);
				}
			}

			if (entity.kind === "initiative") {
				const { trackedIssueStatuses, ownedPrdStatuses } = await getInitiativeChildStatuses(client, this.tenantId, entity.id);
				if (isInitiativeComplete(trackedIssueStatuses, ownedPrdStatuses)) {
					throw new Error(`${entity.id} status is derived (done) from its tracked issues and PRDs; reopen a child to change it.`);
				}
				if (input.status === "done" && trackedIssueStatuses.length > 0) {
					throw new Error(
						`${entity.id} cannot be marked done while tracked issues remain open; it completes automatically when they are all done.`
					);
				}
			}

			if (entity.kind === "issue" && (input.status === "in-progress" || input.status === "done")) {
				const openSubIssues = await getOpenSubIssues(client, this.tenantId, entity.id);
				if (openSubIssues.length > 0) {
					throw new Error(
						`Cannot set ${entity.id} to ${input.status} while sub-issues remain open: ${openSubIssues.map((issue) => issue.id).join(", ")}.`
					);
				}

				const blockingIssues = await getActiveBlockingIssues(client, this.tenantId, entity.id);
				if (blockingIssues.length > 0) {
					throw new Error(
						`Cannot set ${entity.id} to ${input.status} while blocked by ${blockingIssues.map((issue) => issue.id).join(", ")}.`
					);
				}
			}

			const previousStatus = entity.status;
			const updatedAt = new Date().toISOString();

			await client.query(`UPDATE entities SET status = $1, updated_at = $2 WHERE tenant_id = $3 AND id = $4`, [
				input.status,
				updatedAt,
				this.tenantId,
				input.entityId
			]);

			const updated = await getEntityOrThrow(client, this.tenantId, input.entityId);
			await appendHistoryEntry(client, this.tenantId, updated, input.author);

			return { entity: updated, previousStatus };
		});
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string }): Promise<EntityRecord> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			await getEntityOrThrow(client, this.tenantId, input.entityId);

			const updatedAt = new Date().toISOString();
			const bodySource = input.bodySource ?? "authored";

			await client.query(`UPDATE entities SET body = $1, body_source = $2, updated_at = $3 WHERE tenant_id = $4 AND id = $5`, [
				input.body,
				bodySource,
				updatedAt,
				this.tenantId,
				input.entityId
			]);

			const updated = await getEntityOrThrow(client, this.tenantId, input.entityId);
			await appendHistoryEntry(client, this.tenantId, updated, input.author);
			return updated;
		});
	}

	public async archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult> {
		const entity = await withTenantTransaction(this.pool, this.tenantId, (client) => getEntityOrThrow(client, this.tenantId, input.entityId));
		return this.updateEntityStatus({ entityId: input.entityId, status: getArchiveStatus(entity.kind) });
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult> {
		if (input.entityId === input.newParentId) {
			throw new Error("Cannot move an entity under itself.");
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const entity = await getEntityOrThrow(client, this.tenantId, input.entityId);
			const newParent = await getEntityOrThrow(client, this.tenantId, input.newParentId);

			const relationType = getAllowedRelationType(newParent.kind, entity.kind);
			if (!relationType || !isStructuralRelationType(relationType)) {
				throw new Error(`Cannot move ${entity.kind} under ${newParent.kind}.`);
			}

			const currentParentRelations = await getStructuralParentRelations(client, this.tenantId, entity.id);
			if (currentParentRelations.length > 1) {
				throw new Error(`Cannot move ${entity.id} because it has multiple structural parents.`);
			}

			if (await hasStructuralPath(client, this.tenantId, entity.id, newParent.id)) {
				throw new Error(`Cannot move ${entity.id} under ${newParent.id} because that would create a cycle.`);
			}

			const previousParentId = currentParentRelations[0]?.fromId ?? null;
			if (previousParentId === newParent.id && currentParentRelations[0]?.type === relationType) {
				return { entity, previousParentId, newParentId: newParent.id, relationType };
			}

			const updatedAt = new Date().toISOString();

			for (const relation of currentParentRelations) {
				await client.query(`DELETE FROM relations WHERE tenant_id = $1 AND from_id = $2 AND to_id = $3 AND type = $4`, [
					this.tenantId,
					relation.fromId,
					relation.toId,
					relation.type
				]);
			}

			await insertRelation(client, this.tenantId, { fromId: newParent.id, toId: entity.id, type: relationType, createdAt: updatedAt });

			await client.query(`UPDATE entities SET updated_at = $1 WHERE tenant_id = $2 AND id = $3`, [updatedAt, this.tenantId, entity.id]);

			await appendHistoryEntry(client, this.tenantId, await getEntityOrThrow(client, this.tenantId, entity.id), input.author);

			return {
				entity: await getEntityOrThrow(client, this.tenantId, entity.id),
				previousParentId,
				newParentId: newParent.id,
				relationType
			};
		});
	}

	public async deleteEntity(input: { entityId: string }): Promise<DeleteResult> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const entity = await getEntityOrThrow(client, this.tenantId, input.entityId);

			const outgoingResult = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM relations WHERE tenant_id = $1 AND from_id = $2`, [
				this.tenantId,
				input.entityId
			]);
			if (Number(outgoingResult.rows[0]?.count ?? "0") > 0) {
				throw new Error(`Cannot delete ${entity.id} while it still has outgoing relations. Unlink or delete dependents first.`);
			}

			const result = await client.query(`DELETE FROM entities WHERE tenant_id = $1 AND id = $2`, [this.tenantId, input.entityId]);

			return { entity, removed: (result.rowCount ?? 0) > 0 };
		});
	}

	public async listOrphans(kind?: string): Promise<EntityRecord[]> {
		if (kind && !isEntityKind(kind)) {
			throw new Error(`Unknown entity kind: ${kind}`);
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const entities = await getAllEntities(client, this.tenantId);
			const relations = await getAllRelations(client, this.tenantId);
			const reachable = new Set<string>();

			for (const entity of entities) {
				if (entity.kind !== "initiative") {
					continue;
				}

				for (const id of collectReachableIds(relations, entity.id)) {
					reachable.add(id);
				}
			}

			const statusMap = await getDerivedStatusMap(client, this.tenantId);
			return entities
				.filter((entity) => {
					if (entity.kind === "initiative" || entity.kind === "adr" || entity.kind === "project" || entity.kind === "epic") {
						return false;
					}

					if (kind && entity.kind !== kind) {
						return false;
					}

					return !reachable.has(entity.id);
				})
				.map((entity) => applyDerivedStatus(entity, statusMap));
		});
	}

	public async listProjectAdrs(): Promise<EntityRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const entities = await getAllEntities(client, this.tenantId);
			const relations = await getAllRelations(client, this.tenantId);
			const childIds = new Set(relations.filter((relation) => isStructuralRelationType(relation.type)).map((relation) => relation.toId));

			return entities.filter((entity) => entity.kind === "adr" && !childIds.has(entity.id));
		});
	}

	public async getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const initiative = await getEntityOrThrow(client, this.tenantId, initiativeId);
			if (initiative.kind !== "initiative") {
				throw new Error(`${initiativeId} is not an initiative.`);
			}

			const reachableResult = await client.query<{ id: string }>(
				`WITH RECURSIVE reachable(id) AS (
				   SELECT $1::text
				   UNION
				   SELECT relations.to_id
				   FROM relations
				   JOIN reachable ON relations.from_id = reachable.id
				   WHERE relations.tenant_id = $2
				 )
				 SELECT id FROM reachable`,
				[initiativeId, this.tenantId]
			);
			const reachableIds = reachableResult.rows.map((row) => row.id);

			const entityRows = await client.query<EntityRow>(
				`SELECT * FROM entities WHERE tenant_id = $1 AND id = ANY($2::text[]) ORDER BY id`,
				[this.tenantId, reachableIds]
			);
			const relationRows = await client.query<RelationRow>(
				`SELECT * FROM relations WHERE tenant_id = $1 AND from_id = ANY($2::text[]) AND to_id = ANY($2::text[])`,
				[this.tenantId, reachableIds]
			);

			const entities = entityRows.rows.map(mapEntityRow);
			const statusMap = await getDerivedStatusMap(client, this.tenantId);
			const derivedEntities = entities.map((entity) => applyDerivedStatus(entity, statusMap));
			const entityById = new Map(derivedEntities.map((entity) => [entity.id, entity]));

			return {
				initiative: applyDerivedStatus(initiative, statusMap),
				prds: derivedEntities.filter((entity) => entity.kind === "prd"),
				userStories: derivedEntities.filter((entity) => entity.kind === "userStory"),
				adrs: derivedEntities.filter((entity) => entity.kind === "adr"),
				issues: derivedEntities.filter((entity) => entity.kind === "issue"),
				fixLinks: relationRows.rows
					.filter((relation) => relation.type === "fixes")
					.map((relation) => ({ issue: entityById.get(relation.from_id)!, userStory: entityById.get(relation.to_id)! })),
				subIssueLinks: relationRows.rows
					.filter((relation) => relation.type === "decomposes")
					.map((relation) => ({ parent: entityById.get(relation.from_id)!, issue: entityById.get(relation.to_id)! })),
				blockerLinks: relationRows.rows
					.filter((relation) => relation.type === "blocks")
					.map((relation) => ({ source: entityById.get(relation.from_id)!, target: entityById.get(relation.to_id)! })),
				constrainsLinks: relationRows.rows
					.filter((relation) => relation.type === "constrains")
					.map((relation) => ({ adr: entityById.get(relation.from_id)!, issue: entityById.get(relation.to_id)! })),
				handoffs: await listHandoffsFiltered(client, this.tenantId, { initiativeId: initiative.id })
			};
		});
	}

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const entities = await getAllDerivedEntities(client, this.tenantId);
			const relations = await getAllRelations(client, this.tenantId);
			const initiatives = entities.filter((entity) => entity.kind === "initiative");

			const orphans = await this.listOrphans();
			const projectAdrs = await this.listProjectAdrs();
			const initiativeBundles = await Promise.all(initiatives.map((entity) => this.getInitiativeBundle(entity.id)));

			const sharedContext = await getContextDetailsForSnapshot(client, this.tenantId, {
				key: DEFAULT_CONTEXT_KEY,
				scopeKind: "default",
				scopeEntityId: null,
				scopeLabel: "Shared",
				defaultTitle: DEFAULT_CONTEXT_TITLE,
				defaultSummary: DEFAULT_CONTEXT_SUMMARY
			});
			const initiativeContexts = await Promise.all(
				initiatives.map((entity) =>
					getContextDetailsForSnapshot(client, this.tenantId, {
						key: entity.id,
						scopeKind: "initiative",
						scopeEntityId: entity.id,
						scopeLabel: entity.title,
						defaultTitle: `${entity.title} Context`,
						defaultSummary: `Glossary of initiative-specific domain terms for ${entity.title}.`
					})
				)
			);

			return {
				generatedAt: new Date().toISOString(),
				entities,
				relations,
				orphans,
				projectAdrs,
				initiatives: initiativeBundles,
				contexts: {
					shared: sharedContext,
					initiatives: initiativeContexts
				}
			};
		});
	}

	public async createHandoff(input: { entityId: string; summary?: string; body: string }): Promise<HandoffRecord> {
		const summary = normalizeHandoffSummary(input.summary);
		const body = normalizeHandoffBody(input.body);

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const focus = await getEntityOrThrow(client, this.tenantId, input.entityId);
			const initiativeId = await resolveOwningInitiativeId(client, this.tenantId, focus);
			const now = new Date().toISOString();
			const id = await nextHandoffId(client, this.tenantId);

			await client.query(
				`INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				[this.tenantId, id, focus.id, initiativeId, summary, body, now]
			);

			return getHandoffOrThrow(client, this.tenantId, id);
		});
	}

	public async updateHandoff(input: { handoffId: string; summary?: string; body?: string }): Promise<HandoffRecord> {
		if (input.summary === undefined && input.body === undefined) {
			throw new Error("Provide --summary, --body, or --body-file to update a handoff.");
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const current = await getHandoffOrThrow(client, this.tenantId, input.handoffId);
			const summary = input.summary === undefined ? current.summary : normalizeHandoffSummary(input.summary);
			const body = input.body === undefined ? current.body : normalizeHandoffBody(input.body);

			await client.query(`UPDATE handoffs SET summary = $1, body = $2 WHERE tenant_id = $3 AND id = $4`, [
				summary,
				body,
				this.tenantId,
				input.handoffId
			]);

			return getHandoffOrThrow(client, this.tenantId, input.handoffId);
		});
	}

	public async deleteHandoff(input: { handoffId: string }): Promise<HandoffDeleteResult> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const handoff = await getHandoffOrThrow(client, this.tenantId, input.handoffId);
			const result = await client.query(`DELETE FROM handoffs WHERE tenant_id = $1 AND id = $2`, [this.tenantId, input.handoffId]);

			return { handoff, removed: (result.rowCount ?? 0) > 0 };
		});
	}

	public async getHandoffDetails(entityId: string): Promise<HandoffDetails> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const focus = await getEntityOrThrow(client, this.tenantId, entityId);
			const structuralPath = await getStructuralPath(client, this.tenantId, entityId);
			const initiativeAncestor =
				focus.kind === "initiative" ? focus : (structuralPath.find((entry) => entry.entity.kind === "initiative")?.entity ?? null);

			const incomingResult = await client.query<EntityRow & { type: string }>(
				`SELECT relations.type, entities.*
				 FROM relations
				 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
				 WHERE relations.tenant_id = $1 AND relations.to_id = $2
				 ORDER BY entities.id`,
				[this.tenantId, entityId]
			);
			const outgoingResult = await client.query<EntityRow & { type: string }>(
				`SELECT relations.type, entities.*
				 FROM relations
				 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
				 WHERE relations.tenant_id = $1 AND relations.from_id = $2
				 ORDER BY entities.id`,
				[this.tenantId, entityId]
			);
			const statusMap = await getDerivedStatusMap(client, this.tenantId);
			const focusDetails: EntityDetails = {
				entity: applyDerivedStatus(focus, statusMap),
				incoming: incomingResult.rows.map((row) => ({
					relationType: row.type as RelationType,
					entity: applyDerivedStatus(mapEntityRow(row), statusMap)
				})),
				outgoing: outgoingResult.rows.map((row) => ({
					relationType: row.type as RelationType,
					entity: applyDerivedStatus(mapEntityRow(row), statusMap)
				}))
			};

			return {
				focus: focusDetails,
				structuralPath,
				initiative: initiativeAncestor ? await this.getInitiativeBundle(initiativeAncestor.id) : null,
				orphaned: focus.kind !== "initiative" && initiativeAncestor === null,
				activeBlockers: focus.kind === "issue" ? await getActiveBlockingIssues(client, this.tenantId, focus.id) : [],
				handoffs: initiativeAncestor
					? await listHandoffsFiltered(client, this.tenantId, { initiativeId: initiativeAncestor.id })
					: await listHandoffsFiltered(client, this.tenantId, { entityId: focus.id })
			};
		});
	}

	public async listHandoffs(filter?: { initiativeId?: string; entityId?: string }): Promise<HandoffRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listHandoffsFiltered(client, this.tenantId, filter));
	}

	public async close(): Promise<void> {
		await this.pool.end();
	}
}

export function openPgStore(pool: Pool, tenantId: string): PgStore {
	return new PgStore(pool, tenantId);
}
