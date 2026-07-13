import { randomUUID } from "node:crypto";

import type { DatabaseHandle } from "./database.js";
import { getContextDetails, type ContextDetails } from "./context-store.js";
import {
	collectReachableIds,
	getArchiveStatus,
	getAllowedRelationType,
	deriveEntityKindFromId,
	deriveEntityStatuses,
	DEFAULT_EPIC_ID,
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

export {
	type DatabaseSnapshot,
	type DeleteResult,
	type EntityDetails,
	type HandoffDeleteResult,
	type HandoffDetails,
	type HandoffRecord,
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

type RelationRow = {
	from_id: string;
	to_id: string;
	type: string;
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

export function createEntity(
	db: DatabaseHandle,
	input: { kind: string; title: string; parentId?: string; status?: string; body?: string; author?: string }
): EntityRecord {
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
	const parentId = input.parentId ?? (kind === "initiative" ? DEFAULT_EPIC_ID : undefined);
	const parent = parentId ? getEntityOrThrow(db, parentId) : null;
	const relationType = parent ? getAllowedRelationType(parent.kind, kind) : null;

	if (parent && !relationType) {
		throw new Error(`Cannot create ${kind} under ${parent.kind}.`);
	}

	const tx = db.transaction(() => {
		const id = nextEntityId(db, kind);
		db.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES (@tenantId, @id, @kind, @title, @status, @body, @bodySource, @createdAt, @updatedAt)`
		).run(tenantParams(db, {
			id,
			kind,
			title,
			status,
			body,
			bodySource,
			createdAt: now,
			updatedAt: now
		}));

		if (parent && relationType) {
			insertRelation(db, {
				fromId: parent.id,
				toId: id,
				type: relationType,
				createdAt: now
			});
		}

		const entity = getEntityOrThrow(db, id);
		appendHistoryEntry(db, entity, input.author);
		return entity;
	});

	return tx();
}

export function linkEntities(
	db: DatabaseHandle,
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
	db: DatabaseHandle,
	input: { entityId: string; status: string; author?: string }
): StatusUpdateResult {
	const entity = getEntityOrThrow(db, input.entityId);

	if (!isValidStatus(entity.kind, input.status)) {
		throw new Error(`Invalid status for ${entity.kind}: ${input.status}`);
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
		if (isAdrSuperseded(db, entity.id)) {
			throw new Error(
				`${entity.id} status is derived (superseded) because another ADR supersedes it.`
			);
		}
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

	db.prepare(
		`UPDATE entities
		 SET status = @status,
		     updated_at = @updatedAt
		 WHERE tenant_id = @tenantId
		   AND id = @entityId`
	).run(tenantParams(db, {
		entityId: input.entityId,
		status: input.status,
		updatedAt
	}));

	const updated = getEntityOrThrow(db, input.entityId);
	appendHistoryEntry(db, updated, input.author);

	return {
		entity: updated,
		previousStatus
	};
}

export function setEntityBody(
	db: DatabaseHandle,
	input: { entityId: string; body: string; bodySource?: BodySource; author?: string }
): EntityRecord {
	getEntityOrThrow(db, input.entityId);

	const updatedAt = new Date().toISOString();
	const bodySource = input.bodySource ?? "authored";

	db.prepare(
		`UPDATE entities
		 SET body = @body,
		     body_source = @bodySource,
		     updated_at = @updatedAt
		 WHERE tenant_id = @tenantId
		   AND id = @entityId`
	).run(tenantParams(db, {
		entityId: input.entityId,
		body: input.body,
		bodySource,
		updatedAt
	}));

	const updated = getEntityOrThrow(db, input.entityId);
	appendHistoryEntry(db, updated, input.author);
	return updated;
}

export function archiveEntity(db: DatabaseHandle, input: { entityId: string }): StatusUpdateResult {
	const entity = getEntityOrThrow(db, input.entityId);
	return updateEntityStatus(db, {
		entityId: input.entityId,
		status: getArchiveStatus(entity.kind)
	});
}

export function moveEntity(
	db: DatabaseHandle,
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
			db.prepare(
				`DELETE FROM relations
				 WHERE tenant_id = @tenantId
				   AND from_id = @fromId
				   AND to_id = @toId
				   AND type = @type`
			).run(tenantParams(db, {
				fromId: relation.fromId,
				toId: relation.toId,
				type: relation.type
			}));
		}

		insertRelation(db, {
			fromId: newParent.id,
			toId: entity.id,
			type: relationType,
			createdAt: updatedAt
		});

		db.prepare(
			`UPDATE entities
			 SET updated_at = @updatedAt
			 WHERE tenant_id = @tenantId
			   AND id = @entityId`
		).run(tenantParams(db, {
			entityId: entity.id,
			updatedAt
		}));

		appendHistoryEntry(db, getEntityOrThrow(db, entity.id), input.author);
	})();

	return {
		entity: getEntityOrThrow(db, entity.id),
		previousParentId,
		newParentId: newParent.id,
		relationType
	};
}

export function unlinkEntities(
	db: DatabaseHandle,
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

	const result = db.prepare(
		`DELETE FROM relations
		 WHERE tenant_id = @tenantId
		   AND from_id = @fromId
		   AND to_id = @toId
		   AND type = @type`
	).run(tenantParams(db, {
		fromId: relation.fromId,
		toId: relation.toId,
		type: relation.type
	}));

	return {
		relation,
		removed: result.changes > 0
	};
}

export function deleteEntity(db: DatabaseHandle, input: { entityId: string }): DeleteResult {
	const entity = getEntityOrThrow(db, input.entityId);
	const outgoingCount = db
		.prepare(`SELECT COUNT(*) as count FROM relations WHERE tenant_id = ? AND from_id = ?`)
		.get(db.tenantId, input.entityId) as { count: number };

	if (outgoingCount.count > 0) {
		throw new Error(`Cannot delete ${entity.id} while it still has outgoing relations. Unlink or delete dependents first.`);
	}

	const result = db.prepare(`DELETE FROM entities WHERE tenant_id = ? AND id = ?`).run(db.tenantId, input.entityId);

	return {
		entity,
		removed: result.changes > 0
	};
}

export function getEntityDetails(db: DatabaseHandle, entityId: string): EntityDetails {
	const entity = getEntityOrThrow(db, entityId);
	const incomingRows = db
		.prepare(
			`SELECT relations.type, entities.*
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			 WHERE relations.tenant_id = @tenantId
			   AND relations.to_id = @entityId
			 ORDER BY entities.id`
		)
		.all(tenantParams(db, { entityId })) as Array<EntityRow & { type: string }>;
	const outgoingRows = db
		.prepare(
			`SELECT relations.type, entities.*
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			 WHERE relations.tenant_id = @tenantId
			   AND relations.from_id = @entityId
			 ORDER BY entities.id`
		)
		.all(tenantParams(db, { entityId })) as Array<EntityRow & { type: string }>;

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

export function getInitiativeBundle(db: DatabaseHandle, initiativeId: string): InitiativeBundle {
	const initiative = getEntityOrThrow(db, initiativeId);

	if (initiative.kind !== "initiative") {
		throw new Error(`${initiativeId} is not an initiative.`);
	}

	const entityRows = db
		.prepare(
			`WITH RECURSIVE reachable(id) AS (
			   SELECT @initiativeId
			   UNION
			   SELECT relations.to_id
			   FROM relations
			   JOIN reachable ON relations.from_id = reachable.id
			   WHERE relations.tenant_id = @tenantId
			 )
			 SELECT entities.*
			 FROM entities
			 JOIN reachable ON entities.id = reachable.id
			 WHERE entities.tenant_id = @tenantId
			 ORDER BY entities.id`
		)
		.all(tenantParams(db, { initiativeId })) as EntityRow[];
	const relationRows = db
		.prepare(
			`WITH RECURSIVE reachable(id) AS (
			   SELECT @initiativeId
			   UNION
			   SELECT relations.to_id
			   FROM relations
			   JOIN reachable ON relations.from_id = reachable.id
			   WHERE relations.tenant_id = @tenantId
			 )
			 SELECT relations.*
			 FROM relations
			 JOIN reachable source ON relations.from_id = source.id
			 JOIN reachable target ON relations.to_id = target.id
			 WHERE relations.tenant_id = @tenantId`
		)
		.all(tenantParams(db, { initiativeId })) as RelationRow[];

	const entities = entityRows.map(mapEntityRow);
	const statusMap = getDerivedStatusMap(db);
	const derivedEntities = entities.map((entity) => applyDerivedStatus(entity, statusMap));
	const entityById = new Map(derivedEntities.map((entity) => [entity.id, entity]));

	return {
		initiative: applyDerivedStatus(initiative, statusMap),
		prds: derivedEntities.filter((entity) => entity.kind === "prd"),
		userStories: derivedEntities.filter((entity) => entity.kind === "userStory"),
		adrs: derivedEntities.filter((entity) => entity.kind === "adr"),
		issues: derivedEntities.filter((entity) => entity.kind === "issue"),
		fixLinks: relationRows
			.filter((relation) => relation.type === "fixes")
			.map((relation) => ({
				issue: entityById.get(relation.from_id)!,
				userStory: entityById.get(relation.to_id)!
			})),
		subIssueLinks: relationRows
			.filter((relation) => relation.type === "decomposes")
			.map((relation) => ({
				parent: entityById.get(relation.from_id)!,
				issue: entityById.get(relation.to_id)!
			})),
		blockerLinks: relationRows
			.filter((relation) => relation.type === "blocks")
			.map((relation) => ({
				source: entityById.get(relation.from_id)!,
				target: entityById.get(relation.to_id)!
			})),
		constrainsLinks: relationRows
			.filter((relation) => relation.type === "constrains")
			.map((relation) => ({
				adr: entityById.get(relation.from_id)!,
				issue: entityById.get(relation.to_id)!
			})),
		handoffs: listHandoffs(db, { initiativeId })
	};
}

export function getHandoffDetails(db: DatabaseHandle, entityId: string): HandoffDetails {
	const focus = getEntityDetails(db, entityId);
	const structuralPath = getStructuralPath(db, entityId);
	const initiativeAncestor =
		focus.entity.kind === "initiative"
			? focus.entity
			: structuralPath.find((entry) => entry.entity.kind === "initiative")?.entity ?? null;

	return {
		focus,
		structuralPath,
		initiative: initiativeAncestor ? getInitiativeBundle(db, initiativeAncestor.id) : null,
		orphaned: focus.entity.kind !== "initiative" && initiativeAncestor === null,
		activeBlockers: focus.entity.kind === "issue" ? getActiveBlockingIssues(db, focus.entity.id) : [],
		handoffs: initiativeAncestor
			? listHandoffs(db, { initiativeId: initiativeAncestor.id })
			: listHandoffs(db, { entityId: focus.entity.id })
	};
}

export function createHandoff(
	db: DatabaseHandle,
	input: { entityId: string; summary?: string; body: string }
): HandoffRecord {
	const focus = getEntityOrThrow(db, input.entityId);
	const initiativeId = resolveOwningInitiativeId(db, focus);
	const summary = normalizeHandoffSummary(input.summary);
	const body = normalizeHandoffBody(input.body);
	const now = new Date().toISOString();

	const tx = db.transaction(() => {
		const id = nextHandoffId(db);
		db.prepare(
			`INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
			 VALUES (@tenantId, @id, @entityId, @initiativeId, @summary, @body, @createdAt)`
		).run(tenantParams(db, {
			id,
			entityId: focus.id,
			initiativeId,
			summary,
			body,
			createdAt: now
		}));

		return getHandoffOrThrow(db, id);
	});

	return tx();
}

export function updateHandoff(
	db: DatabaseHandle,
	input: { handoffId: string; summary?: string; body?: string }
): HandoffRecord {
	const current = getHandoffOrThrow(db, input.handoffId);

	if (input.summary === undefined && input.body === undefined) {
		throw new Error("Provide --summary, --body, or --body-file to update a handoff.");
	}

	const summary = input.summary === undefined ? current.summary : normalizeHandoffSummary(input.summary);
	const body = input.body === undefined ? current.body : normalizeHandoffBody(input.body);

	db.prepare(
		`UPDATE handoffs
		 SET summary = @summary,
		     body = @body
		 WHERE tenant_id = @tenantId
		   AND id = @handoffId`
	).run(tenantParams(db, {
		handoffId: input.handoffId,
		summary,
		body
	}));

	return getHandoffOrThrow(db, input.handoffId);
}

export function deleteHandoff(db: DatabaseHandle, input: { handoffId: string }): HandoffDeleteResult {
	const handoff = getHandoffOrThrow(db, input.handoffId);
	const result = db.prepare(`DELETE FROM handoffs WHERE tenant_id = ? AND id = ?`).run(db.tenantId, input.handoffId);

	return {
		handoff,
		removed: result.changes > 0
	};
}

export function listHandoffs(db: DatabaseHandle, filter?: { initiativeId?: string; entityId?: string }): HandoffRecord[] {
	const conditions = ["tenant_id = @tenantId"];
	const params: Record<string, unknown> = { tenantId: db.tenantId };

	if (filter?.initiativeId !== undefined) {
		conditions.push("initiative_id = @initiativeId");
		params.initiativeId = filter.initiativeId;
	}

	if (filter?.entityId !== undefined) {
		conditions.push("entity_id = @entityId");
		params.entityId = filter.entityId;
	}

	const rows = db
		.prepare(`SELECT * FROM handoffs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC`)
		.all(params) as HandoffRow[];

	return rows.map(mapHandoffRow);
}

export function listEntities(db: DatabaseHandle, kind: string): EntityRecord[] {
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
export function listEntityHistory(db: DatabaseHandle, entityId: string): HistoryEntryRecord[] {
	const rows = db
		.prepare(`SELECT * FROM history_entries WHERE tenant_id = ? AND entity_id = ? ORDER BY version ASC`)
		.all(db.tenantId, entityId) as HistoryEntryRow[];

	return rows.map(mapHistoryEntryRow);
}

// Every history entry for the tenant, across every entity (ISS57/ADR16):
// the read half of synchronize's merge substrate. No entity filter and no
// ordering guarantee beyond "everything" - the merge algorithm (slice 2)
// groups/orders per entity itself.
export function listAllHistoryEntries(db: DatabaseHandle): HistoryEntryRecord[] {
	const rows = db.prepare(`SELECT * FROM history_entries WHERE tenant_id = ?`).all(db.tenantId) as HistoryEntryRow[];

	return rows.map(mapHistoryEntryRow);
}

// The write half of synchronize's merge substrate (ISS57/ADR16): inserts
// only the entries this tenant doesn't already have, keyed by the entry's
// own globally-unique `id` - so re-applying the same (or a superset) batch
// is a true no-op. Deliberately does not touch the live-cache `entities`
// table; recomputing "resolve latest" from the merged log and updating the
// live cache is the merge algorithm/synchronize command's job (slices 2/3),
// not this seam primitive's.
export function applyHistoryEntries(db: DatabaseHandle, entries: HistoryEntryRecord[]): { inserted: number } {
	const insert = db.prepare(
		`INSERT OR IGNORE INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
		 VALUES (@id, @tenantId, @entityId, @version, @author, @title, @body, @bodySource, @status, @parentId, @createdAt)`
	);

	let inserted = 0;
	for (const entry of entries) {
		const result = insert.run(tenantParams(db, {
			id: entry.id,
			entityId: entry.entityId,
			version: entry.version,
			author: entry.author,
			title: entry.title,
			body: entry.body,
			bodySource: entry.bodySource,
			status: entry.status,
			parentId: entry.parentId,
			createdAt: entry.createdAt
		}));
		inserted += result.changes;
	}

	return { inserted };
}

// Bumps `kind`'s id counter past `entityId`'s numeric suffix if needed, so a
// later local `createEntity` of that kind can never collide with an id that
// arrived via synchronize instead of this side's own counter (ISS59).
function bumpCounterPast(db: DatabaseHandle, kind: EntityKind, entityId: string): void {
	const numericSuffix = Number(entityId.slice(ID_PREFIX[kind].length));
	if (!Number.isFinite(numericSuffix)) {
		return;
	}

	db.prepare(`UPDATE counters SET next_value = max(next_value, @next) WHERE tenant_id = @tenantId AND kind = @kind`).run(
		tenantParams(db, { kind, next: numericSuffix + 1 })
	);
}

// Reconciles `entityId`'s structural parent relation to `newParentId`,
// bypassing `getAllowedRelationType`'s usual "does this pairing make sense"
// guard only on the DELETE side, since a resolved history entry's parent is
// already an accepted fact from whichever side authored it. The parent MUST
// already exist locally by the time this runs (`applyResolvedFacts` ensures
// parents before children), so its real kind is available for the INSERT
// side's relation-type lookup.
function reconcileStructuralParent(db: DatabaseHandle, entityId: string, kind: EntityKind, newParentId: string | null): void {
	const currentParents = getStructuralParentRelations(db, entityId);
	const currentParentId = currentParents[0]?.fromId ?? null;

	if (currentParentId === newParentId) {
		return;
	}

	for (const relation of currentParents) {
		db.prepare(
			`DELETE FROM relations WHERE tenant_id = @tenantId AND from_id = @fromId AND to_id = @toId AND type = @type`
		).run(tenantParams(db, { fromId: relation.fromId, toId: entityId, type: relation.type }));
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
	db: DatabaseHandle,
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

		const existingRow = db.prepare(`SELECT * FROM entities WHERE tenant_id = ? AND id = ?`).get(db.tenantId, entityId) as
			| EntityRow
			| undefined;

		if (existingRow) {
			const existing = mapEntityRow(existingRow);
			if (!factsMatchEntity(existing, resolved)) {
				db.prepare(
					`UPDATE entities
					 SET title = @title, status = @status, body = @body, body_source = @bodySource, updated_at = @updatedAt
					 WHERE tenant_id = @tenantId AND id = @entityId`
				).run(tenantParams(db, {
					entityId,
					title: resolved.title,
					status: resolved.status,
					body: resolved.body,
					bodySource: resolved.bodySource,
					updatedAt: resolved.createdAt
				}));
				reconcileStructuralParent(db, entityId, existing.kind, resolved.parentId);
				updated.push(entityId);
			}
		} else {
			const kind = deriveEntityKindFromId(entityId);
			db.prepare(
				`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
				 VALUES (@tenantId, @id, @kind, @title, @status, @body, @bodySource, @createdAt, @updatedAt)`
			).run(tenantParams(db, {
				id: entityId,
				kind,
				title: resolved.title,
				status: resolved.status,
				body: resolved.body,
				bodySource: resolved.bodySource,
				createdAt: resolved.createdAt,
				updatedAt: resolved.createdAt
			}));

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
export function listAllRelations(db: DatabaseHandle): RelationRecord[] {
	const structuralPlaceholders = STRUCTURAL_RELATION_TYPES.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT r.* FROM relations r WHERE r.tenant_id = ?
			 AND NOT (
			   r.type IN (${structuralPlaceholders})
			   AND r.from_id = (
			     SELECT h.parent_id FROM history_entries h
			     WHERE h.tenant_id = r.tenant_id AND h.entity_id = r.to_id
			     ORDER BY h.version DESC LIMIT 1
			   )
			 )`
		)
		.all(db.tenantId, ...STRUCTURAL_RELATION_TYPES) as RelationRow[];

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
export function applyRelations(db: DatabaseHandle, relations: RelationRecord[]): { inserted: number } {
	let inserted = 0;
	for (const relation of relations) {
		const result = insertRelation(db, relation);
		inserted += result.changes;
	}

	return { inserted };
}

// The read half of synchronize's handoff sync (ISS62/ADR16): every handoff
// this tenant has, with no filter. Handoffs have no append-only log or
// updated_at column of their own to merge against, so - like relations -
// this is a plain "list everything, apply what's missing" pair rather than
// a version-aware merge. `updateHandoff`'s in-place edits made on one side
// after a handoff has already synced to the other won't propagate on a
// later sync; only brand-new handoffs (and deletes never propagate either).
export function listAllHandoffs(db: DatabaseHandle): HandoffRecord[] {
	const rows = db.prepare(`SELECT * FROM handoffs WHERE tenant_id = ?`).all(db.tenantId) as HandoffRow[];
	return rows.map(mapHandoffRow);
}

// The write half (ISS62/ADR16): idempotently inserts whatever handoffs this
// tenant doesn't already have, keyed by the table's own primary key
// (tenantId, id). Must run after `applyResolvedFacts` in synchronize's
// orchestration, so both `entity_id`/`initiative_id` FK targets already
// exist as entities on this side.
export function applyHandoffs(db: DatabaseHandle, handoffs: HandoffRecord[]): { inserted: number } {
	let inserted = 0;
	for (const handoff of handoffs) {
		const result = db
			.prepare(
				`INSERT OR IGNORE INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
				 VALUES (@tenantId, @id, @entityId, @initiativeId, @summary, @body, @createdAt)`
			)
			.run(tenantParams(db, handoff));
		inserted += result.changes;
	}

	return { inserted };
}

export function listOrphans(db: DatabaseHandle, kind?: string): EntityRecord[] {
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

export function listProjectAdrs(db: DatabaseHandle): EntityRecord[] {
	const entities = getAllEntities(db);
	const relations = getAllRelations(db);
	const childIds = new Set(
		relations.filter((relation) => isStructuralRelationType(relation.type)).map((relation) => relation.toId)
	);

	return entities.filter((entity) => entity.kind === "adr" && !childIds.has(entity.id));
}

export function getDatabaseSnapshot(db: DatabaseHandle): DatabaseSnapshot {
	const entities = getAllDerivedEntities(db);
	const initiatives = entities.filter((entity) => entity.kind === "initiative");

	return {
		generatedAt: new Date().toISOString(),
		entities,
		relations: getAllRelations(db),
		orphans: listOrphans(db),
		projectAdrs: listProjectAdrs(db),
		initiatives: initiatives.map((entity) => getInitiativeBundle(db, entity.id)),
		contexts: {
			shared: getContextDetails(db),
			initiatives: initiatives.map((entity) => getContextDetails(db, { scopeRef: entity.id }))
		}
	};
}

function getEntityOrThrow(db: DatabaseHandle, entityId: string): EntityRecord {
	const row = db.prepare(`SELECT * FROM entities WHERE tenant_id = ? AND id = ?`).get(db.tenantId, entityId) as EntityRow | undefined;

	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return mapEntityRow(row);
}

function getRelationOrThrow(
	db: DatabaseHandle,
	input: { fromId: string; toId: string; relationType: string }
): RelationRecord {
	const row = db
		.prepare(`SELECT * FROM relations WHERE tenant_id = @tenantId AND from_id = @fromId AND to_id = @toId AND type = @type`)
		.get(tenantParams(db, {
			fromId: input.fromId,
			toId: input.toId,
			type: input.relationType
		})) as RelationRow | undefined;

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

function getStructuralParentRelations(db: DatabaseHandle, entityId: string): RelationRecord[] {
	const rows = db
		.prepare(`SELECT * FROM relations WHERE tenant_id = ? AND to_id = ? ORDER BY from_id, type`)
		.all(db.tenantId, entityId) as RelationRow[];

	return rows
		.filter((row) => isStructuralRelationType(row.type))
		.map((row) => ({
			fromId: row.from_id,
			toId: row.to_id,
			type: row.type as RelationType,
			createdAt: row.created_at
		}));
}

function getStructuralPath(db: DatabaseHandle, entityId: string): Array<{ relationType: RelationType; entity: EntityRecord }> {
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

function nextEntityId(db: DatabaseHandle, kind: EntityKind): string {
	const row = db.prepare(`SELECT next_value FROM counters WHERE tenant_id = ? AND kind = ?`).get(db.tenantId, kind) as { next_value: number } | undefined;

	if (!row) {
		throw new Error(`Counter missing for entity kind: ${kind}`);
	}

	db.prepare(`UPDATE counters SET next_value = next_value + 1 WHERE tenant_id = ? AND kind = ?`).run(db.tenantId, kind);
	return `${ID_PREFIX[kind]}${row.next_value}`;
}

function nextHandoffId(db: DatabaseHandle): string {
	const row = db.prepare(`SELECT next_value FROM counters WHERE tenant_id = ? AND kind = 'handoff'`).get(db.tenantId) as { next_value: number } | undefined;

	if (!row) {
		throw new Error("Counter missing for handoffs.");
	}

	db.prepare(`UPDATE counters SET next_value = next_value + 1 WHERE tenant_id = ? AND kind = 'handoff'`).run(db.tenantId);
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

function resolveOwningInitiativeId(db: DatabaseHandle, focus: EntityRecord): string | null {
	if (focus.kind === "initiative") {
		return focus.id;
	}

	const structuralPath = getStructuralPath(db, focus.id);
	return structuralPath.find((entry) => entry.entity.kind === "initiative")?.entity.id ?? null;
}

function getHandoffOrThrow(db: DatabaseHandle, handoffId: string): HandoffRecord {
	const row = db.prepare(`SELECT * FROM handoffs WHERE tenant_id = ? AND id = ?`).get(db.tenantId, handoffId) as HandoffRow | undefined;

	if (!row) {
		throw new Error(`Handoff not found: ${handoffId}`);
	}

	return mapHandoffRow(row);
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

function insertRelation(db: DatabaseHandle, relation: RelationRecord) {
	return db
		.prepare(
			`INSERT OR IGNORE INTO relations (tenant_id, from_id, to_id, type, created_at)
			 VALUES (@tenantId, @fromId, @toId, @type, @createdAt)`
		)
		.run(tenantParams(db, relation));
}

function getNextHistoryVersion(db: DatabaseHandle, entityId: string): number {
	const row = db
		.prepare(`SELECT MAX(version) AS max_version FROM history_entries WHERE tenant_id = ? AND entity_id = ?`)
		.get(db.tenantId, entityId) as { max_version: number | null };

	return (row.max_version ?? 0) + 1;
}

// Appends a FULL snapshot of `entity`'s current trackable facts (title, body,
// bodySource, stored status, structural parent) as the next history version.
// Called after every entity-level write (create/status/body/move - ADR8), so
// "resolve latest" and point-in-time reconstruction are always "read one row".
function appendHistoryEntry(db: DatabaseHandle, entity: EntityRecord, author: string | undefined): void {
	const parentId = getStructuralParentRelations(db, entity.id)[0]?.fromId ?? null;
	const version = getNextHistoryVersion(db, entity.id);

	db.prepare(
		`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
		 VALUES (@id, @tenantId, @entityId, @version, @author, @title, @body, @bodySource, @status, @parentId, @createdAt)`
	).run(tenantParams(db, {
		id: randomUUID(),
		entityId: entity.id,
		version,
		author: author?.trim() || RESERVED_SYSTEM_AUTHOR,
		title: entity.title,
		body: entity.body,
		bodySource: entity.bodySource,
		status: entity.status,
		parentId,
		createdAt: entity.updatedAt
	}));
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

function getAllEntities(db: DatabaseHandle): EntityRecord[] {
	const rows = db.prepare(`SELECT * FROM entities WHERE tenant_id = ? ORDER BY id`).all(db.tenantId) as EntityRow[];
	return rows.map(mapEntityRow);
}

function getAllDerivedEntities(db: DatabaseHandle): EntityRecord[] {
	return deriveEntityStatuses(getAllEntities(db), getAllRelations(db));
}

function getDerivedStatusMap(db: DatabaseHandle): Map<string, string> {
	return new Map(getAllDerivedEntities(db).map((entity) => [entity.id, entity.status]));
}

function applyDerivedStatus(entity: EntityRecord, statusMap: Map<string, string>): EntityRecord {
	const derived = statusMap.get(entity.id);
	return derived === undefined || derived === entity.status ? entity : { ...entity, status: derived };
}

function getFixingIssueStatuses(db: DatabaseHandle, storyId: string): string[] {
	const rows = db
		.prepare(
			`SELECT entities.status
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			 WHERE relations.tenant_id = @tenantId
			   AND relations.type = 'fixes'
			   AND relations.to_id = @storyId
			   AND entities.kind = 'issue'`
		)
		.all(tenantParams(db, { storyId })) as Array<{ status: string }>;

	return rows.map((row) => row.status);
}

function getCreatedStoryStatuses(db: DatabaseHandle, prdId: string): string[] {
	const statusMap = getDerivedStatusMap(db);
	const rows = db
		.prepare(
			`SELECT entities.id
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			 WHERE relations.tenant_id = @tenantId
			   AND relations.type = 'creates'
			   AND relations.from_id = @prdId
			   AND entities.kind = 'userStory'`
		)
		.all(tenantParams(db, { prdId })) as Array<{ id: string }>;

	return rows.map((row) => statusMap.get(row.id) ?? "");
}

function getConstrainedIssueStatuses(db: DatabaseHandle, adrId: string): string[] {
	const rows = db
		.prepare(
			`SELECT entities.status
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			 WHERE relations.tenant_id = @tenantId
			   AND relations.type = 'constrains'
			   AND relations.from_id = @adrId
			   AND entities.kind = 'issue'`
		)
		.all(tenantParams(db, { adrId })) as Array<{ status: string }>;

	return rows.map((row) => row.status);
}

function isAdrSuperseded(db: DatabaseHandle, adrId: string): boolean {
	const row = db
		.prepare(
			`SELECT 1
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			 WHERE relations.tenant_id = @tenantId
			   AND relations.type = 'supersedes'
			   AND relations.to_id = @adrId
			   AND entities.kind = 'adr'
			 LIMIT 1`
		)
		.get(tenantParams(db, { adrId }));

	return row !== undefined;
}

function getInitiativeChildStatuses(
	db: DatabaseHandle,
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

function getAllRelations(db: DatabaseHandle): RelationRecord[] {
	const rows = db.prepare(`SELECT * FROM relations WHERE tenant_id = ? ORDER BY from_id, to_id, type`).all(db.tenantId) as RelationRow[];
	return rows.map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdAt: row.created_at
	}));
}

function hasTypedPath(db: DatabaseHandle, startId: string, targetId: string, relationType: string): boolean {
	const rows = db
		.prepare(`SELECT * FROM relations WHERE tenant_id = ? AND type = ? ORDER BY from_id, to_id`)
		.all(db.tenantId, relationType) as RelationRow[];
	const relations = rows.map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdAt: row.created_at
	}));

	return collectReachableIds(relations, startId).has(targetId);
}

function hasStructuralPath(db: DatabaseHandle, startId: string, targetId: string): boolean {
	const relations = getAllRelations(db).filter((relation) => isStructuralRelationType(relation.type));
	return collectReachableIds(relations, startId).has(targetId);
}

function wouldOrphanSubtree(db: DatabaseHandle, relation: RelationRecord): boolean {
	if (!isStructuralRelationType(relation.type)) {
		return false;
	}

	const currentRelations = getAllRelations(db);
	const remainingRelations = currentRelations.filter(
		(candidate) =>
			!(
				candidate.fromId === relation.fromId &&
				candidate.toId === relation.toId &&
				candidate.type === relation.type
			)
	);
	const entities = getAllEntities(db);
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

/**
 * Blocks unlinking a "contains" relation that is the sole remaining
 * structural parent of an epic or initiative, which would otherwise silently
 * break the tenant>project>epic>initiative full-chain invariant (ADR7).
 * `wouldOrphanSubtree` does not catch this because initiatives (and, by the
 * same logic, epics reached only through their own descendants) are always
 * their own downward-reachability root.
 */
function wouldBreakFullChainInvariant(db: DatabaseHandle, relation: RelationRecord): boolean {
	if (relation.type !== "contains") {
		return false;
	}

	const target = getEntityOrThrow(db, relation.toId);
	if (target.kind !== "epic" && target.kind !== "initiative") {
		return false;
	}

	const remainingContainsParents = db
		.prepare(
			`SELECT COUNT(*) AS count FROM relations
			 WHERE tenant_id = @tenantId AND to_id = @toId AND type = 'contains'
			   AND NOT (from_id = @fromId AND to_id = @toId AND type = 'contains')`
		)
		.get(tenantParams(db, { toId: relation.toId, fromId: relation.fromId })) as { count: number };

	return remainingContainsParents.count === 0;
}

function getActiveBlockingIssues(db: DatabaseHandle, entityId: string): EntityRecord[] {
	const rows = db
		.prepare(
			`SELECT entities.*
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			 WHERE relations.tenant_id = @tenantId
			   AND relations.type = 'blocks'
			   AND relations.to_id = @entityId
			   AND entities.status != 'done'
			 ORDER BY entities.id`
		)
		.all(tenantParams(db, { entityId })) as EntityRow[];

	return rows.map(mapEntityRow);
}

function getOpenSubIssues(db: DatabaseHandle, issueId: string): EntityRecord[] {
	const statusMap = getDerivedStatusMap(db);
	const rows = db
		.prepare(
			`SELECT entities.*
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			 WHERE relations.tenant_id = @tenantId
			   AND relations.from_id = @issueId
			   AND relations.type = 'decomposes'
			 ORDER BY entities.id`
		)
		.all(tenantParams(db, { issueId })) as EntityRow[];

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

function tenantParams<T extends Record<string, unknown>>(db: DatabaseHandle, values: T): T & { tenantId: string } {
	return {
		tenantId: db.tenantId,
		...values
	};
}