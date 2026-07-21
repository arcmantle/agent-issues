import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import {
	collectReachableIds,
	computeEntityContentHash,
	EntityConflictError,
	EntityRevisionError,
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	assignEntitiesToProjects,
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
	materializeFromPatches,
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
	type EntityRevisionPatch,
	type HistoryEntryRecord,
	type InitiativeBundle,
	type LinkResult,
	type MaterializedEntityRevision,
	type MoveResult,
	type ProjectDiscovery,
	type ProjectSnapshot,
	type RelationRecord,
	type RelationType,
	type StatusUpdateResult,
	type UnlinkResult
} from "@agent-issues/core";
import type { TenantExecutor as PoolClient } from "../../db/connection.js";
import { counters, entities, entityDeltaEntries, historyEntries, relations } from "../../schema.js";

import { queryContextDetails, queryProjectContextDetails } from "../context/pg-context-store.js";

export type EntityRow = {
	id: string;
	kind: string;
	title: string;
	status: string;
	body: string;
	body_source: string | null;
	revision?: number | null;
	content_hash?: string | null;
	tombstone?: boolean | null;
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
			revision: 1,
			contentHash: computeEntityContentHash(DEFAULT_PROJECT_TITLE, ""),
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
			revision: 1,
			contentHash: computeEntityContentHash(DEFAULT_EPIC_TITLE, ""),
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
		revision: row.revision ?? 1,
		contentHash: row.content_hash ?? "",
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
		revision: row.revision ?? 1,
		contentHash: row.contentHash ?? "",
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
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, entityId), eq(entities.tombstone, false)));

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

// Appends a reverse-patch entry (ADR55/ISS257) mirroring appendDeltaEntry in
// core's store.ts. Records the predecessor title/body so ISS261's history
// materializer can walk back from the current head one step at a time.
async function appendDeltaEntry(
	client: PoolClient,
	tenantId: string,
	entityId: string,
	newRevision: number,
	priorTitle: string,
	priorBody: string,
	priorBodySource: string,
	author: string | undefined,
	createdAt: string,
	lifecycle: { priorStatus?: string; priorParentId?: string | null; priorTombstone?: boolean | null; restoredFromRevision?: number } = {}
): Promise<void> {
	await client.execute(sql`
		INSERT INTO entity_delta_entries (id, tenant_id, entity_id, revision, author, prior_title, prior_body, prior_body_source, prior_status, prior_parent_id, prior_parent_changed, prior_tombstone, restored_from_revision, created_at)
		VALUES (${randomUUID()}, ${tenantId}, ${entityId}, ${newRevision}, ${author?.trim() || RESERVED_SYSTEM_AUTHOR}, ${priorTitle}, ${priorBody}, ${priorBodySource}, ${lifecycle.priorStatus ?? null}, ${lifecycle.priorParentId ?? null}, ${Object.hasOwn(lifecycle, "priorParentId")}, ${lifecycle.priorTombstone ?? null}, ${lifecycle.restoredFromRevision ?? null}, ${createdAt})
	`);
}

async function getAllEntities(client: PoolClient, tenantId: string): Promise<EntityRecord[]> {
	const rows = await client.select().from(entities).where(and(eq(entities.tenantId, tenantId), eq(entities.tombstone, false)));
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

// Reconciles `entityId`'s structural parent relation to `newParentId` (see
// core's `reconcileStructuralParent` for the full rationale).
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
	const contentHash = computeEntityContentHash(title, body);
	await client.insert(entities).values({
		tenantId,
		id,
		kind,
		title,
		status,
		body,
		bodySource,
		revision: 1,
		contentHash,
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

// Relations are an idempotent key union after canonical heads import. This
// includes structural rows: the canonical parent is already present and is a
// no-op, while additional structural-type annotations must still transfer.
export async function listAllRelations(client: PoolClient, tenantId: string): Promise<RelationRecord[]> {
	const result = await client.execute(sql`SELECT * FROM relations WHERE tenant_id = ${tenantId}`);
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
	const newRevision = entity.revision + 1;

	const updated = await client
		.update(entities)
		.set({ status: input.status, revision: newRevision, updatedAt })
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, input.entityId), eq(entities.revision, entity.revision)))
		.returning({ id: entities.id });
	if (updated.length === 0) {
		const current = await getEntityOrThrow(client, tenantId, input.entityId);
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}
	await appendDeltaEntry(client, tenantId, entity.id, newRevision, entity.title, entity.body, entity.bodySource, input.author, updatedAt, {
		priorStatus: entity.status
	});

	return { entity: await getEntityOrThrow(client, tenantId, input.entityId), previousStatus };
}

export async function setEntityBody(
	client: PoolClient,
	tenantId: string,
	input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }
): Promise<EntityRecord> {
	const current = await getEntityOrThrow(client, tenantId, input.entityId);

	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}

	const updatedAt = new Date().toISOString();
	const bodySource = input.bodySource ?? "authored";
	const newRevision = current.revision + 1;
	const newContentHash = computeEntityContentHash(current.title, input.body);

	const [guard] = await client
		.update(entities)
		.set({ body: input.body, bodySource, revision: newRevision, contentHash: newContentHash, updatedAt })
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, input.entityId), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash)))
		.returning({ id: entities.id });

	if (!guard) {
		const fresh = await getEntityOrThrow(client, tenantId, input.entityId);
		throw new EntityConflictError(input.entityId, fresh.revision, fresh.contentHash);
	}

	await appendDeltaEntry(client, tenantId, input.entityId, newRevision, current.title, current.body, current.bodySource, input.author, updatedAt);
	return getEntityOrThrow(client, tenantId, input.entityId);
}

export async function updateEntity(
	client: PoolClient,
	tenantId: string,
	input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }
): Promise<EntityRecord> {
	const current = await getEntityOrThrow(client, tenantId, input.entityId);
	if (input.title === undefined && input.body === undefined) {
		throw new Error("Entity edit requires --title, --body, or both.");
	}

	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}

	const title = input.title === undefined ? current.title : input.title.trim();
	if (title.length === 0) {
		throw new Error("Entity title must not be empty.");
	}
	const body = input.body ?? current.body;
	const bodySource = input.body === undefined ? current.bodySource : input.bodySource ?? "authored";
	const newRevision = current.revision + 1;
	const newContentHash = computeEntityContentHash(title, body);
	const updatedAt = new Date().toISOString();

	const [guard] = await client
		.update(entities)
		.set({ title, body, bodySource, revision: newRevision, contentHash: newContentHash, updatedAt })
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, input.entityId), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash)))
		.returning({ id: entities.id });

	if (!guard) {
		const fresh = await getEntityOrThrow(client, tenantId, input.entityId);
		throw new EntityConflictError(input.entityId, fresh.revision, fresh.contentHash);
	}

	await appendDeltaEntry(client, tenantId, input.entityId, newRevision, current.title, current.body, current.bodySource, input.author, updatedAt);
	return getEntityOrThrow(client, tenantId, input.entityId);
}

export async function materializeEntityRevision(
	client: PoolClient,
	tenantId: string,
	input: { entityId: string; revision: number }
): Promise<MaterializedEntityRevision> {
	const [row] = await client
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, input.entityId)));
	if (!row) {
		throw new EntityRevisionError(input.entityId, "entity-not-found", `Entity not found: ${input.entityId}`);
	}

	const entity = mapDrizzleEntityRow(row);
	const parentId = (await getStructuralParentRelations(client, tenantId, entity.id))[0]?.fromId ?? null;
	const deltaRows = await client
		.select()
		.from(entityDeltaEntries)
		.where(and(eq(entityDeltaEntries.tenantId, tenantId), eq(entityDeltaEntries.entityId, entity.id)))
		.orderBy(desc(entityDeltaEntries.revision));
	const patches: EntityRevisionPatch[] = deltaRows.map((delta) => ({
		revision: delta.revision,
		author: delta.author,
		createdAt: delta.createdAt,
		priorTitle: delta.priorTitle,
		priorBody: delta.priorBody,
		priorBodySource: isBodySource(delta.priorBodySource) ? delta.priorBodySource : "authored",
		...(delta.priorStatus !== null && { priorStatus: delta.priorStatus }),
		...(delta.priorParentChanged && { priorParentId: delta.priorParentId }),
		...(delta.priorTombstone !== null && { priorTombstone: delta.priorTombstone }),
		...(delta.restoredFromRevision !== null && { restoredFromRevision: delta.restoredFromRevision })
	}));

	return materializeFromPatches(
		entity.id,
		{
			id: entity.id,
			title: entity.title,
			body: entity.body,
			bodySource: entity.bodySource,
			status: entity.status,
			parentId,
			revision: entity.revision,
			createdAt: entity.createdAt,
			tombstone: row.tombstone
		},
		patches,
		input.revision
	);
}

export async function restoreEntityRevision(
	client: PoolClient,
	tenantId: string,
	input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }
): Promise<MaterializedEntityRevision> {
	const [row] = await client.select().from(entities).where(and(eq(entities.tenantId, tenantId), eq(entities.id, input.entityId)));
	if (!row) {
		throw new EntityRevisionError(input.entityId, "entity-not-found", `Entity not found: ${input.entityId}`);
	}
	const current = mapDrizzleEntityRow(row);
	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}
	const source = await materializeEntityRevision(client, tenantId, { entityId: input.entityId, revision: input.revision });
	const currentParentId = (await getStructuralParentRelations(client, tenantId, current.id))[0]?.fromId ?? null;
	let restoredParent: EntityRecord | null = null;
	let restoredRelationType: RelationType | null = null;
	if (!source.tombstone && source.parentId) {
		restoredParent = await getEntityOrThrow(client, tenantId, source.parentId);
		restoredRelationType = getAllowedRelationType(restoredParent.kind, current.kind);
		if (!restoredRelationType || !isStructuralRelationType(restoredRelationType)) {
			throw new Error(`Cannot restore ${current.kind} under ${restoredParent.kind}.`);
		}
		if (await hasStructuralPath(client, tenantId, current.id, restoredParent.id)) {
			throw new Error(`Cannot restore ${current.id} under ${restoredParent.id} because that would create a cycle.`);
		}
	}

	const updatedAt = new Date().toISOString();
	const newRevision = current.revision + 1;
	const [guard] = await client.update(entities).set({
		title: source.title,
		body: source.body,
		bodySource: source.bodySource,
		status: source.status,
		revision: newRevision,
		contentHash: computeEntityContentHash(source.title, source.body),
		tombstone: source.tombstone === true,
		updatedAt
	}).where(and(eq(entities.tenantId, tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash))).returning({ id: entities.id });
	if (!guard) {
		const [freshRow] = await client.select().from(entities).where(and(eq(entities.tenantId, tenantId), eq(entities.id, current.id)));
		const fresh = mapDrizzleEntityRow(freshRow!);
		throw new EntityConflictError(current.id, fresh.revision, fresh.contentHash);
	}

	for (const relation of await getStructuralParentRelations(client, tenantId, current.id)) {
		await client.delete(relations).where(and(eq(relations.tenantId, tenantId), eq(relations.fromId, relation.fromId), eq(relations.toId, relation.toId), eq(relations.type, relation.type)));
	}
	if (restoredParent && restoredRelationType) {
		await insertRelation(client, tenantId, { fromId: restoredParent.id, toId: current.id, type: restoredRelationType, createdAt: updatedAt });
	}
	await refreshProjectAssignments(client, tenantId);

	await appendDeltaEntry(client, tenantId, current.id, newRevision, current.title, current.body, current.bodySource, input.author, updatedAt, {
		priorStatus: current.status,
		priorParentId: currentParentId,
		priorTombstone: row.tombstone,
		restoredFromRevision: input.revision
	});
	return materializeEntityRevision(client, tenantId, { entityId: current.id, revision: newRevision });
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
	const newRevision = entity.revision + 1;

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

	const updated = await client
		.update(entities)
		.set({ revision: newRevision, updatedAt })
		.where(and(eq(entities.tenantId, tenantId), eq(entities.id, entity.id), eq(entities.revision, entity.revision)))
		.returning({ id: entities.id });
	if (updated.length === 0) {
		const current = await getEntityOrThrow(client, tenantId, entity.id);
		throw new EntityConflictError(entity.id, current.revision, current.contentHash);
	}

	await appendDeltaEntry(client, tenantId, entity.id, newRevision, entity.title, entity.body, entity.bodySource, input.author, updatedAt, {
		priorParentId: previousParentId
	});

	return {
		entity: await getEntityOrThrow(client, tenantId, entity.id),
		previousParentId,
		newParentId: newParent.id,
		relationType
	};
}

export async function deleteEntity(client: PoolClient, tenantId: string, input: { entityId: string }): Promise<DeleteResult> {
	const entity = await getEntityOrThrow(client, tenantId, input.entityId);
	const previousParentId = (await getStructuralParentRelations(client, tenantId, entity.id))[0]?.fromId ?? null;
	const dependentHandoffRows = await client
		.select({ id: entities.id })
		.from(entities)
		.innerJoin(relations, and(eq(relations.tenantId, entities.tenantId), eq(relations.fromId, entities.id)))
		.where(
			and(
				eq(entities.tenantId, tenantId),
				eq(entities.kind, "handoff"),
				eq(entities.tombstone, false),
				eq(relations.toId, input.entityId),
				eq(relations.type, "handsOff")
			)
		);
	for (const { id: handoffId } of dependentHandoffRows) {
		const handoff = await getEntityOrThrow(client, tenantId, handoffId);
		const handoffUpdatedAt = new Date().toISOString();
		const handoffRevision = handoff.revision + 1;
		await client
			.delete(relations)
			.where(and(eq(relations.tenantId, tenantId), or(eq(relations.fromId, handoff.id), eq(relations.toId, handoff.id))));
		await client
			.update(entities)
			.set({ tombstone: true, revision: handoffRevision, updatedAt: handoffUpdatedAt })
			.where(and(eq(entities.tenantId, tenantId), eq(entities.id, handoff.id), eq(entities.tombstone, false)));
		await appendDeltaEntry(client, tenantId, handoff.id, handoffRevision, handoff.title, handoff.body, handoff.bodySource, undefined, handoffUpdatedAt, {
			priorTombstone: false
		});
	}

	const [outgoingResult] = await client
		.select({ count: sql<number>`count(*)` })
		.from(relations)
		.where(and(eq(relations.tenantId, tenantId), eq(relations.fromId, input.entityId)));
	if (Number(outgoingResult?.count ?? 0) > 0) {
		throw new Error(`Cannot delete ${entity.id} while it still has outgoing relations. Unlink or delete dependents first.`);
	}

	const updatedAt = new Date().toISOString();
	const newRevision = entity.revision + 1;
	await client
		.delete(relations)
		.where(and(eq(relations.tenantId, tenantId), or(eq(relations.fromId, entity.id), eq(relations.toId, entity.id))));
	const removed = await client
		.update(entities)
		.set({ tombstone: true, revision: newRevision, updatedAt })
		.where(
			and(
				eq(entities.tenantId, tenantId),
				eq(entities.id, input.entityId),
				eq(entities.tombstone, false),
				eq(entities.revision, entity.revision)
			)
		)
		.returning({ id: entities.id });
	if (removed.length === 0) {
		const current = await getEntityOrThrow(client, tenantId, input.entityId);
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}
	await appendDeltaEntry(client, tenantId, entity.id, newRevision, entity.title, entity.body, entity.bodySource, undefined, updatedAt, {
		priorParentId: previousParentId,
		priorTombstone: false
	});

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
