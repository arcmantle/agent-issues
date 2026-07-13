import { randomUUID } from "node:crypto";

import {
	collectReachableIds,
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	deriveEntityKindFromId,
	deriveEntityStatuses,
	ENTITY_KINDS,
	factsMatchEntity,
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
	STRUCTURAL_RELATION_TYPES,
	wouldOrphanSubtree as wouldOrphanSubtreeInGraph,
	type BodySource,
	type ContextDetails,
	type DatabaseSnapshot,
	type DeleteResult,
	type EntityDetails,
	type EntityKind,
	type EntityRecord,
	type HandoffDeleteResult,
	type HandoffDetails,
	type HandoffRecord,
	type HistoryEntryRecord,
	type InitiativeBundle,
	type LinkResult,
	type MoveResult,
	type RelationRecord,
	type RelationType,
	type StatusUpdateResult,
	type UnlinkResult
} from "@agent-issues/core";
import type { PoolClient } from "pg";

import { queryContextDetails } from "../context/pg-context-store.js";

export type EntityRow = {
	id: string;
	kind: string;
	title: string;
	status: string;
	body: string;
	body_source: string | null;
	created_at: string;
	updated_at: string;
};

export type RelationRow = {
	from_id: string;
	to_id: string;
	type: string;
	created_at: string;
};

export type HistoryEntryRow = {
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

export type HandoffRow = {
	id: string;
	entity_id: string;
	initiative_id: string | null;
	summary: string;
	body: string;
	created_at: string;
};

/**
 * Seeds a fresh cloud tenant (per-kind id counters + the PROJ0/EPIC0
 * sentinels the full-chain invariant requires, ADR7) so `createEntity` has
 * somewhere to attach a parent-less initiative, exactly like the context
 * feature's `getOrCreateProjectByIdentity` and local's `SqliteStore`
 * bootstrap (`ensureTenantCounters` / `ensureFullChainInvariant` in core's
 * `database.ts`). No legacy-data import or backup step applies here: a
 * cloud tenant starts empty.
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

export function mapEntityRow(row: EntityRow): EntityRecord {
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

export async function getEntityOrThrow(client: PoolClient, tenantId: string, entityId: string): Promise<EntityRecord> {
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

export async function nextEntityId(client: PoolClient, tenantId: string, kind: EntityKind): Promise<string> {
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

// Bumps `kind`'s id counter past `entityId`'s numeric suffix if needed, so a
// later local `createEntity` of that kind can never collide with an id that
// arrived via synchronize instead of this side's own counter (ISS59).
async function bumpCounterPast(client: PoolClient, tenantId: string, kind: EntityKind, entityId: string): Promise<void> {
	const numericSuffix = Number(entityId.slice(ID_PREFIX[kind].length));
	if (!Number.isFinite(numericSuffix)) {
		return;
	}

	await client.query(`UPDATE counters SET next_value = GREATEST(next_value, $1) WHERE tenant_id = $2 AND kind = $3`, [
		numericSuffix + 1,
		tenantId,
		kind
	]);
}

// Reconciles `entityId`'s structural parent relation to `newParentId` (see
// core's `reconcileStructuralParent` for the full rationale). The parent
// must already exist locally by the time this runs - `applyResolvedFacts`
// ensures parents before children.
async function reconcileStructuralParent(
	client: PoolClient,
	tenantId: string,
	entityId: string,
	kind: EntityKind,
	newParentId: string | null
): Promise<void> {
	const currentParents = await getStructuralParentRelations(client, tenantId, entityId);
	const currentParentId = currentParents[0]?.fromId ?? null;

	if (currentParentId === newParentId) {
		return;
	}

	for (const relation of currentParents) {
		await client.query(`DELETE FROM relations WHERE tenant_id = $1 AND from_id = $2 AND to_id = $3 AND type = $4`, [
			tenantId,
			relation.fromId,
			entityId,
			relation.type
		]);
	}

	if (!newParentId) {
		return;
	}

	const parent = await getEntityOrThrow(client, tenantId, newParentId);
	const relationType = getAllowedRelationType(parent.kind, kind);
	if (!relationType) {
		throw new Error(`Cannot resolve ${entityId} under ${parent.kind} via synchronize: no allowed relation from ${parent.kind} to ${kind}.`);
	}

	await insertRelation(client, tenantId, { fromId: parent.id, toId: entityId, type: relationType, createdAt: new Date().toISOString() });
}

async function hasTypedPath(client: PoolClient, tenantId: string, startId: string, targetId: string, relationType: string): Promise<boolean> {
	const relations = (await getAllRelations(client, tenantId)).filter((relation) => relation.type === relationType);
	return collectReachableIds(relations, startId).has(targetId);
}

async function hasStructuralPath(client: PoolClient, tenantId: string, startId: string, targetId: string): Promise<boolean> {
	const relations = (await getAllRelations(client, tenantId)).filter((relation) => isStructuralRelationType(relation.type));
	return collectReachableIds(relations, startId).has(targetId);
}

async function wouldOrphanSubtree(client: PoolClient, tenantId: string, relation: RelationRecord): Promise<boolean> {
	const [relations, entities] = await Promise.all([getAllRelations(client, tenantId), getAllEntities(client, tenantId)]);
	return wouldOrphanSubtreeInGraph(entities, relations, relation);
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

export async function createEntity(
	client: PoolClient,
	tenantId: string,
	input: { kind: string; title: string; parentId?: string; status?: string; body?: string; author?: string }
): Promise<EntityRecord> {
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

	// Idempotent (ON CONFLICT DO NOTHING); simplifies this slice by not
	// requiring a separate tenant-bootstrap lifecycle step. SqliteStore
	// bootstraps once at open() instead - worth converging on later.
	await ensurePgTenant(client, tenantId);

	const now = new Date().toISOString();
	const parentId = input.parentId ?? (kind === "initiative" ? DEFAULT_EPIC_ID : undefined);
	const parent = parentId ? await getEntityOrThrow(client, tenantId, parentId) : null;
	const relationType = parent ? getAllowedRelationType(parent.kind, kind) : null;

	if (parent && !relationType) {
		throw new Error(`Cannot create ${kind} under ${parent.kind}.`);
	}

	const id = await nextEntityId(client, tenantId, kind);
	await client.query(
		`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
		[tenantId, id, kind, title, status, body, bodySource, now]
	);

	if (parent && relationType) {
		await client.query(
			`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
			[tenantId, parent.id, id, relationType, now]
		);
	}

	const entity = await getEntityOrThrow(client, tenantId, id);
	await appendHistoryEntry(client, tenantId, entity, input.author);
	return entity;
}

export async function getEntityDetails(client: PoolClient, tenantId: string, entityId: string): Promise<EntityDetails> {
	const entity = await getEntityOrThrow(client, tenantId, entityId);

	const incomingResult = await client.query<EntityRow & { type: string }>(
		`SELECT relations.type, entities.*
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		 WHERE relations.tenant_id = $1 AND relations.to_id = $2
		 ORDER BY entities.id`,
		[tenantId, entityId]
	);
	const outgoingResult = await client.query<EntityRow & { type: string }>(
		`SELECT relations.type, entities.*
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		 WHERE relations.tenant_id = $1 AND relations.from_id = $2
		 ORDER BY entities.id`,
		[tenantId, entityId]
	);

	const statusMap = await getDerivedStatusMap(client, tenantId);

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
}

export async function listEntities(client: PoolClient, tenantId: string, kind: string): Promise<EntityRecord[]> {
	if (!isEntityKind(kind)) {
		throw new Error(`Unknown entity kind: ${kind}`);
	}

	const entities = deriveEntityStatuses(await getAllEntities(client, tenantId), await getAllRelations(client, tenantId));
	return entities.filter((entity) => entity.kind === kind);
}

export async function listEntityHistory(client: PoolClient, tenantId: string, entityId: string): Promise<HistoryEntryRecord[]> {
	const result = await client.query<HistoryEntryRow>(
		`SELECT * FROM history_entries WHERE tenant_id = $1 AND entity_id = $2 ORDER BY version ASC`,
		[tenantId, entityId]
	);
	return result.rows.map(mapHistoryEntryRow);
}

// Every history entry for the tenant, across every entity (ISS57/ADR16):
// the read half of synchronize's merge substrate.
export async function listAllHistoryEntries(client: PoolClient, tenantId: string): Promise<HistoryEntryRecord[]> {
	const result = await client.query<HistoryEntryRow>(`SELECT * FROM history_entries WHERE tenant_id = $1`, [tenantId]);
	return result.rows.map(mapHistoryEntryRow);
}

// The write half of synchronize's merge substrate (ISS57/ADR16): idempotent
// by the entry's own globally-unique `id`, so re-applying the same (or a
// superset) batch is a true no-op.
export async function applyHistoryEntries(
	client: PoolClient,
	tenantId: string,
	entries: HistoryEntryRecord[]
): Promise<{ inserted: number }> {
	let inserted = 0;
	for (const entry of entries) {
		const result = await client.query(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			 ON CONFLICT (id) DO NOTHING`,
			[
				entry.id,
				tenantId,
				entry.entityId,
				entry.version,
				entry.author,
				entry.title,
				entry.body,
				entry.bodySource,
				entry.status,
				entry.parentId,
				entry.createdAt
			]
		);
		inserted += result.rowCount ?? 0;
	}
	return { inserted };
}

// The live-cache write half of synchronize's merge (ISS59/ADR16): see
// core's `applyResolvedFacts` for the full rationale (no new history entry,
// idempotent no-op when facts already match, create-on-first-sight with
// kind derived from id, parents resolved before children).
export async function applyResolvedFacts(
	client: PoolClient,
	tenantId: string,
	resolvedEntries: HistoryEntryRecord[]
): Promise<{ created: string[]; updated: string[] }> {
	const resolvedByEntity = new Map(resolvedEntries.map((entry) => [entry.entityId, entry]));
	const created: string[] = [];
	const updated: string[] = [];
	const settled = new Set<string>();

	const ensureEntity = async (entityId: string, visiting: Set<string>): Promise<void> => {
		if (settled.has(entityId)) {
			return;
		}

		const resolved = resolvedByEntity.get(entityId);
		if (!resolved) {
			settled.add(entityId);
			return;
		}

		if (visiting.has(entityId)) {
			throw new Error(`Cycle detected while resolving structural parent chain for ${entityId}.`);
		}

		if (resolved.parentId) {
			visiting.add(entityId);
			await ensureEntity(resolved.parentId, visiting);
			visiting.delete(entityId);
		}

		const existingResult = await client.query<EntityRow>(`SELECT * FROM entities WHERE tenant_id = $1 AND id = $2`, [
			tenantId,
			entityId
		]);
		const existingRow = existingResult.rows[0];

		if (existingRow) {
			const existing = mapEntityRow(existingRow);
			if (!factsMatchEntity(existing, resolved)) {
				await client.query(
					`UPDATE entities SET title = $1, status = $2, body = $3, body_source = $4, updated_at = $5 WHERE tenant_id = $6 AND id = $7`,
					[resolved.title, resolved.status, resolved.body, resolved.bodySource, resolved.createdAt, tenantId, entityId]
				);
				await reconcileStructuralParent(client, tenantId, entityId, existing.kind, resolved.parentId);
				updated.push(entityId);
			}
		} else {
			const kind = deriveEntityKindFromId(entityId);
			await client.query(
				`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
				[tenantId, entityId, kind, resolved.title, resolved.status, resolved.body, resolved.bodySource, resolved.createdAt]
			);

			await bumpCounterPast(client, tenantId, kind, entityId);

			if (resolved.parentId) {
				await reconcileStructuralParent(client, tenantId, entityId, kind, resolved.parentId);
			}

			created.push(entityId);
		}

		settled.add(entityId);
	};

	for (const entityId of resolvedByEntity.keys()) {
		await ensureEntity(entityId, new Set());
	}

	return { created, updated };
}

// Excludes only the ONE relation row each entity's `reconcileStructuralParent`
// will already reconstruct from its resolved `parentId` - i.e. a
// structural-type row whose `from_id` equals `to_id`'s own latest
// `parent_id`. Everything else is included, even a row of a nominally-
// structural type: a structural type like "decomposes" can also be created
// directly via `link` as a plain annotation alongside an entity's real
// structural parent (e.g. an issue tracked by an initiative that's *also*
// manually linked as "decomposed by" another issue) - `reconcileStructuralParent`
// tolerates that extra row but never reconstructs it, so it needs its own
// sync primitive just like "blocks"/"fixes" do (see core's `listAllRelations`
// for the identical SQLite-side logic).
export async function listAllRelations(client: PoolClient, tenantId: string): Promise<RelationRecord[]> {
	const result = await client.query<RelationRow>(
		`SELECT r.* FROM relations r WHERE r.tenant_id = $1
		 AND NOT (
		   r.type = ANY($2::text[])
		   AND r.from_id = (
		     SELECT h.parent_id FROM history_entries h
		     WHERE h.tenant_id = r.tenant_id AND h.entity_id = r.to_id
		     ORDER BY h.version DESC LIMIT 1
		   )
		 )`,
		[tenantId, STRUCTURAL_RELATION_TYPES]
	);
	return result.rows.map((row) => ({ fromId: row.from_id, toId: row.to_id, type: row.type as RelationType, createdAt: row.created_at }));
}

// The write half of the relations sync seam (ISS60/ADR16): idempotent via
// `insertRelation`'s own `ON CONFLICT DO NOTHING`, keyed on the table's
// primary key (tenant_id, from_id, to_id, type).
export async function applyRelations(client: PoolClient, tenantId: string, relations: RelationRecord[]): Promise<{ inserted: number }> {
	let inserted = 0;
	for (const relation of relations) {
		const { inserted: wasInserted } = await insertRelation(client, tenantId, relation);
		if (wasInserted) {
			inserted += 1;
		}
	}
	return { inserted };
}

export async function linkEntities(
	client: PoolClient,
	tenantId: string,
	input: { fromId: string; toId: string; relationType: string }
): Promise<LinkResult> {
	if (input.fromId === input.toId) {
		throw new Error("Cannot create a relation from an entity to itself.");
	}

	const from = await getEntityOrThrow(client, tenantId, input.fromId);
	const to = await getEntityOrThrow(client, tenantId, input.toId);

	if (!isAllowedRelation(from.kind, to.kind, input.relationType)) {
		throw new Error(`Relation ${input.relationType} is not allowed from ${from.kind} to ${to.kind}.`);
	}

	if (
		(input.relationType === "blocks" || input.relationType === "supersedes") &&
		(await hasTypedPath(client, tenantId, to.id, from.id, input.relationType))
	) {
		throw new Error(`Linking ${from.id} -> ${to.id} as ${input.relationType} would create a cycle.`);
	}

	const createdAt = new Date().toISOString();
	const relation: RelationRecord = { fromId: from.id, toId: to.id, type: input.relationType as RelationType, createdAt };
	const { inserted } = await insertRelation(client, tenantId, relation);

	return { relation, created: inserted };
}

export async function unlinkEntities(
	client: PoolClient,
	tenantId: string,
	input: { fromId: string; toId: string; relationType: string }
): Promise<UnlinkResult> {
	const relation = await getRelationOrThrow(client, tenantId, input);

	if (await wouldOrphanSubtree(client, tenantId, relation)) {
		throw new Error(
			`Unlinking ${relation.fromId} -> ${relation.toId} as ${relation.type} would orphan a subtree. Relink or delete descendants first.`
		);
	}

	if (await wouldBreakFullChainInvariant(client, tenantId, relation)) {
		const target = await getEntityOrThrow(client, tenantId, relation.toId);
		throw new Error(
			`Cannot unlink ${relation.fromId} -> ${relation.toId} as ${relation.type}: it is the only remaining structural parent, and every ${target.kind} must have one.`
		);
	}

	const result = await client.query(
		`DELETE FROM relations WHERE tenant_id = $1 AND from_id = $2 AND to_id = $3 AND type = $4`,
		[tenantId, relation.fromId, relation.toId, relation.type]
	);

	return { relation, removed: (result.rowCount ?? 0) > 0 };
}

export async function updateEntityStatus(
	client: PoolClient,
	tenantId: string,
	input: { entityId: string; status: string; author?: string }
): Promise<StatusUpdateResult> {
	const entity = await getEntityOrThrow(client, tenantId, input.entityId);

	if (!isValidStatus(entity.kind, input.status)) {
		throw new Error(`Invalid status for ${entity.kind}: ${input.status}`);
	}

	if (entity.kind === "userStory") {
		const fixingIssueStatuses = await getFixingIssueStatuses(client, tenantId, entity.id);
		if (fixingIssueStatuses.length > 0) {
			throw new Error(`${entity.id} status is derived from its fixing issues; update those issues instead of setting it directly.`);
		}
	}

	if (entity.kind === "prd") {
		const createdStoryStatuses = await getCreatedStoryStatuses(client, tenantId, entity.id);
		if (createdStoryStatuses.length > 0) {
			throw new Error(`${entity.id} status is derived from its user stories; update the underlying issues instead of setting it directly.`);
		}
	}

	if (entity.kind === "adr") {
		if (await isAdrSuperseded(client, tenantId, entity.id)) {
			throw new Error(`${entity.id} status is derived (superseded) because another ADR supersedes it.`);
		}
		if ((await getConstrainedIssueStatuses(client, tenantId, entity.id)).length > 0) {
			throw new Error(`${entity.id} status is derived from the issues it constrains; update those issues instead of setting it directly.`);
		}
	}

	if (entity.kind === "initiative") {
		const { trackedIssueStatuses, ownedPrdStatuses } = await getInitiativeChildStatuses(client, tenantId, entity.id);
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
		const openSubIssues = await getOpenSubIssues(client, tenantId, entity.id);
		if (openSubIssues.length > 0) {
			throw new Error(
				`Cannot set ${entity.id} to ${input.status} while sub-issues remain open: ${openSubIssues.map((issue) => issue.id).join(", ")}.`
			);
		}

		const blockingIssues = await getActiveBlockingIssues(client, tenantId, entity.id);
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
		tenantId,
		input.entityId
	]);

	const updated = await getEntityOrThrow(client, tenantId, input.entityId);
	await appendHistoryEntry(client, tenantId, updated, input.author);

	return { entity: updated, previousStatus };
}

export async function setEntityBody(
	client: PoolClient,
	tenantId: string,
	input: { entityId: string; body: string; bodySource?: BodySource; author?: string }
): Promise<EntityRecord> {
	await getEntityOrThrow(client, tenantId, input.entityId);

	const updatedAt = new Date().toISOString();
	const bodySource = input.bodySource ?? "authored";

	await client.query(`UPDATE entities SET body = $1, body_source = $2, updated_at = $3 WHERE tenant_id = $4 AND id = $5`, [
		input.body,
		bodySource,
		updatedAt,
		tenantId,
		input.entityId
	]);

	const updated = await getEntityOrThrow(client, tenantId, input.entityId);
	await appendHistoryEntry(client, tenantId, updated, input.author);
	return updated;
}

export async function archiveEntity(client: PoolClient, tenantId: string, input: { entityId: string }): Promise<StatusUpdateResult> {
	const entity = await getEntityOrThrow(client, tenantId, input.entityId);
	return updateEntityStatus(client, tenantId, { entityId: input.entityId, status: getArchiveStatus(entity.kind) });
}

export async function moveEntity(
	client: PoolClient,
	tenantId: string,
	input: { entityId: string; newParentId: string; author?: string }
): Promise<MoveResult> {
	if (input.entityId === input.newParentId) {
		throw new Error("Cannot move an entity under itself.");
	}

	const entity = await getEntityOrThrow(client, tenantId, input.entityId);
	const newParent = await getEntityOrThrow(client, tenantId, input.newParentId);

	const relationType = getAllowedRelationType(newParent.kind, entity.kind);
	if (!relationType || !isStructuralRelationType(relationType)) {
		throw new Error(`Cannot move ${entity.kind} under ${newParent.kind}.`);
	}

	const currentParentRelations = await getStructuralParentRelations(client, tenantId, entity.id);
	if (currentParentRelations.length > 1) {
		throw new Error(`Cannot move ${entity.id} because it has multiple structural parents.`);
	}

	if (await hasStructuralPath(client, tenantId, entity.id, newParent.id)) {
		throw new Error(`Cannot move ${entity.id} under ${newParent.id} because that would create a cycle.`);
	}

	const previousParentId = currentParentRelations[0]?.fromId ?? null;
	if (previousParentId === newParent.id && currentParentRelations[0]?.type === relationType) {
		return { entity, previousParentId, newParentId: newParent.id, relationType };
	}

	const updatedAt = new Date().toISOString();

	for (const relation of currentParentRelations) {
		await client.query(`DELETE FROM relations WHERE tenant_id = $1 AND from_id = $2 AND to_id = $3 AND type = $4`, [
			tenantId,
			relation.fromId,
			relation.toId,
			relation.type
		]);
	}

	await insertRelation(client, tenantId, { fromId: newParent.id, toId: entity.id, type: relationType, createdAt: updatedAt });

	await client.query(`UPDATE entities SET updated_at = $1 WHERE tenant_id = $2 AND id = $3`, [updatedAt, tenantId, entity.id]);

	await appendHistoryEntry(client, tenantId, await getEntityOrThrow(client, tenantId, entity.id), input.author);

	return {
		entity: await getEntityOrThrow(client, tenantId, entity.id),
		previousParentId,
		newParentId: newParent.id,
		relationType
	};
}

export async function deleteEntity(client: PoolClient, tenantId: string, input: { entityId: string }): Promise<DeleteResult> {
	const entity = await getEntityOrThrow(client, tenantId, input.entityId);

	const outgoingResult = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM relations WHERE tenant_id = $1 AND from_id = $2`, [
		tenantId,
		input.entityId
	]);
	if (Number(outgoingResult.rows[0]?.count ?? "0") > 0) {
		throw new Error(`Cannot delete ${entity.id} while it still has outgoing relations. Unlink or delete dependents first.`);
	}

	const result = await client.query(`DELETE FROM entities WHERE tenant_id = $1 AND id = $2`, [tenantId, input.entityId]);

	return { entity, removed: (result.rowCount ?? 0) > 0 };
}

export async function listOrphans(client: PoolClient, tenantId: string, kind?: string): Promise<EntityRecord[]> {
	if (kind && !isEntityKind(kind)) {
		throw new Error(`Unknown entity kind: ${kind}`);
	}

	const entities = await getAllEntities(client, tenantId);
	const relations = await getAllRelations(client, tenantId);
	const reachable = new Set<string>();

	for (const entity of entities) {
		if (entity.kind !== "initiative") {
			continue;
		}

		for (const id of collectReachableIds(relations, entity.id)) {
			reachable.add(id);
		}
	}

	const statusMap = await getDerivedStatusMap(client, tenantId);
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
}

export async function listProjectAdrs(client: PoolClient, tenantId: string): Promise<EntityRecord[]> {
	const entities = await getAllEntities(client, tenantId);
	const relations = await getAllRelations(client, tenantId);
	const childIds = new Set(relations.filter((relation) => isStructuralRelationType(relation.type)).map((relation) => relation.toId));

	return entities.filter((entity) => entity.kind === "adr" && !childIds.has(entity.id));
}

export async function getInitiativeBundle(client: PoolClient, tenantId: string, initiativeId: string): Promise<InitiativeBundle> {
	const initiative = await getEntityOrThrow(client, tenantId, initiativeId);
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
		[initiativeId, tenantId]
	);
	const reachableIds = reachableResult.rows.map((row) => row.id);

	const entityRows = await client.query<EntityRow>(
		`SELECT * FROM entities WHERE tenant_id = $1 AND id = ANY($2::text[]) ORDER BY id`,
		[tenantId, reachableIds]
	);
	const relationRows = await client.query<RelationRow>(
		`SELECT * FROM relations WHERE tenant_id = $1 AND from_id = ANY($2::text[]) AND to_id = ANY($2::text[])`,
		[tenantId, reachableIds]
	);

	const entities = entityRows.rows.map(mapEntityRow);
	const statusMap = await getDerivedStatusMap(client, tenantId);
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
		handoffs: await listHandoffsFiltered(client, tenantId, { initiativeId: initiative.id })
	};
}

export async function getDatabaseSnapshot(client: PoolClient, tenantId: string, projectIdentity: string | undefined): Promise<DatabaseSnapshot> {
	const entities = await getAllDerivedEntities(client, tenantId);
	const relations = await getAllRelations(client, tenantId);
	const initiatives = entities.filter((entity) => entity.kind === "initiative");

	const orphans = await listOrphans(client, tenantId);
	const projectAdrs = await listProjectAdrs(client, tenantId);
	const initiativeBundles = await Promise.all(initiatives.map((entity) => getInitiativeBundle(client, tenantId, entity.id)));

	const sharedContext: ContextDetails = await queryContextDetails(client, tenantId, projectIdentity);
	const initiativeContexts = await Promise.all(
		initiatives.map((entity) => queryContextDetails(client, tenantId, projectIdentity, entity.id))
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
}

// A cheap aggregate signature of this tenant's own data (ISS191): unlike
// SqliteStore's whole-file stat (one sqlite file can span tenants),
// Postgres RLS already scopes every query below to this tenant alone, so
// count + max(updated_at) per table is both cheap and sufficient - any
// entity/context/term write bumps one of these, and cloud's site never
// actually polls this today (it relies on `change-events.ts`'s push
// broadcast instead), so this exists purely to satisfy the shared seam.
export async function getSnapshotSignature(client: PoolClient, tenantId: string): Promise<string> {
	const result = await client.query<{
		entity_count: string;
		entity_max_updated: string | null;
		relation_count: string;
		context_count: string;
		context_max_updated: string | null;
		term_count: string;
		term_max_updated: string | null;
	}>(
		`SELECT
		   (SELECT count(*) FROM entities WHERE tenant_id = $1) AS entity_count,
		   (SELECT max(updated_at) FROM entities WHERE tenant_id = $1) AS entity_max_updated,
		   (SELECT count(*) FROM relations WHERE tenant_id = $1) AS relation_count,
		   (SELECT count(*) FROM contexts WHERE tenant_id = $1) AS context_count,
		   (SELECT max(updated_at) FROM contexts WHERE tenant_id = $1) AS context_max_updated,
		   (SELECT count(*) FROM context_terms WHERE tenant_id = $1) AS term_count,
		   (SELECT max(updated_at) FROM context_terms WHERE tenant_id = $1) AS term_max_updated`,
		[tenantId]
	);
	const row = result.rows[0]!;
	return [
		`entities:${row.entity_count}:${row.entity_max_updated}`,
		`relations:${row.relation_count}`,
		`contexts:${row.context_count}:${row.context_max_updated}`,
		`terms:${row.term_count}:${row.term_max_updated}`
	].join("|");
}

export async function createHandoff(
	client: PoolClient,
	tenantId: string,
	input: { entityId: string; summary?: string; body: string }
): Promise<HandoffRecord> {
	const summary = normalizeHandoffSummary(input.summary);
	const body = normalizeHandoffBody(input.body);

	const focus = await getEntityOrThrow(client, tenantId, input.entityId);
	const initiativeId = await resolveOwningInitiativeId(client, tenantId, focus);
	const now = new Date().toISOString();
	const id = await nextHandoffId(client, tenantId);

	await client.query(
		`INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[tenantId, id, focus.id, initiativeId, summary, body, now]
	);

	return getHandoffOrThrow(client, tenantId, id);
}

export async function updateHandoff(
	client: PoolClient,
	tenantId: string,
	input: { handoffId: string; summary?: string; body?: string }
): Promise<HandoffRecord> {
	if (input.summary === undefined && input.body === undefined) {
		throw new Error("Provide --summary, --body, or --body-file to update a handoff.");
	}

	const current = await getHandoffOrThrow(client, tenantId, input.handoffId);
	const summary = input.summary === undefined ? current.summary : normalizeHandoffSummary(input.summary);
	const body = input.body === undefined ? current.body : normalizeHandoffBody(input.body);

	await client.query(`UPDATE handoffs SET summary = $1, body = $2 WHERE tenant_id = $3 AND id = $4`, [
		summary,
		body,
		tenantId,
		input.handoffId
	]);

	return getHandoffOrThrow(client, tenantId, input.handoffId);
}

export async function deleteHandoff(client: PoolClient, tenantId: string, input: { handoffId: string }): Promise<HandoffDeleteResult> {
	const handoff = await getHandoffOrThrow(client, tenantId, input.handoffId);
	const result = await client.query(`DELETE FROM handoffs WHERE tenant_id = $1 AND id = $2`, [tenantId, input.handoffId]);

	return { handoff, removed: (result.rowCount ?? 0) > 0 };
}

export async function getHandoffDetails(client: PoolClient, tenantId: string, entityId: string): Promise<HandoffDetails> {
	const focus = await getEntityOrThrow(client, tenantId, entityId);
	const structuralPath = await getStructuralPath(client, tenantId, entityId);
	const initiativeAncestor =
		focus.kind === "initiative" ? focus : (structuralPath.find((entry) => entry.entity.kind === "initiative")?.entity ?? null);

	const incomingResult = await client.query<EntityRow & { type: string }>(
		`SELECT relations.type, entities.*
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		 WHERE relations.tenant_id = $1 AND relations.to_id = $2
		 ORDER BY entities.id`,
		[tenantId, entityId]
	);
	const outgoingResult = await client.query<EntityRow & { type: string }>(
		`SELECT relations.type, entities.*
		 FROM relations
		 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		 WHERE relations.tenant_id = $1 AND relations.from_id = $2
		 ORDER BY entities.id`,
		[tenantId, entityId]
	);
	const statusMap = await getDerivedStatusMap(client, tenantId);
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
		initiative: initiativeAncestor ? await getInitiativeBundle(client, tenantId, initiativeAncestor.id) : null,
		orphaned: focus.kind !== "initiative" && initiativeAncestor === null,
		activeBlockers: focus.kind === "issue" ? await getActiveBlockingIssues(client, tenantId, focus.id) : [],
		handoffs: initiativeAncestor
			? await listHandoffsFiltered(client, tenantId, { initiativeId: initiativeAncestor.id })
			: await listHandoffsFiltered(client, tenantId, { entityId: focus.id })
	};
}

export async function listHandoffs(
	client: PoolClient,
	tenantId: string,
	filter?: { initiativeId?: string; entityId?: string }
): Promise<HandoffRecord[]> {
	return listHandoffsFiltered(client, tenantId, filter);
}

// The read half of synchronize's handoff sync (ISS62/ADR16): every handoff
// this tenant has, with no filter. Same "no version log, plain union"
// rationale as `listAllRelations` - see core's identical SQLite-side logic.
export async function listAllHandoffs(client: PoolClient, tenantId: string): Promise<HandoffRecord[]> {
	const result = await client.query<HandoffRow>(`SELECT * FROM handoffs WHERE tenant_id = $1`, [tenantId]);
	return result.rows.map(mapHandoffRow);
}

// The write half (ISS62/ADR16): idempotently inserts whatever handoffs this
// tenant doesn't already have, keyed by the table's own primary key
// (tenant_id, id). Must run after `applyResolvedFacts` in synchronize's
// orchestration, so both `entity_id`/`initiative_id` FK targets already
// exist as entities on this side.
export async function applyHandoffs(client: PoolClient, tenantId: string, handoffs: HandoffRecord[]): Promise<{ inserted: number }> {
	let inserted = 0;
	for (const handoff of handoffs) {
		const result = await client.query(
			`INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT DO NOTHING`,
			[tenantId, handoff.id, handoff.entityId, handoff.initiativeId, handoff.summary, handoff.body, handoff.createdAt]
		);
		inserted += result.rowCount ?? 0;
	}
	return { inserted };
}
