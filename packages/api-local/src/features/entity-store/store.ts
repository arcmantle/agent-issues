import { randomUUID } from "node:crypto";

import { and, eq, sql, type SQL } from "drizzle-orm";

import { getSqliteEntityOrThrow, type SqliteExecutor } from "../../db/sqlite-executor.js";
import { counters, entities } from "../../schema.js";
import { getContextDetails, type ContextDetails } from "../context/context-store.js";
import {
	collectReachableIds,
	getArchiveStatus,
	getAllowedRelationType,
	deriveEntityKindFromId,
	deriveEntityStatuses,
	DEFAULT_EPIC_ID,
	DEFAULT_PROJECT_ID,
	factsMatchEntity,
	getInitialStatus,
	isBodySource,
	isAllowedRelation,
	isEntityKind,
	isInitiativeComplete,
	isStructuralRelationType,
	isValidStatus,
	ID_PREFIX,
	RESERVED_SYSTEM_AUTHOR,
	STRUCTURAL_RELATION_TYPES,
	type BodySource,
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
	type UnlinkResult,
	wouldOrphanSubtree as wouldOrphanSubtreeInGraph
} from "@agent-issues/core";

export {
	type DatabaseSnapshot,
	type DeleteResult,
	type EntityDetails,
	type InitiativeBundle,
	type LinkResult,
	type MoveResult,
	type StatusUpdateResult,
	type UnlinkResult
};

type EntityRow = {
	id: string;
	kind: string;
	title: string;
	status: string;
	body: string;
	body_source?: string | null;
	created_at: string;
	updated_at: string;
};

type DrizzleEntityRow = typeof entities.$inferSelect;

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

function all<T>(executor: SqliteExecutor, query: SQL): T[] {
	return executor.drizzle.all(query) as T[];
}

function first<T>(executor: SqliteExecutor, query: SQL): T | undefined {
	return all<T>(executor, query)[0];
}

function run(executor: SqliteExecutor, query: SQL): { changes: number } {
	return executor.drizzle.run(query);
}

export function createEntity(
	executor: SqliteExecutor,
	input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		author?: string;
		links?: Array<{ relationType: string; targetId: string }>;
	}
): EntityRecord {
	const db = executor;
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

	const now = new Date().toISOString();
	const parentId = input.parentId ?? (kind === "initiative" ? resolveDefaultEpicId(executor) : undefined);
	const parent = parentId ? getEntityOrThrow(executor, parentId) : null;
	const relationType = parent ? getAllowedRelationType(parent.kind, kind) : null;

	if (parent && !relationType) {
		throw new Error(`Cannot create ${kind} under ${parent.kind}.`);
	}

	// The new entity belongs to its parent's project (structural children
	// always share their parent's owning project); a parentless entity -
	// an orphan issue or a project-scoped ADR - belongs to this workspace's
	// own resolved project (ISS166 follow-up).
	const inheritedProjectId = (parent ? getEntityProjectId(executor, parent.id) : null) ?? db.currentProjectId;

	return executor.transaction(() => {
		const id = nextEntityId(executor, kind);
		// A project owns itself, so scoped reads from its own workspace see it.
		const projectId = kind === "project" ? id : inheritedProjectId;
		const values = tenantParams(db, {
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
		executor.drizzle.insert(entities).values(values).run();

		if (parent && relationType) {
			insertRelation(executor, {
				fromId: parent.id,
				toId: id,
				type: relationType,
				createdAt: now
			});
		}

		for (const link of input.links ?? []) {
			linkEntities(executor, { fromId: id, relationType: link.relationType, toId: link.targetId });
		}

		const entity = getEntityOrThrow(executor, id);
		appendHistoryEntry(executor, entity, input.author);
		return entity;
	});
}

export function linkEntities(
	db: SqliteExecutor,
	input: { fromId: string; toId: string; relationType: string }
): LinkResult {
	if (input.fromId === input.toId) {
		throw new Error("Cannot create a relation from an entity to itself.");
	}

	const from = getEntityOrThrow(db, input.fromId);
	const to = getEntityOrThrow(db, input.toId);

	if (!isAllowedRelation(from.kind, to.kind, input.relationType)) {
		throw new Error(`Relation ${input.relationType} is not allowed from ${from.kind} to ${to.kind}.`);
	}

	if (
		(input.relationType === "blocks" || input.relationType === "supersedes") &&
		hasTypedPath(db, to.id, from.id, input.relationType)
	) {
		throw new Error(`Linking ${from.id} -> ${to.id} as ${input.relationType} would create a cycle.`);
	}

	const createdAt = new Date().toISOString();
	const result = insertRelation(db, {
		fromId: from.id,
		toId: to.id,
		type: input.relationType,
		createdAt
	});

	return {
		relation: {
			fromId: from.id,
			toId: to.id,
			type: input.relationType,
			createdAt
		},
		created: result.changes > 0
	};
}

export function updateEntityStatus(
	executor: SqliteExecutor,
	input: { entityId: string; status: string; author?: string }
): StatusUpdateResult {
	const db = executor;
	const entity = getEntityOrThrow(executor, input.entityId);

	if (!isValidStatus(entity.kind, input.status)) {
		throw new Error(`Invalid status for ${entity.kind}: ${input.status}`);
	}

	if ((entity.kind === "prd" || entity.kind === "userStory" || entity.kind === "adr") && input.status === "superseded") {
		throw new Error(`${entity.id} status is derived (superseded); link a replacement record with supersedes instead.`);
	}

	if (
		(entity.kind === "prd" || entity.kind === "userStory" || entity.kind === "adr") &&
		isEntitySuperseded(db, entity.id, entity.kind)
	) {
		throw new Error(`${entity.id} status is derived (superseded) because another ${entity.kind} supersedes it.`);
	}

	if (entity.kind === "userStory") {
		const fixingIssueStatuses = getFixingIssueStatuses(db, entity.id);
		if (fixingIssueStatuses.length > 0) {
			throw new Error(
				`${entity.id} status is derived from its fixing issues; update those issues instead of setting it directly.`
			);
		}
	}

	if (entity.kind === "prd") {
		const createdStoryStatuses = getCreatedStoryStatuses(db, entity.id);
		if (createdStoryStatuses.length > 0) {
			throw new Error(
				`${entity.id} status is derived from its user stories; update the underlying issues instead of setting it directly.`
			);
		}
	}

	if (entity.kind === "adr") {
		if (getConstrainedIssueStatuses(db, entity.id).length > 0) {
			throw new Error(
				`${entity.id} status is derived from the issues it constrains; update those issues instead of setting it directly.`
			);
		}
	}

	if (entity.kind === "initiative") {
		const { trackedIssueStatuses, ownedPrdStatuses } = getInitiativeChildStatuses(db, entity.id);
		if (isInitiativeComplete(trackedIssueStatuses, ownedPrdStatuses)) {
			throw new Error(
				`${entity.id} status is derived (done) from its tracked issues and PRDs; reopen a child to change it.`
			);
		}
		if (input.status === "done" && trackedIssueStatuses.length > 0) {
			throw new Error(
				`${entity.id} cannot be marked done while tracked issues remain open; it completes automatically when they are all done.`
			);
		}
	}

	if (entity.kind === "issue" && (input.status === "in-progress" || input.status === "done")) {
		const openSubIssues = getOpenSubIssues(db, entity.id);
		if (openSubIssues.length > 0) {
			throw new Error(
				`Cannot set ${entity.id} to ${input.status} while sub-issues remain open: ${openSubIssues.map((issue) => issue.id).join(", ")}.`
			);
		}

		const blockingIssues = getActiveBlockingIssues(db, entity.id);
		if (blockingIssues.length > 0) {
			throw new Error(
				`Cannot set ${entity.id} to ${input.status} while blocked by ${blockingIssues.map((issue) => issue.id).join(", ")}.`
			);
		}
	}

	const previousStatus = entity.status;
	const updatedAt = new Date().toISOString();

	executor.drizzle
		.update(entities)
		.set({ status: input.status, updatedAt })
		.where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, input.entityId)))
		.run();

	const updated = getEntityOrThrow(db, input.entityId);
	appendHistoryEntry(db, updated, input.author);

	return {
		entity: updated,
		previousStatus
	};
}

export function setEntityBody(
	executor: SqliteExecutor,
	input: { entityId: string; body: string; bodySource?: BodySource; author?: string }
): EntityRecord {
	const db = executor;
	getEntityOrThrow(executor, input.entityId);

	const updatedAt = new Date().toISOString();
	const bodySource = input.bodySource ?? "authored";

	executor.drizzle
		.update(entities)
		.set({ body: input.body, bodySource, updatedAt })
		.where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, input.entityId)))
		.run();

	const updated = getEntityOrThrow(db, input.entityId);
	appendHistoryEntry(db, updated, input.author);
	return updated;
}

export function updateEntity(
	executor: SqliteExecutor,
	input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string }
): EntityRecord {
	const db = executor;
	const entity = getEntityOrThrow(executor, input.entityId);
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

	executor.drizzle
		.update(entities)
		.set({ body, bodySource, title, updatedAt })
		.where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, input.entityId)))
		.run();

	const updated = getEntityOrThrow(executor, input.entityId);
	appendHistoryEntry(db, updated, input.author);
	return updated;
}

export function archiveEntity(db: SqliteExecutor, input: { entityId: string }): StatusUpdateResult {
	const entity = getEntityOrThrow(db, input.entityId);
	return updateEntityStatus(db, {
		entityId: input.entityId,
		status: getArchiveStatus(entity.kind)
	});
}

export function moveEntity(
	db: SqliteExecutor,
	input: { entityId: string; newParentId: string; author?: string }
): MoveResult {
	if (input.entityId === input.newParentId) {
		throw new Error("Cannot move an entity under itself.");
	}

	const entity = getEntityOrThrow(db, input.entityId);
	const newParent = getEntityOrThrow(db, input.newParentId);

	const relationType = getAllowedRelationType(newParent.kind, entity.kind);
	if (!relationType || !isStructuralRelationType(relationType)) {
		throw new Error(`Cannot move ${entity.kind} under ${newParent.kind}.`);
	}

	const currentParentRelations = getStructuralParentRelations(db, entity.id);
	if (currentParentRelations.length > 1) {
		throw new Error(`Cannot move ${entity.id} because it has multiple structural parents.`);
	}

	if (hasStructuralPath(db, entity.id, newParent.id)) {
		throw new Error(`Cannot move ${entity.id} under ${newParent.id} because that would create a cycle.`);
	}

	const previousParentId = currentParentRelations[0]?.fromId ?? null;
	if (previousParentId === newParent.id && currentParentRelations[0]?.type === relationType) {
		return {
			entity,
			previousParentId,
			newParentId: newParent.id,
			relationType
		};
	}

	const updatedAt = new Date().toISOString();

	db.transaction(() => {
		for (const relation of currentParentRelations) {
			run(db, sql`DELETE FROM relations
				WHERE tenant_id = ${db.tenantId}
					AND from_id = ${relation.fromId}
					AND to_id = ${relation.toId}
					AND type = ${relation.type}`);
		}

		insertRelation(db, {
			fromId: newParent.id,
			toId: entity.id,
			type: relationType,
			createdAt: updatedAt
		});

		// A move can re-home the entity into a different project (ISS166);
		// its whole structural subtree inherits the new parent's owning
		// project so `project_id` stays consistent with the structure.
		const projectId = getEntityProjectId(db, newParent.id) ?? db.currentProjectId;
		run(db, sql`WITH RECURSIVE subtree(id) AS (
			SELECT ${entity.id}
			UNION
			SELECT relations.to_id
			FROM relations
			JOIN subtree ON relations.from_id = subtree.id
			WHERE relations.tenant_id = ${db.tenantId}
		)
		UPDATE entities
		SET project_id = ${projectId}
		WHERE tenant_id = ${db.tenantId} AND id IN (SELECT id FROM subtree)`);

		run(db, sql`UPDATE entities
			SET updated_at = ${updatedAt}
			WHERE tenant_id = ${db.tenantId}
				AND id = ${entity.id}`);

		appendHistoryEntry(db, getEntityOrThrow(db, entity.id), input.author);
	});

	return {
		entity: getEntityOrThrow(db, entity.id),
		previousParentId,
		newParentId: newParent.id,
		relationType
	};
}

export function unlinkEntities(
	db: SqliteExecutor,
	input: { fromId: string; toId: string; relationType: string }
): UnlinkResult {
	const relation = getRelationOrThrow(db, input);

	if (wouldOrphanSubtree(db, relation)) {
		throw new Error(
			`Unlinking ${relation.fromId} -> ${relation.toId} as ${relation.type} would orphan a subtree. Relink or delete descendants first.`
		);
	}

	if (wouldBreakFullChainInvariant(db, relation)) {
		throw new Error(
			`Cannot unlink ${relation.fromId} -> ${relation.toId} as ${relation.type}: it is the only remaining structural parent, and every ${getEntityOrThrow(db, relation.toId).kind} must have one.`
		);
	}

	const result = run(db, sql`DELETE FROM relations
		WHERE tenant_id = ${db.tenantId}
			AND from_id = ${relation.fromId}
			AND to_id = ${relation.toId}
			AND type = ${relation.type}`);

	return {
		relation,
		removed: result.changes > 0
	};
}

export function deleteEntity(executor: SqliteExecutor, input: { entityId: string }): DeleteResult {
	const db = executor;
	const entity = getEntityOrThrow(executor, input.entityId);

	return db.transaction(() => {
		run(db, sql`DELETE FROM entities
			WHERE tenant_id = ${db.tenantId}
				AND kind = 'handoff'
				AND id IN (
					SELECT from_id
					FROM relations
					WHERE tenant_id = ${db.tenantId}
						AND to_id = ${input.entityId}
						AND type = 'handsOff'
				)`);
			const outgoingCount = first<{ count: number }>(
				db,
				sql`SELECT COUNT(*) as count FROM relations WHERE tenant_id = ${db.tenantId} AND from_id = ${input.entityId}`
			)!;

			if (outgoingCount.count > 0) {
				throw new Error(`Cannot delete ${entity.id} while it still has outgoing relations. Unlink or delete dependents first.`);
			}

			const result = executor.drizzle
				.delete(entities)
				.where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, input.entityId)))
				.run();

			return {
				entity,
				removed: result.changes > 0
			};
		});
}

export function getEntityDetails(executor: SqliteExecutor, entityId: string): EntityDetails {
	const db = executor;
	const entity = getEntityOrThrow(executor, entityId);
	const incomingRows = all<EntityRow & { type: string }>(db, sql`SELECT relations.type, entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.to_id = ${entityId}
		ORDER BY entities.id`);
	const outgoingRows = all<EntityRow & { type: string }>(db, sql`SELECT relations.type, entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.from_id = ${entityId}
		ORDER BY entities.id`);

	const statusMap = getDerivedStatusMap(db);
	return {
		entity: applyDerivedStatus(entity, statusMap),
		incoming: incomingRows.map((row) => ({
			relationType: row.type as RelationType,
			entity: applyDerivedStatus(mapEntityRow(row), statusMap)
		})),
		outgoing: outgoingRows.map((row) => ({
			relationType: row.type as RelationType,
			entity: applyDerivedStatus(mapEntityRow(row), statusMap)
		}))
	};
}

export function getInitiativeBundle(db: SqliteExecutor, initiativeId: string, allowedIds?: ReadonlySet<string>): InitiativeBundle {
	const initiative = getEntityOrThrow(db, initiativeId);

	if (initiative.kind !== "initiative") {
		throw new Error(`${initiativeId} is not an initiative.`);
	}

	const entityRows = all<EntityRow>(db, sql`WITH RECURSIVE reachable(id) AS (
		SELECT ${initiativeId}
		UNION
		SELECT relations.to_id
		FROM relations
		JOIN reachable ON relations.from_id = reachable.id
		WHERE relations.tenant_id = ${db.tenantId}
		UNION
		SELECT relations.from_id
		FROM relations
		JOIN reachable ON relations.to_id = reachable.id
		WHERE relations.tenant_id = ${db.tenantId} AND relations.type = 'handsOff'
	)
	SELECT entities.*
	FROM entities
	JOIN reachable ON entities.id = reachable.id
	WHERE entities.tenant_id = ${db.tenantId}
	ORDER BY entities.id`);
	const relationRows = all<RelationRow>(db, sql`SELECT * FROM relations WHERE tenant_id = ${db.tenantId}`);

	const entities = entityRows.map(mapEntityRow).filter((entity) => !allowedIds || allowedIds.has(entity.id));
	const allowedEntityIds = new Set(entities.map((entity) => entity.id));
	const filteredRelationRows = relationRows.filter(
		(relation) => allowedEntityIds.has(relation.from_id) && allowedEntityIds.has(relation.to_id)
	);
	const statusMap = getDerivedStatusMap(db);
	const derivedEntities = entities.map((entity) => applyDerivedStatus(entity, statusMap));
	const entityById = new Map(derivedEntities.map((entity) => [entity.id, entity]));

	return {
		initiative: applyDerivedStatus(initiative, statusMap),
		entities: derivedEntities,
		prds: derivedEntities.filter((entity) => entity.kind === "prd"),
		userStories: derivedEntities.filter((entity) => entity.kind === "userStory"),
		adrs: derivedEntities.filter((entity) => entity.kind === "adr"),
		issues: derivedEntities.filter((entity) => entity.kind === "issue"),
		fixLinks: filteredRelationRows
			.filter((relation) => relation.type === "fixes")
			.map((relation) => ({
				issue: entityById.get(relation.from_id)!,
				userStory: entityById.get(relation.to_id)!
			})),
		subIssueLinks: filteredRelationRows
			.filter((relation) => relation.type === "decomposes")
			.map((relation) => ({
				parent: entityById.get(relation.from_id)!,
				issue: entityById.get(relation.to_id)!
			})),
		blockerLinks: filteredRelationRows
			.filter((relation) => relation.type === "blocks")
			.map((relation) => ({
				source: entityById.get(relation.from_id)!,
				target: entityById.get(relation.to_id)!
			})),
		constrainsLinks: filteredRelationRows
			.filter((relation) => relation.type === "constrains")
			.map((relation) => ({
				adr: entityById.get(relation.from_id)!,
				issue: entityById.get(relation.to_id)!
			}))
	};
}

export function listEntities(db: SqliteExecutor, kind: string): EntityRecord[] {
	if (!isEntityKind(kind)) {
		throw new Error(`Unknown entity kind: ${kind}`);
	}

	return getAllDerivedEntities(db).filter((entity) => entity.kind === kind);
}

// Full append-only history for one entity, oldest first - enables
// point-in-time reconstruction (walk forward) and "resolve latest" (take
// the last entry) from a single query. Deliberately does NOT require the
// entity to still exist: the whole point of an audit trail is that it
// outlives the record it documents (a deleted entity's history is still
// queryable; only a whole-tenant wipe removes it).
export function listEntityHistory(db: SqliteExecutor, entityId: string): HistoryEntryRecord[] {
	const rows = all<HistoryEntryRow>(
		db,
		sql`SELECT * FROM history_entries WHERE tenant_id = ${db.tenantId} AND entity_id = ${entityId} ORDER BY version ASC`
	);

	return rows.map(mapHistoryEntryRow);
}

// Every history entry for the tenant, across every entity (ISS57/ADR16):
// the read half of synchronize's merge substrate. No entity filter and no
// ordering guarantee beyond "everything" - the merge algorithm (slice 2)
// groups/orders per entity itself.
export function listAllHistoryEntries(db: SqliteExecutor): HistoryEntryRecord[] {
	const rows = all<HistoryEntryRow>(db, sql`SELECT * FROM history_entries WHERE tenant_id = ${db.tenantId}`);

	return rows.map(mapHistoryEntryRow);
}

// The write half of synchronize's merge substrate (ISS57/ADR16): inserts
// only the entries this tenant doesn't already have, keyed by the entry's
// own globally-unique `id` - so re-applying the same (or a superset) batch
// is a true no-op. Deliberately does not touch the live-cache `entities`
// table; recomputing "resolve latest" from the merged log and updating the
// live cache is the merge algorithm/synchronize command's job (slices 2/3),
// not this seam primitive's.
export function applyHistoryEntries(db: SqliteExecutor, entries: HistoryEntryRecord[]): { inserted: number } {
	let inserted = 0;
	for (const entry of entries) {
		const result = run(db, sql`INSERT OR IGNORE INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			VALUES (${entry.id}, ${db.tenantId}, ${entry.entityId}, ${entry.version}, ${entry.author}, ${entry.title}, ${entry.body}, ${entry.bodySource}, ${entry.status}, ${entry.parentId}, ${entry.createdAt})`);
		inserted += result.changes;
	}

	return { inserted };
}

// Bumps `kind`'s id counter past `entityId`'s numeric suffix if needed, so a
// later local `createEntity` of that kind can never collide with an id that
// arrived via synchronize instead of this side's own counter (ISS59).
function bumpCounterPast(db: SqliteExecutor, kind: EntityKind, entityId: string): void {
	const numericSuffix = Number(entityId.slice(ID_PREFIX[kind].length));
	if (!Number.isFinite(numericSuffix)) {
		return;
	}

	run(db, sql`UPDATE counters
		SET next_value = max(next_value, ${numericSuffix + 1})
		WHERE tenant_id = ${db.tenantId} AND kind = ${kind}`);
}

// Reconciles `entityId`'s structural parent relation to `newParentId`,
// bypassing `getAllowedRelationType`'s usual "does this pairing make sense"
// guard only on the DELETE side, since a resolved history entry's parent is
// already an accepted fact from whichever side authored it. The parent MUST
// already exist locally by the time this runs (`applyResolvedFacts` ensures
// parents before children), so its real kind is available for the INSERT
// side's relation-type lookup.
function reconcileStructuralParent(db: SqliteExecutor, entityId: string, kind: EntityKind, newParentId: string | null): void {
	const currentParents = getStructuralParentRelations(db, entityId);
	const currentParentId = currentParents[0]?.fromId ?? null;

	if (currentParentId === newParentId) {
		return;
	}

	for (const relation of currentParents) {
		run(db, sql`DELETE FROM relations
			WHERE tenant_id = ${db.tenantId}
				AND from_id = ${relation.fromId}
				AND to_id = ${entityId}
				AND type = ${relation.type}`);
	}

	if (!newParentId) {
		return;
	}

	const parent = getEntityOrThrow(db, newParentId);
	const relationType = getAllowedRelationType(parent.kind, kind);
	if (!relationType) {
		throw new Error(`Cannot resolve ${entityId} under ${parent.kind} via synchronize: no allowed relation from ${parent.kind} to ${kind}.`);
	}

	insertRelation(db, { fromId: parent.id, toId: entityId, type: relationType, createdAt: new Date().toISOString() });
}

// The live-cache write half of synchronize's merge (ISS59/ADR16): given the
// merge algorithm's per-entity resolved-latest entries, brings this side's
// `entities` table (and structural parent relation) in line with each one,
// WITHOUT appending a new history entry - the entry already exists (or was
// just applied via `applyHistoryEntries`); this only updates the cache
// "maintained in code" alongside it. An entity whose current facts already
// match its resolved entry is left untouched, which is what makes a
// synchronize with nothing new to converge report zero updates. An entity
// with no live-cache row on this side yet (introduced by the other side) is
// created outright, deriving its kind from its id and its structural parent
// from `resolved.parentId` - parents are always resolved before children so
// the parent's real kind is available.
export function applyResolvedFacts(
	db: SqliteExecutor,
	resolvedEntries: HistoryEntryRecord[]
): { created: string[]; updated: string[] } {
	const resolvedByEntity = new Map(resolvedEntries.map((entry) => [entry.entityId, entry]));
	const created: string[] = [];
	const updated: string[] = [];
	const settled = new Set<string>();

	function ensureEntity(entityId: string, visiting: Set<string>): void {
		if (settled.has(entityId)) {
			return;
		}

		const resolved = resolvedByEntity.get(entityId);
		if (!resolved) {
			// Not part of this merge batch; assumed already correct on this side.
			settled.add(entityId);
			return;
		}

		if (visiting.has(entityId)) {
			throw new Error(`Cycle detected while resolving structural parent chain for ${entityId}.`);
		}

		if (resolved.parentId) {
			visiting.add(entityId);
			ensureEntity(resolved.parentId, visiting);
			visiting.delete(entityId);
		}

		const existingRow = first<EntityRow>(
			db,
			sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND id = ${entityId}`
		);

		if (existingRow) {
			const existing = mapEntityRow(existingRow);
			if (!factsMatchEntity(existing, resolved)) {
				run(db, sql`UPDATE entities
					SET title = ${resolved.title}, status = ${resolved.status}, body = ${resolved.body}, body_source = ${resolved.bodySource}, updated_at = ${resolved.createdAt}
					WHERE tenant_id = ${db.tenantId} AND id = ${entityId}`);
				reconcileStructuralParent(db, entityId, existing.kind, resolved.parentId);
				updated.push(entityId);
			}
		} else {
			const kind = deriveEntityKindFromId(entityId);
			// An entity introduced by the other side of a synchronize belongs
			// to its structural parent's project (resolved before it), or this
			// workspace's own project when it has none - so it is immediately
			// visible to project-scoped reads rather than stranded with a null
			// project_id until the next open's backfill (ISS166 follow-up).
			const projectId = (resolved.parentId ? getEntityProjectId(db, resolved.parentId) : null) ?? db.currentProjectId;
			run(db, sql`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, project_id, created_at, updated_at)
				VALUES (${db.tenantId}, ${entityId}, ${kind}, ${resolved.title}, ${resolved.status}, ${resolved.body}, ${resolved.bodySource}, ${projectId}, ${resolved.createdAt}, ${resolved.createdAt})`);

			bumpCounterPast(db, kind, entityId);

			if (resolved.parentId) {
				reconcileStructuralParent(db, entityId, kind, resolved.parentId);
			}

			created.push(entityId);
		}

		settled.add(entityId);
	}

	for (const entityId of resolvedByEntity.keys()) {
		ensureEntity(entityId, new Set());
	}

	return { created, updated };
}

// The read half of synchronize's relation sync (ISS60/ADR16). Excludes only
// the ONE relation row each entity's `reconcileStructuralParent` will
// already reconstruct from its resolved `parentId` - i.e. a structural-type
// row whose `fromId` equals `toId`'s own latest `parentId`. Everything else
// is included, even a row of a nominally-structural type: a structural type
// like "decomposes" can also be created directly via `link` as a plain
// annotation alongside an entity's real structural parent (e.g. an issue
// tracked by an initiative that's *also* manually linked as "decomposed by"
// another issue) - `reconcileStructuralParent` tolerates that extra row but
// never reconstructs it, so it needs its own sync primitive just like
// "blocks"/"fixes" do. `relations` has no append-only log of its own to
// merge against like `history_entries` does, so this is a plain "list
// everything [not already covered], apply what's missing" pair rather than
// a version-aware merge.
export function listAllRelations(db: SqliteExecutor): RelationRecord[] {
	const structuralRelationTypes = sql.join(STRUCTURAL_RELATION_TYPES.map((relationType) => sql`${relationType}`), sql`, `);
	const rows = all<RelationRow>(db, sql`SELECT r.* FROM relations r WHERE r.tenant_id = ${db.tenantId}
		AND NOT (
			r.type IN (${structuralRelationTypes})
			AND r.from_id = (
				SELECT h.parent_id FROM history_entries h
				WHERE h.tenant_id = r.tenant_id AND h.entity_id = r.to_id
				ORDER BY h.version DESC LIMIT 1
			)
		)`);

	return rows.map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdAt: row.created_at
	}));
}

// The write half (ISS60/ADR16): idempotently inserts whatever relations this
// tenant doesn't already have, keyed by the table's own primary key
// (tenantId, fromId, toId, type).  Must run after `applyResolvedFacts` in
// synchronize's orchestration, so both endpoints of every relation already
// exist as entities on this side (`relations` has FK constraints on both
// from_id and to_id).
export function applyRelations(db: SqliteExecutor, relations: RelationRecord[]): { inserted: number } {
	let inserted = 0;
	for (const relation of relations) {
		const result = insertRelation(db, relation);
		inserted += result.changes;
	}

	return { inserted };
}

export function listOrphans(db: SqliteExecutor, kind?: string): EntityRecord[] {
	if (kind && !isEntityKind(kind)) {
		throw new Error(`Unknown entity kind: ${kind}`);
	}

	const entities = getAllEntities(db);
	const relations = getAllRelations(db);
	const reachable = new Set<string>();

	for (const entity of entities) {
		if (entity.kind !== "initiative") {
			continue;
		}

		for (const id of collectReachableIds(relations, entity.id)) {
			reachable.add(id);
		}
	}

	const statusMap = getDerivedStatusMap(db);
	return entities
		.filter((entity) => {
			if (entity.kind === "initiative") {
				return false;
			}

			if (kind && entity.kind !== kind) {
				return false;
			}

			if (entity.kind === "adr") {
				return false;
			}

			if (entity.kind === "project" || entity.kind === "epic") {
				return false;
			}

			return !reachable.has(entity.id);
		})
		.map((entity) => applyDerivedStatus(entity, statusMap));
}

export function listProjectAdrs(db: SqliteExecutor): EntityRecord[] {
	const entities = getAllEntities(db);
	const relations = getAllRelations(db);
	const childIds = new Set(
		relations.filter((relation) => isStructuralRelationType(relation.type)).map((relation) => relation.toId)
	);

	return entities.filter((entity) => entity.kind === "adr" && !childIds.has(entity.id));
}

export function getDatabaseSnapshot(db: SqliteExecutor): DatabaseSnapshot;
export function getDatabaseSnapshot(db: SqliteExecutor, input: { projectId: string }): ProjectSnapshot;
export function getDatabaseSnapshot(db: SqliteExecutor, input?: { projectId: string }): DatabaseSnapshot | ProjectSnapshot {
	if (input?.projectId && getProjectDiscovery(db, input).kind === "unavailable") {
		return { kind: "unavailable" };
	}

	const currentProjectId = db.currentProjectId;
	if (input?.projectId) {
		db.currentProjectId = input.projectId;
	}

	try {
		const snapshot = getCurrentProjectSnapshot(db);
		return input ? { kind: "available", snapshot } : snapshot;
	} finally {
		db.currentProjectId = currentProjectId;
	}
}

function getCurrentProjectSnapshot(db: SqliteExecutor): DatabaseSnapshot {
	const entities = getAllDerivedEntities(db);
	const entityIds = new Set(entities.map((entity) => entity.id));
	const relations = getAllRelations(db).filter((relation) => entityIds.has(relation.fromId) && entityIds.has(relation.toId));
	const initiatives = entities.filter((entity) => entity.kind === "initiative");
	const structuralRelations = relations.filter((relation) => isStructuralRelationType(relation.type));

	return {
		generatedAt: new Date().toISOString(),
		entities,
		relations,
		orphans: listOrphans(db),
		projectAdrs: listProjectAdrs(db),
		initiatives: initiatives.map((entity) => getInitiativeBundle(db, entity.id, collectReachableIds(structuralRelations, entity.id))),
		contexts: {
			shared: getContextDetails(db),
			initiatives: initiatives.map((entity) => getContextDetails(db, { scopeRef: entity.id }))
		}
	};
}

export function getProjectDiscovery(db: SqliteExecutor, input?: { projectId?: string }): ProjectDiscovery {
	const tenantEntities = getTenantEntities(db);
	const relations = getTenantRelations(db);
	const statusMap = new Map(deriveEntityStatuses(tenantEntities, relations).map((entity) => [entity.id, entity.status]));
	const entities = tenantEntities.map((entity) => applyDerivedStatus(entity, statusMap));
	const projects = entities.filter((entity) => entity.kind === "project" && entity.id !== DEFAULT_PROJECT_ID);
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
			const initiatives = entities.filter(
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


function getEntityOrThrow(executor: SqliteExecutor, entityId: string): EntityRecord {
	return mapDrizzleEntityRow(getSqliteEntityOrThrow(executor, entityId));
}

function mapDrizzleEntityRow(row: DrizzleEntityRow): EntityRecord {
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

function getRelationOrThrow(
	db: SqliteExecutor,
	input: { fromId: string; toId: string; relationType: string }
): RelationRecord {
	const row = first<RelationRow>(db, sql`SELECT * FROM relations
		WHERE tenant_id = ${db.tenantId}
			AND from_id = ${input.fromId}
			AND to_id = ${input.toId}
			AND type = ${input.relationType}`);

	if (!row) {
		throw new Error(`Relation not found: ${input.fromId} -> ${input.toId} as ${input.relationType}`);
	}

	return {
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdAt: row.created_at
	};
}

function getStructuralParentRelations(db: SqliteExecutor, entityId: string): RelationRecord[] {
	const rows = all<RelationRow>(
		db,
		sql`SELECT * FROM relations WHERE tenant_id = ${db.tenantId} AND to_id = ${entityId} ORDER BY from_id, type`
	);

	return rows
		.filter((row) => isStructuralRelationType(row.type))
		.map((row) => ({
			fromId: row.from_id,
			toId: row.to_id,
			type: row.type as RelationType,
			createdAt: row.created_at
		}));
}

function getStructuralPath(db: SqliteExecutor, entityId: string): Array<{ relationType: RelationType; entity: EntityRecord }> {
	const path: Array<{ relationType: RelationType; entity: EntityRecord }> = [];
	const seen = new Set<string>([entityId]);
	let currentId = entityId;

	while (true) {
		const parents = getStructuralParentRelations(db, currentId);

		if (parents.length === 0) {
			return path.reverse();
		}

		if (parents.length > 1) {
			throw new Error(`Cannot build structural path for ${entityId} because ${currentId} has multiple structural parents.`);
		}

		const parent = parents[0];
		if (seen.has(parent.fromId)) {
			throw new Error(`Cannot build structural path for ${entityId} because the structural graph contains a cycle.`);
		}

		seen.add(parent.fromId);
		path.push({
			relationType: parent.type,
			entity: getEntityOrThrow(db, parent.fromId)
		});
		currentId = parent.fromId;
	}
}

function nextEntityId(executor: SqliteExecutor, kind: EntityKind): string {
	const row = executor.drizzle
		.select({ nextValue: counters.nextValue })
		.from(counters)
		.where(and(eq(counters.tenantId, executor.tenantId), eq(counters.kind, kind)))
		.get();

	if (!row) {
		throw new Error(`Missing counter for entity kind: ${kind}`);
	}

	executor.drizzle
		.update(counters)
		.set({ nextValue: row.nextValue + 1 })
		.where(and(eq(counters.tenantId, executor.tenantId), eq(counters.kind, kind)))
		.run();

	return `${ID_PREFIX[kind]}${row.nextValue}`;
}

function insertRelation(db: SqliteExecutor, relation: RelationRecord) {
	return run(db, sql`INSERT OR IGNORE INTO relations (tenant_id, from_id, to_id, type, created_at)
		VALUES (${db.tenantId}, ${relation.fromId}, ${relation.toId}, ${relation.type}, ${relation.createdAt})`);
}

function getNextHistoryVersion(db: SqliteExecutor, entityId: string): number {
	const row = first<{ max_version: number | null }>(
		db,
		sql`SELECT MAX(version) AS max_version FROM history_entries WHERE tenant_id = ${db.tenantId} AND entity_id = ${entityId}`
	)!;

	return (row.max_version ?? 0) + 1;
}

// Appends a FULL snapshot of `entity`'s current trackable facts (title, body,
// bodySource, stored status, structural parent) as the next history version.
// Called after every entity-level write (create/status/body/move - ADR8), so
// "resolve latest" and point-in-time reconstruction are always "read one row".
function appendHistoryEntry(db: SqliteExecutor, entity: EntityRecord, author: string | undefined): void {
	const parentId = getStructuralParentRelations(db, entity.id)[0]?.fromId ?? null;
	const version = getNextHistoryVersion(db, entity.id);

	run(db, sql`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
		VALUES (${randomUUID()}, ${db.tenantId}, ${entity.id}, ${version}, ${author?.trim() || RESERVED_SYSTEM_AUTHOR}, ${entity.title}, ${entity.body}, ${entity.bodySource}, ${entity.status}, ${parentId}, ${entity.updatedAt})`);
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

function getAllEntities(db: SqliteExecutor): EntityRecord[] {
	const rows = all<EntityRow>(
		db,
		sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND project_id = ${db.currentProjectId} ORDER BY id`
	);
	return rows.map(mapEntityRow);
}

function getTenantEntities(db: SqliteExecutor): EntityRecord[] {
	const rows = all<EntityRow>(db, sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} ORDER BY id`);
	return rows.map(mapEntityRow);
}

function getTenantRelations(db: SqliteExecutor): RelationRecord[] {
	const rows = all<RelationRow>(
		db,
		sql`SELECT * FROM relations WHERE tenant_id = ${db.tenantId} ORDER BY from_id, to_id, type`
	);
	return rows.map((row) => ({ fromId: row.from_id, toId: row.to_id, type: row.type as RelationType, createdAt: row.created_at }));
}

/** The `project_id` an entity is stamped with, or null if it predates the ISS166 backfill. */
function getEntityProjectId(db: SqliteExecutor, entityId: string): string | null {
	const row = first<{ projectId: string | null }>(
		db,
		sql`SELECT project_id AS projectId FROM entities WHERE tenant_id = ${db.tenantId} AND id = ${entityId}`
	);
	return row?.projectId ?? null;
}

/**
 * The epic to attach a new parentless initiative to (ADR7's full-chain
 * invariant): this workspace's own project's epic rather than the tenant's
 * one literal `EPIC0`, so an initiative created in a consolidated project's
 * workspace (ISS63) lands under that project, not the sentinel one. Falls
 * back to `DEFAULT_EPIC_ID` for the sentinel/single-project case.
 */
function resolveDefaultEpicId(db: SqliteExecutor): string {
	const row = first<{ id: string }>(db, sql`SELECT entities.id AS id
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.from_id = ${db.currentProjectId}
			AND relations.type = 'contains'
			AND entities.kind = 'epic'
		ORDER BY entities.id
		LIMIT 1`);
	return row?.id ?? DEFAULT_EPIC_ID;
}

function getAllDerivedEntities(db: SqliteExecutor): EntityRecord[] {
	return deriveEntityStatuses(getAllEntities(db), getAllRelations(db));
}

function getDerivedStatusMap(db: SqliteExecutor): Map<string, string> {
	return new Map(getAllDerivedEntities(db).map((entity) => [entity.id, entity.status]));
}

function applyDerivedStatus(entity: EntityRecord, statusMap: Map<string, string>): EntityRecord {
	const derived = statusMap.get(entity.id);
	return derived === undefined || derived === entity.status ? entity : { ...entity, status: derived };
}

function getFixingIssueStatuses(db: SqliteExecutor, storyId: string): string[] {
	const rows = all<{ status: string }>(db, sql`SELECT entities.status
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.type = 'fixes'
			AND relations.to_id = ${storyId}
			AND entities.kind = 'issue'`);

	return rows.map((row) => row.status);
}

function getCreatedStoryStatuses(db: SqliteExecutor, prdId: string): string[] {
	const statusMap = getDerivedStatusMap(db);
	const rows = all<{ id: string }>(db, sql`SELECT entities.id
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.type = 'creates'
			AND relations.from_id = ${prdId}
			AND entities.kind = 'userStory'`);

	return rows.map((row) => statusMap.get(row.id) ?? "");
}

function getConstrainedIssueStatuses(db: SqliteExecutor, adrId: string): string[] {
	const rows = all<{ status: string }>(db, sql`SELECT entities.status
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.type = 'constrains'
			AND relations.from_id = ${adrId}
			AND entities.kind = 'issue'`);

	return rows.map((row) => row.status);
}

function isEntitySuperseded(db: SqliteExecutor, entityId: string, kind: "prd" | "userStory" | "adr"): boolean {
	const row = first(db, sql`SELECT 1
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.type = 'supersedes'
			AND relations.to_id = ${entityId}
			AND entities.kind = ${kind}
		LIMIT 1`);

	return row !== undefined;
}

function getInitiativeChildStatuses(
	db: SqliteExecutor,
	initiativeId: string
): { trackedIssueStatuses: string[]; ownedPrdStatuses: string[] } {
	const statusMap = getDerivedStatusMap(db);
	const reachableIds = collectReachableIds(
		getAllRelations(db).filter((relation) => isStructuralRelationType(relation.type)),
		initiativeId
	);
	reachableIds.delete(initiativeId);
	const entities = getAllEntities(db);

	return {
		trackedIssueStatuses: entities
			.filter((entity) => entity.kind === "issue" && reachableIds.has(entity.id))
			.map((entity) => statusMap.get(entity.id) ?? ""),
		ownedPrdStatuses: entities
			.filter((entity) => entity.kind === "prd" && reachableIds.has(entity.id))
			.map((entity) => statusMap.get(entity.id) ?? "")
	};
}

function getAllRelations(db: SqliteExecutor): RelationRecord[] {
	const rows = all<RelationRow>(db, sql`SELECT relations.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${db.tenantId} AND entities.project_id = ${db.currentProjectId}
		ORDER BY relations.from_id, relations.to_id, relations.type`);
	return rows.map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdAt: row.created_at
	}));
}

function hasTypedPath(db: SqliteExecutor, startId: string, targetId: string, relationType: string): boolean {
	const rows = all<RelationRow>(
		db,
		sql`SELECT * FROM relations WHERE tenant_id = ${db.tenantId} AND type = ${relationType} ORDER BY from_id, to_id`
	);
	const relations = rows.map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdAt: row.created_at
	}));

	return collectReachableIds(relations, startId).has(targetId);
}

function hasStructuralPath(db: SqliteExecutor, startId: string, targetId: string): boolean {
	const relations = getAllRelations(db).filter((relation) => isStructuralRelationType(relation.type));
	return collectReachableIds(relations, startId).has(targetId);
}

function wouldOrphanSubtree(db: SqliteExecutor, relation: RelationRecord): boolean {
	return wouldOrphanSubtreeInGraph(getAllEntities(db), getAllRelations(db), relation);
}

/**
 * Blocks unlinking a "contains" relation that is the sole remaining
 * structural parent of an epic or initiative, which would otherwise silently
 * break the tenant>project>epic>initiative full-chain invariant (ADR7).
 * `wouldOrphanSubtree` does not catch this because initiatives (and, by the
 * same logic, epics reached only through their own descendants) are always
 * their own downward-reachability root.
 */
function wouldBreakFullChainInvariant(db: SqliteExecutor, relation: RelationRecord): boolean {
	if (relation.type !== "contains") {
		return false;
	}

	const target = getEntityOrThrow(db, relation.toId);
	if (target.kind !== "epic" && target.kind !== "initiative") {
		return false;
	}

	const remainingContainsParents = first<{ count: number }>(db, sql`SELECT COUNT(*) AS count FROM relations
		WHERE tenant_id = ${db.tenantId} AND to_id = ${relation.toId} AND type = 'contains'
			AND NOT (from_id = ${relation.fromId} AND to_id = ${relation.toId} AND type = 'contains')`)!;

	return remainingContainsParents.count === 0;
}

function getActiveBlockingIssues(db: SqliteExecutor, entityId: string): EntityRecord[] {
	const rows = all<EntityRow>(db, sql`SELECT entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.type = 'blocks'
			AND relations.to_id = ${entityId}
			AND entities.status != 'done'
		ORDER BY entities.id`);

	return rows.map(mapEntityRow);
}

function getOpenSubIssues(db: SqliteExecutor, issueId: string): EntityRecord[] {
	const statusMap = getDerivedStatusMap(db);
	const rows = all<EntityRow>(db, sql`SELECT entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.from_id = ${issueId}
			AND relations.type = 'decomposes'
		ORDER BY entities.id`);

	return rows
		.map(mapEntityRow)
		.map((entity) => applyDerivedStatus(entity, statusMap))
		.filter((entity) => entity.status !== "done");
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

function tenantParams<T extends Record<string, unknown>>(db: SqliteExecutor, values: T): T & { tenantId: string } {
	return {
		tenantId: db.tenantId,
		...values
	};
}