import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
	collectReachableIds,
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	assignEntitiesToProjects,
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
	type HistoryEntryRecord,
	type InitiativeBundle,
	type LinkResult,
	type MoveResult,
	type ProjectDiscovery,
	type ProjectSnapshot,
	type RelationRecord,
	type RelationType,
	type StatusUpdateResult,
	type UnlinkResult
} from "@agent-issues/core";
import type { TenantExecutor as PoolClient } from "../../db/connection.js";
import { counters, entities, historyEntries, relations } from "../../schema.js";

import { queryContextDetails, queryProjectContextDetails } from "../context/pg-context-store.js";

export type EntityRow = {
	id: string;
	kind: string;
	title: string;
	status: string;
	body: string;
	body_source: string | null;
	project_id: string | null;
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
	for (const kind of ENTITY_KINDS) {
		await client.insert(counters).values({ tenantId, kind, nextValue: 1 }).onConflictDoNothing();
	}

	const now = new Date().toISOString();
	await client
		.insert(entities)
		.values({
			tenantId,
			id: DEFAULT_PROJECT_ID,
			kind: "project",
			title: DEFAULT_PROJECT_TITLE,
			status: "active",
			body: "",
			bodySource: "generated",
			projectId: DEFAULT_PROJECT_ID,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing();
	await client
		.insert(entities)
		.values({
			tenantId,
			id: DEFAULT_EPIC_ID,
			kind: "epic",
			title: DEFAULT_EPIC_TITLE,
			status: "active",
			body: "",
			bodySource: "generated",
			projectId: DEFAULT_PROJECT_ID,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing();
	await client
		.insert(relations)
		.values({ tenantId, fromId: DEFAULT_PROJECT_ID, toId: DEFAULT_EPIC_ID, type: "contains", createdAt: now })
		.onConflictDoNothing();
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

function mapDrizzleEntityRow(row: typeof entities.$inferSelect): EntityRecord {
	return {
		id: row.id,
		kind: row.kind as EntityKind,
		title: row.title,
		status: row.status,
		body: row.body,
		bodySource: isBodySource(row.bodySource) ? row.bodySource : "authored",
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
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
	const [row] = await client
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, entityId)));

	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return mapDrizzleEntityRow(row);
}

async function getStructuralParentRelations(client: PoolClient, tenantId: string, entityId: string): Promise<RelationRecord[]> {
	const rows = await client
		.select()
		.from(relations)
		.where(and(eq(relations.tenantId, tenantId), eq(relations.toId, entityId)))
		.orderBy(asc(relations.fromId), asc(relations.type));

	return rows
		.filter((row) => isStructuralRelationType(row.type))
		.map((row) => ({ fromId: row.fromId, toId: row.toId, type: row.type as RelationType, createdAt: row.createdAt }));
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
	const [row] = await client
		.select({ nextValue: counters.nextValue })
		.from(counters)
		.where(and(eq(counters.tenantId, tenantId), eq(counters.kind, kind)));

	if (!row) {
		throw new Error(`Counter missing for entity kind: ${kind}`);
	}

	await client
		.update(counters)
		.set({ nextValue: sql`${counters.nextValue} + 1` })
		.where(and(eq(counters.tenantId, tenantId), eq(counters.kind, kind)));
	return `${ID_PREFIX[kind]}${row.nextValue}`;
}

async function getNextHistoryVersion(client: PoolClient, tenantId: string, entityId: string): Promise<number> {
	const [row] = await client
		.select({ maxVersion: sql<number | null>`max(${historyEntries.version})` })
		.from(historyEntries)
		.where(and(eq(historyEntries.tenantId, tenantId), eq(historyEntries.entityId, entityId)));

	return (row?.maxVersion ?? 0) + 1;
}

// Appends a full snapshot of `entity`'s current trackable facts as the next
// history version (ADR8), mirroring `appendHistoryEntry` in core's
// `store.ts` so both backends share the same append-only write path.
async function appendHistoryEntry(client: PoolClient, tenantId: string, entity: EntityRecord, author: string | undefined): Promise<void> {
	const parentId = (await getStructuralParentRelations(client, tenantId, entity.id))[0]?.fromId ?? null;
	const version = await getNextHistoryVersion(client, tenantId, entity.id);

	await client.insert(historyEntries).values({
		id: randomUUID(),
		tenantId,
		entityId: entity.id,
		version,
		author: author?.trim() || RESERVED_SYSTEM_AUTHOR,
		title: entity.title,
		body: entity.body,
		bodySource: entity.bodySource,
		status: entity.status,
		parentId,
		createdAt: entity.updatedAt
	});
}

async function getAllEntities(client: PoolClient, tenantId: string): Promise<EntityRecord[]> {
	const rows = await client.select().from(entities).where(eq(entities.tenantId, tenantId));
	return rows.map(mapDrizzleEntityRow);
}

async function getAllRelations(client: PoolClient, tenantId: string): Promise<RelationRecord[]> {
	const rows = await client.select().from(relations).where(eq(relations.tenantId, tenantId));
	return rows.map((row) => ({ fromId: row.fromId, toId: row.toId, type: row.type as RelationType, createdAt: row.createdAt }));
}

async function getDerivedStatusMap(client: PoolClient, tenantId: string): Promise<Map<string, string>> {
	const entities = deriveEntityStatuses(await getAllEntities(client, tenantId), await getAllRelations(client, tenantId));
	return new Map(entities.map((entity) => [entity.id, entity.status]));
}

function applyDerivedStatus(entity: EntityRecord, statusMap: ReadonlyMap<string, string>): EntityRecord {
	const derived = statusMap.get(entity.id);
	return derived === undefined || derived === entity.status ? entity : { ...entity, status: derived };
}

async function getRelationOrThrow(
	client: PoolClient,
	tenantId: string,
	input: { fromId: string; toId: string; relationType: string }
): Promise<RelationRecord> {
	const [row] = await client
		.select()
		.from(relations)
		.where(
			and(
				eq(relations.tenantId, tenantId),
				eq(relations.fromId, input.fromId),
				eq(relations.toId, input.toId),
				eq(relations.type, input.relationType)
			)
		);

	if (!row) {
		throw new Error(`Relation not found: ${input.fromId} -> ${input.toId} as ${input.relationType}`);
	}

	return { fromId: row.fromId, toId: row.toId, type: row.type as RelationType, createdAt: row.createdAt };
}

async function insertRelation(client: PoolClient, tenantId: string, relation: RelationRecord): Promise<{ inserted: boolean }> {
	const inserted = await client
		.insert(relations)
		.values({ tenantId, fromId: relation.fromId, toId: relation.toId, type: relation.type, createdAt: relation.createdAt })
		.onConflictDoNothing()
		.returning({ fromId: relations.fromId });

	return { inserted: inserted.length > 0 };
}

// Bumps `kind`'s id counter past `entityId`'s numeric suffix if needed, so a
// later local `createEntity` of that kind can never collide with an id that
// arrived via synchronize instead of this side's own counter (ISS59).
async function bumpCounterPast(client: PoolClient, tenantId: string, kind: EntityKind, entityId: string): Promise<void> {
	const numericSuffix = Number(entityId.slice(ID_PREFIX[kind].length));
	if (!Number.isFinite(numericSuffix)) {
		return;
	}

	await client
		.update(counters)
		.set({ nextValue: sql`greatest(${counters.nextValue}, ${numericSuffix + 1})` })
		.where(and(eq(counters.tenantId, tenantId), eq(counters.kind, kind)));
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
		await client
			.delete(relations)
			.where(
				and(
					eq(relations.tenantId, tenantId),
					eq(relations.fromId, relation.fromId),
					eq(relations.toId, entityId),
					eq(relations.type, relation.type)
				)
			);
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

	const [result] = await client
		.select({ count: sql<number>`count(*)` })
		.from(relations)
		.where(
			and(
				eq(relations.tenantId, tenantId),
				eq(relations.toId, relation.toId),
				eq(relations.type, "contains"),
				sql`${relations.fromId} <> ${relation.fromId}`
			)
		);

	return Number(result?.count ?? 0) === 0;
}

async function getActiveBlockingIssues(client: PoolClient, tenantId: string, entityId: string): Promise<EntityRecord[]> {
	const result = await client.execute(sql`
		SELECT entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${tenantId}
			AND relations.type = 'blocks'
			AND relations.to_id = ${entityId}
			AND entities.status != 'done'
		ORDER BY entities.id
	`);

	return (result.rows as EntityRow[]).map(mapEntityRow);
}

async function getOpenSubIssues(client: PoolClient, tenantId: string, issueId: string): Promise<EntityRecord[]> {
	const statusMap = await getDerivedStatusMap(client, tenantId);
	const result = await client.execute(sql`
		SELECT entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${tenantId}
			AND relations.from_id = ${issueId}
			AND relations.type = 'decomposes'
		ORDER BY entities.id
	`);

	return (result.rows as EntityRow[])
		.map(mapEntityRow)
		.map((entity) => applyDerivedStatus(entity, statusMap))
		.filter((entity) => entity.status !== "done");
}

async function getFixingIssueStatuses(client: PoolClient, tenantId: string, storyId: string): Promise<string[]> {
	const result = await client.execute(sql`
		SELECT entities.status
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${tenantId}
			AND relations.type = 'fixes'
			AND relations.to_id = ${storyId}
			AND entities.kind = 'issue'
	`);

	return (result.rows as Array<{ status: string }>).map((row) => row.status);
}

async function getCreatedStoryStatuses(client: PoolClient, tenantId: string, prdId: string): Promise<string[]> {
	const statusMap = await getDerivedStatusMap(client, tenantId);
	const result = await client.execute(sql`
		SELECT entities.id
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${tenantId}
			AND relations.type = 'creates'
			AND relations.from_id = ${prdId}
			AND entities.kind = 'userStory'
	`);

	return (result.rows as Array<{ id: string }>).map((row) => statusMap.get(row.id) ?? "");
}

async function getConstrainedIssueStatuses(client: PoolClient, tenantId: string, adrId: string): Promise<string[]> {
	const result = await client.execute(sql`
		SELECT entities.status
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${tenantId}
			AND relations.type = 'constrains'
			AND relations.from_id = ${adrId}
			AND entities.kind = 'issue'
	`);

	return (result.rows as Array<{ status: string }>).map((row) => row.status);
}

async function isEntitySuperseded(
	client: PoolClient,
	tenantId: string,
	entityId: string,
	kind: "prd" | "userStory" | "adr"
): Promise<boolean> {
	const result = await client.execute(sql`
		SELECT 1
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${tenantId}
			AND relations.type = 'supersedes'
			AND relations.to_id = ${entityId}
			AND entities.kind = ${kind}
		LIMIT 1
	`);

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

export async function createEntity(
	client: PoolClient,
	tenantId: string,
	input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		author?: string;
		links?: Array<{ relationType: string; targetId: string }>;
	},
	projectIdentity?: string
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
	const inheritedProjectId = parent
		? await getEntityProjectId(client, tenantId, parent.id)
		: await resolveProjectIdForWrite(client, tenantId, projectIdentity);
	const projectId = kind === "project" ? id : inheritedProjectId;
	await client.insert(entities).values({
		tenantId,
		id,
		kind,
		title,
		status,
		body,
		bodySource,
		projectId,
		createdAt: now,
		updatedAt: now
	});

	if (parent && relationType) {
		await client
			.insert(relations)
			.values({ tenantId, fromId: parent.id, toId: id, type: relationType, createdAt: now })
			.onConflictDoNothing();
	}

	for (const link of input.links ?? []) {
		await linkEntities(client, tenantId, { fromId: id, relationType: link.relationType, toId: link.targetId });
	}

	const entity = await getEntityOrThrow(client, tenantId, id);
	await appendHistoryEntry(client, tenantId, entity, input.author);
	return entity;
}

export async function getEntityDetails(client: PoolClient, tenantId: string, entityId: string): Promise<EntityDetails> {
	const entity = await getEntityOrThrow(client, tenantId, entityId);

	const incomingResult = await client.execute(sql`
		SELECT relations.type, entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${tenantId} AND relations.to_id = ${entityId}
		ORDER BY entities.id
	`);
	const outgoingResult = await client.execute(sql`
		SELECT relations.type, entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${tenantId} AND relations.from_id = ${entityId}
		ORDER BY entities.id
	`);

	const statusMap = await getDerivedStatusMap(client, tenantId);

	return {
		entity: applyDerivedStatus(entity, statusMap),
		incoming: (incomingResult.rows as Array<EntityRow & { type: string }>).map((row) => ({
			relationType: row.type as RelationType,
			entity: applyDerivedStatus(mapEntityRow(row), statusMap)
		})),
		outgoing: (outgoingResult.rows as Array<EntityRow & { type: string }>).map((row) => ({
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
	const rows = await client
		.select()
		.from(historyEntries)
		.where(and(eq(historyEntries.tenantId, tenantId), eq(historyEntries.entityId, entityId)))
		.orderBy(asc(historyEntries.version));
	return rows.map((row) =>
		mapHistoryEntryRow({
			id: row.id,
			entity_id: row.entityId,
			version: row.version,
			author: row.author,
			title: row.title,
			body: row.body,
			body_source: row.bodySource,
			status: row.status,
			parent_id: row.parentId,
			created_at: row.createdAt
		})
	);
}

// Every history entry for the tenant, across every entity (ISS57/ADR16):
// the read half of synchronize's merge substrate.
export async function listAllHistoryEntries(client: PoolClient, tenantId: string): Promise<HistoryEntryRecord[]> {
	const result = await client.execute(sql`SELECT * FROM history_entries WHERE tenant_id = ${tenantId}`);
	return (result.rows as HistoryEntryRow[]).map(mapHistoryEntryRow);
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
		const result = await client.execute(sql`
			INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			VALUES (${entry.id}, ${tenantId}, ${entry.entityId}, ${entry.version}, ${entry.author}, ${entry.title}, ${entry.body}, ${entry.bodySource}, ${entry.status}, ${entry.parentId}, ${entry.createdAt})
			ON CONFLICT (id) DO NOTHING
		`);
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
	resolvedEntries: HistoryEntryRecord[],
	projectIdentity?: string
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

		const existingResult = await client.execute(sql`
			SELECT * FROM entities WHERE tenant_id = ${tenantId} AND id = ${entityId}
		`);
		const existingRow = (existingResult.rows as EntityRow[])[0];

		if (existingRow) {
			const existing = mapEntityRow(existingRow);
			if (!factsMatchEntity(existing, resolved)) {
				await client.execute(sql`
					UPDATE entities
					SET title = ${resolved.title}, status = ${resolved.status}, body = ${resolved.body}, body_source = ${resolved.bodySource}, updated_at = ${resolved.createdAt}
					WHERE tenant_id = ${tenantId} AND id = ${entityId}
				`);
				await reconcileStructuralParent(client, tenantId, entityId, existing.kind, resolved.parentId);
				updated.push(entityId);
			}
		} else {
			const kind = deriveEntityKindFromId(entityId);
			const projectId = kind === "project" ? entityId : await resolveProjectIdForWrite(client, tenantId, projectIdentity);
			await client.execute(sql`
				INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, project_id, created_at, updated_at)
				VALUES (${tenantId}, ${entityId}, ${kind}, ${resolved.title}, ${resolved.status}, ${resolved.body}, ${resolved.bodySource}, ${projectId}, ${resolved.createdAt}, ${resolved.createdAt})
			`);

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

	await refreshProjectAssignments(client, tenantId, projectIdentity);

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
	const result = await client.execute(sql`
		SELECT r.* FROM relations r WHERE r.tenant_id = ${tenantId}
		AND NOT (
			r.type = ANY(ARRAY[${sql.join([...STRUCTURAL_RELATION_TYPES], sql`, `)}]::text[])
			AND r.from_id = (
				SELECT h.parent_id FROM history_entries h
				WHERE h.tenant_id = r.tenant_id AND h.entity_id = r.to_id
				ORDER BY h.version DESC LIMIT 1
			)
		)
	`);
	return (result.rows as RelationRow[]).map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdAt: row.created_at
	}));
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

	const removed = await client
		.delete(relations)
		.where(
			and(
				eq(relations.tenantId, tenantId),
				eq(relations.fromId, relation.fromId),
				eq(relations.toId, relation.toId),
				eq(relations.type, relation.type)
			)
		)
		.returning({ fromId: relations.fromId });

	return { relation, removed: removed.length > 0 };
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

	if ((entity.kind === "prd" || entity.kind === "userStory" || entity.kind === "adr") && input.status === "superseded") {
		throw new Error(`${entity.id} status is derived (superseded); link a replacement record with supersedes instead.`);
	}

	if (
		(entity.kind === "prd" || entity.kind === "userStory" || entity.kind === "adr") &&
		(await isEntitySuperseded(client, tenantId, entity.id, entity.kind))
	) {
		throw new Error(`${entity.id} status is derived (superseded) because another ${entity.kind} supersedes it.`);
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

	await client
		.update(entities)
		.set({ status: input.status, updatedAt })
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, input.entityId)));

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

	await client
		.update(entities)
		.set({ body: input.body, bodySource, updatedAt })
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, input.entityId)));

	const updated = await getEntityOrThrow(client, tenantId, input.entityId);
	await appendHistoryEntry(client, tenantId, updated, input.author);
	return updated;
}

export async function updateEntity(
	client: PoolClient,
	tenantId: string,
	input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string }
): Promise<EntityRecord> {
	const entity = await getEntityOrThrow(client, tenantId, input.entityId);
	if (input.title === undefined && input.body === undefined) {
		throw new Error("Entity edit requires --title, --body, or both.");
	}

	const title = input.title === undefined ? entity.title : input.title.trim();
	if (title.length === 0) {
		throw new Error("Entity title must not be empty.");
	}
	const body = input.body ?? entity.body;
	const bodySource = input.body === undefined ? entity.bodySource : input.bodySource ?? "authored";
	const updatedAt = new Date().toISOString();

	await client
		.update(entities)
		.set({ title, body, bodySource, updatedAt })
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, input.entityId)));

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
		await client
			.delete(relations)
			.where(
				and(
					eq(relations.tenantId, tenantId),
					eq(relations.fromId, relation.fromId),
					eq(relations.toId, relation.toId),
					eq(relations.type, relation.type)
				)
			);
	}

	await insertRelation(client, tenantId, { fromId: newParent.id, toId: entity.id, type: relationType, createdAt: updatedAt });
	await refreshProjectAssignments(client, tenantId);

	await client
		.update(entities)
		.set({ updatedAt })
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, entity.id)));

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

	const [outgoingResult] = await client
		.select({ count: sql<number>`count(*)` })
		.from(relations)
		.where(and(eq(relations.tenantId, tenantId), eq(relations.fromId, input.entityId)));
	if (Number(outgoingResult?.count ?? 0) > 0) {
		throw new Error(`Cannot delete ${entity.id} while it still has outgoing relations. Unlink or delete dependents first.`);
	}

	const removed = await client
		.delete(entities)
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, input.entityId)))
		.returning({ id: entities.id });

	return { entity, removed: removed.length > 0 };
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

export async function listProjectAdrs(client: PoolClient, tenantId: string, projectId?: string): Promise<EntityRecord[]> {
	const entityRecords = await getAllEntities(client, tenantId);
	const relations = await getAllRelations(client, tenantId);
	const childIds = new Set(relations.filter((relation) => isStructuralRelationType(relation.type)).map((relation) => relation.toId));

	if (!projectId) {
		return entityRecords.filter((entity) => entity.kind === "adr" && !childIds.has(entity.id));
	}

	const rows = await client
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, tenantId), eq(entities.kind, "adr"), eq(entities.projectId, projectId)))
		.orderBy(asc(entities.id));
	return rows.map(mapDrizzleEntityRow).filter((entity) => !childIds.has(entity.id));
}

export async function getInitiativeBundle(
	client: PoolClient,
	tenantId: string,
	initiativeId: string,
	allowedIds?: ReadonlySet<string>,
	statusMap?: ReadonlyMap<string, string>
): Promise<InitiativeBundle> {
	const initiative = await getEntityOrThrow(client, tenantId, initiativeId);
	if (initiative.kind !== "initiative") {
		throw new Error(`${initiativeId} is not an initiative.`);
	}

	const reachableResult = await client.execute(sql`
		WITH RECURSIVE reachable(id) AS (
			SELECT ${initiativeId}::text
			UNION
			SELECT CASE
				WHEN relations.from_id = reachable.id THEN relations.to_id
				ELSE relations.from_id
			END
			FROM reachable
			JOIN relations ON (
				relations.from_id = reachable.id
				OR (relations.type = 'handsOff' AND relations.to_id = reachable.id)
			)
			WHERE relations.tenant_id = ${tenantId}
		)
		SELECT id FROM reachable
	`);
	const reachableIds = (reachableResult.rows as Array<{ id: string }>).map((row) => row.id);
	const selectedIds = new Set(reachableIds.filter((id) => !allowedIds || allowedIds.has(id)));

	const entityResult = await client.execute(sql`
		SELECT * FROM entities
		WHERE tenant_id = ${tenantId} AND id = ANY(ARRAY[${sql.join([...selectedIds], sql`, `)}]::text[])
		ORDER BY id
	`);
	const relationResult = await client.execute(sql`SELECT * FROM relations WHERE tenant_id = ${tenantId}`);
	const entityRows = entityResult.rows as EntityRow[];
	const relationRows = relationResult.rows as RelationRow[];

	const entities = entityRows.map(mapEntityRow);
	const selectedRelations = relationRows.filter(
		(relation) => selectedIds.has(relation.from_id) && selectedIds.has(relation.to_id)
	);
	const derivedStatusMap = statusMap ?? (await getDerivedStatusMap(client, tenantId));
	const derivedEntities = entities.map((entity) => applyDerivedStatus(entity, derivedStatusMap));
	const entityById = new Map(derivedEntities.map((entity) => [entity.id, entity]));

	return {
		initiative: applyDerivedStatus(initiative, derivedStatusMap),
		entities: derivedEntities,
		prds: derivedEntities.filter((entity) => entity.kind === "prd"),
		userStories: derivedEntities.filter((entity) => entity.kind === "userStory"),
		adrs: derivedEntities.filter((entity) => entity.kind === "adr"),
		issues: derivedEntities.filter((entity) => entity.kind === "issue"),
		fixLinks: selectedRelations
			.filter((relation) => relation.type === "fixes")
			.map((relation) => ({ issue: entityById.get(relation.from_id)!, userStory: entityById.get(relation.to_id)! })),
		subIssueLinks: selectedRelations
			.filter((relation) => relation.type === "decomposes")
			.map((relation) => ({ parent: entityById.get(relation.from_id)!, issue: entityById.get(relation.to_id)! })),
		blockerLinks: selectedRelations
			.filter((relation) => relation.type === "blocks")
			.map((relation) => ({ source: entityById.get(relation.from_id)!, target: entityById.get(relation.to_id)! })),
		constrainsLinks: selectedRelations
			.filter((relation) => relation.type === "constrains")
			.map((relation) => ({ adr: entityById.get(relation.from_id)!, issue: entityById.get(relation.to_id)! })),
	};
}

export async function getDatabaseSnapshot(client: PoolClient, tenantId: string, projectIdentity: string | undefined): Promise<DatabaseSnapshot>;
export async function getDatabaseSnapshot(client: PoolClient, tenantId: string, projectIdentity: string | undefined, input: { projectId: string }): Promise<ProjectSnapshot>;
export async function getDatabaseSnapshot(
	client: PoolClient,
	tenantId: string,
	projectIdentity: string | undefined,
	input?: { projectId: string }
): Promise<DatabaseSnapshot | ProjectSnapshot> {
	if (input?.projectId) {
		const discovery = await getProjectDiscovery(client, tenantId, input);
		if (discovery.kind === "unavailable") {
			return { kind: "unavailable" };
		}

		const project = discovery.projects.find((entry) => entry.project.id === input.projectId)!.project;
		const snapshot = await getProjectSnapshot(client, tenantId, project);
		return { kind: "available", snapshot };
	}

	const entities = await getAllDerivedEntities(client, tenantId);
	const relations = await getAllRelations(client, tenantId);
	const initiatives = entities.filter((entity) => entity.kind === "initiative");
	const statusMap = new Map(entities.map((entity) => [entity.id, entity.status]));

	const orphans = await listOrphans(client, tenantId);
	const projectAdrs = await listProjectAdrs(client, tenantId);
	const initiativeBundles = await Promise.all(
		initiatives.map((entity) => getInitiativeBundle(client, tenantId, entity.id, undefined, statusMap))
	);

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

async function getProjectSnapshot(client: PoolClient, tenantId: string, project: EntityRecord): Promise<DatabaseSnapshot> {
	const allEntities = await getAllDerivedEntities(client, tenantId);
	const allRelations = await getAllRelations(client, tenantId);
	const selectedIds = collectReachableIds(allRelations.filter((relation) => isStructuralRelationType(relation.type)), project.id);
	const entities = allEntities.filter((entity) => selectedIds.has(entity.id));
	const relations = allRelations.filter((relation) => selectedIds.has(relation.fromId) && selectedIds.has(relation.toId));
	const initiatives = entities.filter((entity) => entity.kind === "initiative");
	const structuralRelations = allRelations.filter((relation) => isStructuralRelationType(relation.type));
	const statusMap = new Map(allEntities.map((entity) => [entity.id, entity.status]));
	const projectAdrs = await listProjectAdrs(client, tenantId, project.id);

	return {
		generatedAt: new Date().toISOString(),
		entities,
		relations,
		orphans: [],
		projectAdrs,
		initiatives: await Promise.all(
			initiatives.map((entity) =>
				getInitiativeBundle(client, tenantId, entity.id, collectReachableIds(structuralRelations, entity.id), statusMap)
			)
		),
		contexts: {
			shared: await queryProjectContextDetails(client, tenantId, project),
			initiatives: await Promise.all(initiatives.map((entity) => queryProjectContextDetails(client, tenantId, project, entity.id)))
		}
	};
}

async function getEntityProjectId(client: PoolClient, tenantId: string, entityId: string): Promise<string | null> {
	const result = await client.execute(sql`
		SELECT project_id FROM entities WHERE tenant_id = ${tenantId} AND id = ${entityId}
	`);
	return (result.rows as Array<{ project_id: string | null }>)[0]?.project_id ?? null;
}

async function resolveProjectIdForWrite(client: PoolClient, tenantId: string, projectIdentity: string | undefined): Promise<string> {
	if (projectIdentity) {
		const result = await client.execute(sql`
			SELECT id FROM entities
			WHERE tenant_id = ${tenantId} AND kind = 'project' AND title = ${projectIdentity}
			ORDER BY id LIMIT 1
		`);
		const project = (result.rows as Array<{ id: string }>)[0];
		if (project) {
			return project.id;
		}
	}

	return DEFAULT_PROJECT_ID;
}

async function refreshProjectAssignments(client: PoolClient, tenantId: string, projectIdentity?: string): Promise<void> {
	const entityResult = await client.execute(sql`SELECT id, kind FROM entities WHERE tenant_id = ${tenantId}`);
	const relationResult = await client.execute(sql`
		SELECT from_id, to_id, type FROM relations WHERE tenant_id = ${tenantId}
	`);
	const entities = entityResult.rows as Array<{ id: string; kind: string }>;
	const relations = relationResult.rows as Array<{ from_id: string; to_id: string; type: string }>;
	const assignment = assignEntitiesToProjects(
		entities,
		relations.map((relation) => ({ fromId: relation.from_id, toId: relation.to_id, type: relation.type }))
	);
	const fallbackProjectId = await resolveProjectIdForWrite(client, tenantId, projectIdentity);

	for (const entity of entities) {
		const projectId = entity.kind === "project" ? entity.id : (assignment.get(entity.id) ?? fallbackProjectId);
		await client.execute(sql`
			UPDATE entities SET project_id = ${projectId} WHERE tenant_id = ${tenantId} AND id = ${entity.id}
		`);
	}
}

export async function getProjectDiscovery(
	client: PoolClient,
	tenantId: string,
	input?: { projectId?: string }
): Promise<ProjectDiscovery> {
	const entities = await getAllEntities(client, tenantId);
	const relations = await getAllRelations(client, tenantId);
	const statusMap = new Map(deriveEntityStatuses(entities, relations).map((entity) => [entity.id, entity.status]));
	const derivedEntities = entities.map((entity) => applyDerivedStatus(entity, statusMap));
	const projects = derivedEntities.filter((entity) => entity.kind === "project" && entity.id !== DEFAULT_PROJECT_ID);
	if (input?.projectId && !projects.some((project) => project.id === input.projectId)) {
		return { kind: "unavailable" };
	}

	return {
		kind: "available",
		projects: projects.map((project) => {
			const epicIds = new Set(
				relations
					.filter((relation) => relation.type === "contains" && relation.fromId === project.id)
					.map((relation) => relation.toId)
			);
			const initiatives = derivedEntities.filter(
				(entity) =>
					entity.kind === "initiative" &&
					relations.some((relation) => relation.type === "contains" && epicIds.has(relation.fromId) && relation.toId === entity.id)
			);

			return {
				project,
				epicCount: epicIds.size,
				initiativeCount: initiatives.length,
				completedInitiativeCount: initiatives.filter((initiative) => initiative.status === "done").length
			};
		})
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
	const result = await client.execute(sql`
		SELECT
			(SELECT count(*) FROM entities WHERE tenant_id = ${tenantId}) AS entity_count,
			(SELECT max(updated_at) FROM entities WHERE tenant_id = ${tenantId}) AS entity_max_updated,
			(SELECT count(*) FROM relations WHERE tenant_id = ${tenantId}) AS relation_count,
			(SELECT count(*) FROM contexts WHERE tenant_id = ${tenantId}) AS context_count,
			(SELECT max(updated_at) FROM contexts WHERE tenant_id = ${tenantId}) AS context_max_updated,
			(SELECT count(*) FROM context_terms WHERE tenant_id = ${tenantId}) AS term_count,
			(SELECT max(updated_at) FROM context_terms WHERE tenant_id = ${tenantId}) AS term_max_updated
	`);
	const row = (result.rows as Array<{
		entity_count: string;
		entity_max_updated: string | null;
		relation_count: string;
		context_count: string;
		context_max_updated: string | null;
		term_count: string;
		term_max_updated: string | null;
	}>)[0]!;
	return [
		`entities:${row.entity_count}:${row.entity_max_updated}`,
		`relations:${row.relation_count}`,
		`contexts:${row.context_count}:${row.context_max_updated}`,
		`terms:${row.term_count}:${row.term_max_updated}`
	].join("|");
}
