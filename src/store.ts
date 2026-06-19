import type { DatabaseHandle } from "./database.js";
import { getContextDetails, type ContextDetails } from "./context-store.js";
import {
	getArchiveStatus,
	getAllowedRelationType,
	deriveEntityStatuses,
	getInitialStatus,
	isBodySource,
	isAllowedRelation,
	isEntityKind,
	isInitiativeComplete,
	isStructuralRelationType,
	isValidStatus,
	ID_PREFIX,
	type BodySource,
	type EntityKind,
	type EntityRecord,
	type RelationRecord,
	type RelationType
} from "./domain.js";

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

export type LinkResult = {
	relation: RelationRecord;
	created: boolean;
};

export type EntityDetails = {
	entity: EntityRecord;
	incoming: Array<{ relationType: RelationType; entity: EntityRecord }>;
	outgoing: Array<{ relationType: RelationType; entity: EntityRecord }>;
};

export type InitiativeBundle = {
	initiative: EntityRecord;
	prds: EntityRecord[];
	userStories: EntityRecord[];
	adrs: EntityRecord[];
	issues: EntityRecord[];
	fixLinks: Array<{ issue: EntityRecord; userStory: EntityRecord }>;
	blockerLinks: Array<{ source: EntityRecord; target: EntityRecord }>;
	constrainsLinks: Array<{ adr: EntityRecord; issue: EntityRecord }>;
	handoffs: HandoffRecord[];
};

export type HandoffRecord = {
	id: string;
	entityId: string;
	initiativeId: string | null;
	summary: string;
	body: string;
	createdAt: string;
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

export type StatusUpdateResult = {
	entity: EntityRecord;
	previousStatus: string;
};

export type UnlinkResult = {
	relation: RelationRecord;
	removed: boolean;
};

export type DeleteResult = {
	entity: EntityRecord;
	removed: boolean;
};

export type MoveResult = {
	entity: EntityRecord;
	previousParentId: string | null;
	newParentId: string;
	relationType: RelationType;
};

export function createEntity(
	db: DatabaseHandle,
	input: { kind: string; title: string; parentId?: string; status?: string; body?: string }
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
	const parent = input.parentId ? getEntityOrThrow(db, input.parentId) : null;
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

		return getEntityOrThrow(db, id);
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
	input: { entityId: string; status: string }
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

	return {
		entity: getEntityOrThrow(db, input.entityId),
		previousStatus
	};
}

export function setEntityBody(
	db: DatabaseHandle,
	input: { entityId: string; body: string; bodySource?: BodySource }
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

	return getEntityOrThrow(db, input.entityId);
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
	input: { entityId: string; newParentId: string }
): MoveResult {
	if (input.entityId === input.newParentId) {
		throw new Error("Cannot move an entity under itself.");
	}

	const entity = getEntityOrThrow(db, input.entityId);
	const newParent = getEntityOrThrow(db, input.newParentId);

	if (entity.kind === "initiative") {
		throw new Error("Initiatives do not have a structural parent and cannot be moved.");
	}

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
	const rows = db
		.prepare(
			`SELECT relations.type AS relation_type, entities.id, entities.kind
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			 WHERE relations.tenant_id = @tenantId
			   AND relations.from_id = @initiativeId
			   AND relations.type IN ('tracks', 'owns')`
		)
		.all(tenantParams(db, { initiativeId })) as Array<{ relation_type: string; id: string; kind: string }>;

	return {
		trackedIssueStatuses: rows
			.filter((row) => row.relation_type === "tracks" && row.kind === "issue")
			.map((row) => statusMap.get(row.id) ?? ""),
		ownedPrdStatuses: rows
			.filter((row) => row.relation_type === "owns" && row.kind === "prd")
			.map((row) => statusMap.get(row.id) ?? "")
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
	if (!["owns", "records", "tracks", "creates"].includes(relation.type)) {
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