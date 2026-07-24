import { randomUUID } from "node:crypto";

import { and, eq, sql, type SQL } from "drizzle-orm";

import { getSqliteEntityOrThrow, resolveSqliteEntity, type SqliteExecutor } from "../../db/sqlite-executor.js";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";
import { recordHistoryMaterialization } from "../history-diagnostics.js";
import { entities } from "../../schema.js";
import { getContextDetails, type ContextDetails } from "../context/context-store.js";
import {
	collectReachableIds,
	computeEntityContentHash,
	applyReversePatch,
	createReverseFieldPatch,
	deriveMigratedEntityIdentity,
	encodeEntityRecordKey,
	ENTITY_REVERSE_PATCH_REGISTRY,
	EntityConflictError,
	EntityRevisionError,
	getArchiveStatus,
	getAllowedRelationType,
	generateCanonicalIdentity,
	deriveEntityStatuses,
	DEFAULT_EPIC_ID,
	DEFAULT_PROJECT_ID,
	getInitialStatus,
	isBodySource,
	isAllowedRelation,
	isEntityKind,
	isInitiativeComplete,
	isStructuralRelationType,
	isValidStatus,
	materializeFromPatches,
	RESERVED_SYSTEM_AUTHOR,
	STRUCTURAL_RELATION_TYPES,
	type BodySource,
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
	reference: string;
	kind: string;
	title: string;
	status: string;
	body: string;
	body_source?: string | null;
	revision?: number | null;
	content_hash?: string | null;
	tombstone?: number | null;
	project_id?: string | null;
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
		const identity = generateCanonicalIdentity(kind);
		const id = identity.stableId;
		// A project owns itself, so scoped reads from its own workspace see it.
		const projectId = kind === "project" ? id : inheritedProjectId;
		const contentHash = computeEntityContentHash(title, body);
		const values = tenantParams(db, {
			id,
			reference: identity.reference,
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

		// Write the baseline revision-1 entry: a no-op patch (predecessor ==
		// successor) so listEntityHistory always has a real revision_entries row
		// for every revision in the chain, including the initial one.
		appendDeltaEntry(executor, id, 1, title, body, bodySource, input.author, now);

		const entity = getEntityOrThrow(executor, id);
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

	if (entity.kind === "adr" && getConstrainedIssueStatuses(db, entity.id).length > 0) {
		throw new Error(
			`${entity.id} status is derived from the issues it constrains; update those issues instead of setting it directly.`
		);
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
	const newRevision = entity.revision + 1;
	const result = executor.drizzle
		.update(entities)
		.set({ status: input.status, revision: newRevision, updatedAt })
		.where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, entity.id), eq(entities.revision, entity.revision)))
		.run();

	if (result.changes === 0) {
		const current = getEntityOrThrow(db, entity.id);
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}

	appendDeltaEntry(db, entity.id, newRevision, entity.title, entity.body, entity.bodySource, input.author, updatedAt, {
		priorStatus: entity.status
	});

	return {
		entity: getEntityOrThrow(db, entity.id),
		previousStatus
	};
}

export function setEntityBody(
	executor: SqliteExecutor,
	input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }
): EntityRecord {
	const db = executor;
	return executor.transaction(() => {
		const current = getEntityOrThrow(executor, input.entityId);

		if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
			throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
		}

		const updatedAt = new Date().toISOString();
		const bodySource = input.bodySource ?? "authored";
		const newRevision = current.revision + 1;
		const newContentHash = computeEntityContentHash(current.title, input.body);

		const result = executor.drizzle
			.update(entities)
			.set({ body: input.body, bodySource, revision: newRevision, contentHash: newContentHash, updatedAt })
			.where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash)))
			.run();

		if (result.changes === 0) {
			const fresh = getEntityOrThrow(executor, current.id);
			throw new EntityConflictError(input.entityId, fresh.revision, fresh.contentHash);
		}

		appendDeltaEntry(db, current.id, newRevision, current.title, current.body, current.bodySource, input.author, updatedAt);
		return getEntityOrThrow(db, current.id);
	});
}

export function updateEntity(
	executor: SqliteExecutor,
	input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }
): EntityRecord {
	const db = executor;
	if (input.title === undefined && input.body === undefined) {
		throw new Error("Entity edit requires --title, --body, or both.");
	}

	return executor.transaction(() => {
		const current = getEntityOrThrow(executor, input.entityId);

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

		const result = executor.drizzle
			.update(entities)
			.set({ body, bodySource, title, revision: newRevision, contentHash: newContentHash, updatedAt })
			.where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash)))
			.run();

		if (result.changes === 0) {
			const fresh = getEntityOrThrow(executor, current.id);
			throw new EntityConflictError(input.entityId, fresh.revision, fresh.contentHash);
		}

		appendDeltaEntry(db, current.id, newRevision, current.title, current.body, current.bodySource, input.author, updatedAt);
		return getEntityOrThrow(executor, current.id);
	});
}

export function archiveEntity(db: SqliteExecutor, input: { entityId: string }): StatusUpdateResult {
	const entity = getEntityOrThrow(db, input.entityId);
	return updateEntityStatus(db, {
		entityId: input.entityId,
		status: getArchiveStatus(entity.kind)
	});
}

/**
 * Materializes entity facts at a specific historical revision by walking the
 * reverse-delta chain newest-first from the current head (ADR55/ISS261).
 * Does not mutate the head or any delta row.
 */
export function materializeEntityRevision(
	db: SqliteExecutor,
	input: { entityId: string; revision: number }
): MaterializedEntityRevision {
	type DeltaRow = {
		revision: number;
		author: string;
		patch_format: number;
		reverse_patch: Uint8Array;
		source_hash: Uint8Array;
		target_hash: Uint8Array;
		restored_from_revision: number | null;
		created_at: string;
	};

	const row = resolveSqliteEntity(db, input.entityId, true);

	if (!row) {
		throw new EntityRevisionError(
			input.entityId,
			"entity-not-found",
			`Entity not found: ${input.entityId}`
		);
	}

	const head = {
		id: row.id,
		title: row.title,
		body: row.body,
		bodySource: (isBodySource(row.bodySource ?? "") ? row.bodySource : "authored") as BodySource,
		status: row.status,
		parentId: getStructuralParentRelations(db, row.id)[0]?.fromId ?? null,
		revision: row.revision ?? 1,
		createdAt: row.createdAt,
		tombstone: row.tombstone
	};

	const deltaRows = all<DeltaRow>(
		db,
		sql`SELECT revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
			FROM revision_entries
			WHERE tenant_id = ${db.tenantId}
				AND record_kind = 'entity'
				AND record_key = ${encodeEntityRecordKey(row.id)}
			ORDER BY revision DESC`
	);

	const patches: EntityRevisionPatch[] = deltaRows.map((d) => ({
		revision: d.revision,
		author: d.author,
		createdAt: d.created_at,
		patchFormat: d.patch_format,
		reversePatch: d.reverse_patch,
		sourceHash: decodeRevisionPatchHash(d.source_hash),
		targetHash: decodeRevisionPatchHash(d.target_hash),
		...(d.restored_from_revision !== null && { restoredFromRevision: d.restored_from_revision })
	}));

	const result = materializeFromPatches(input.entityId, head, patches, input.revision);
	recordHistoryMaterialization(db, "entity", result.headRevision, result.targetRevision);
	return result;
}

export function restoreEntityRevision(
	db: SqliteExecutor,
	input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }
): MaterializedEntityRevision {
	const row = resolveSqliteEntity(db, input.entityId, true);
	if (!row) {
		throw new EntityRevisionError(input.entityId, "entity-not-found", `Entity not found: ${input.entityId}`);
	}
	const current = mapDrizzleEntityRow(row);
	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}
	const source = materializeEntityRevision(db, { entityId: current.id, revision: input.revision });
	const currentParentId = getStructuralParentRelations(db, current.id)[0]?.fromId ?? null;
	let restoredParent: EntityRecord | null = null;
	let restoredRelationType: RelationType | null = null;
	if (!source.tombstone && source.parentId) {
		restoredParent = getEntityOrThrow(db, source.parentId);
		restoredRelationType = getAllowedRelationType(restoredParent.kind, current.kind);
		if (!restoredRelationType || !isStructuralRelationType(restoredRelationType)) {
			throw new Error(`Cannot restore ${current.kind} under ${restoredParent.kind}.`);
		}
		if (hasStructuralPath(db, current.id, restoredParent.id)) {
			throw new Error(`Cannot restore ${current.id} under ${restoredParent.id} because that would create a cycle.`);
		}
	}

	return db.transaction(() => {
		const updatedAt = new Date().toISOString();
		const newRevision = current.revision + 1;
		const result = db.drizzle.update(entities).set({
			title: source.title,
			body: source.body,
			bodySource: source.bodySource,
			status: source.status,
			revision: newRevision,
			contentHash: computeEntityContentHash(source.title, source.body),
			tombstone: source.tombstone === true,
			updatedAt
		}).where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash))).run();
		if (result.changes === 0) {
			const freshRow = first<EntityRow>(db, sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND id = ${current.id}`)!;
			const fresh = mapEntityRow(freshRow);
			throw new EntityConflictError(current.id, fresh.revision, fresh.contentHash);
		}

		for (const relation of getStructuralParentRelations(db, current.id)) {
			run(db, sql`DELETE FROM relations WHERE tenant_id = ${db.tenantId} AND from_id = ${relation.fromId} AND to_id = ${relation.toId} AND type = ${relation.type}`);
		}
		if (restoredParent && restoredRelationType) {
			insertRelation(db, { fromId: restoredParent.id, toId: current.id, type: restoredRelationType, createdAt: updatedAt });
		}
		const projectId = restoredParent ? getEntityProjectId(db, restoredParent.id) ?? db.currentProjectId : db.currentProjectId;
		run(db, sql`WITH RECURSIVE subtree(id) AS (
			SELECT ${current.id}
			UNION
			SELECT relations.to_id
			FROM relations
			JOIN subtree ON relations.from_id = subtree.id
			WHERE relations.tenant_id = ${db.tenantId}
		)
		UPDATE entities
		SET project_id = ${projectId}
		WHERE tenant_id = ${db.tenantId} AND id IN (SELECT id FROM subtree)`);

		appendDeltaEntry(db, current.id, newRevision, current.title, current.body, current.bodySource, input.author, updatedAt, {
			priorStatus: current.status,
			priorParentId: currentParentId,
			priorTombstone: row.tombstone,
			restoredFromRevision: input.revision
		});
		return materializeEntityRevision(db, { entityId: current.id, revision: newRevision });
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
	const newRevision = entity.revision + 1;

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
			SET revision = ${newRevision}, updated_at = ${updatedAt}
			WHERE tenant_id = ${db.tenantId}
				AND id = ${entity.id}`);

		appendDeltaEntry(db, entity.id, newRevision, entity.title, entity.body, entity.bodySource, input.author, updatedAt, {
			priorParentId: previousParentId
		});
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
	const previousParentId = getStructuralParentRelations(db, entity.id)[0]?.fromId ?? null;

	return db.transaction(() => {
		const dependentHandoffRows = all<EntityRow>(db, sql`SELECT entities.* FROM entities
			JOIN relations ON relations.tenant_id = entities.tenant_id AND relations.from_id = entities.id
			WHERE entities.tenant_id = ${db.tenantId}
				AND entities.kind = 'handoff'
				AND entities.tombstone = 0
				AND relations.to_id = ${entity.id}
				AND relations.type = 'handsOff'`);
		for (const handoffRow of dependentHandoffRows) {
			const handoff = mapEntityRow(handoffRow);
			const handoffUpdatedAt = new Date().toISOString();
			const handoffRevision = handoff.revision + 1;
			run(db, sql`DELETE FROM relations WHERE tenant_id = ${db.tenantId} AND (from_id = ${handoff.id} OR to_id = ${handoff.id})`);
			executor.drizzle
				.update(entities)
				.set({ tombstone: true, revision: handoffRevision, updatedAt: handoffUpdatedAt })
				.where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, handoff.id), eq(entities.tombstone, false)))
				.run();
			appendDeltaEntry(db, handoff.id, handoffRevision, handoff.title, handoff.body, handoff.bodySource, undefined, handoffUpdatedAt, {
				priorTombstone: false
			});
		}
			const outgoingCount = first<{ count: number }>(
				db,
				sql`SELECT COUNT(*) as count FROM relations WHERE tenant_id = ${db.tenantId} AND from_id = ${entity.id}`
			)!;

			if (outgoingCount.count > 0) {
				throw new Error(`Cannot delete ${entity.id} while it still has outgoing relations. Unlink or delete dependents first.`);
			}

			const updatedAt = new Date().toISOString();
			const newRevision = entity.revision + 1;
			run(db, sql`DELETE FROM relations
				WHERE tenant_id = ${db.tenantId}
					AND (from_id = ${entity.id} OR to_id = ${entity.id})`);
			const result = executor.drizzle
				.update(entities)
				.set({ tombstone: true, revision: newRevision, updatedAt })
				.where(and(eq(entities.tenantId, db.tenantId), eq(entities.id, entity.id), eq(entities.tombstone, false)))
				.run();
			appendDeltaEntry(db, entity.id, newRevision, entity.title, entity.body, entity.bodySource, undefined, updatedAt, {
				priorParentId: previousParentId,
				priorTombstone: false
			});

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
			AND relations.to_id = ${entity.id}
		ORDER BY entities.id`);
	const outgoingRows = all<EntityRow & { type: string }>(db, sql`SELECT relations.type, entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${db.tenantId}
			AND relations.from_id = ${entity.id}
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

export function queryEntityRelations(
	executor: SqliteExecutor,
	input: { entityId: string; direction?: "incoming" | "outgoing" | "both"; types?: RelationType[] }
): EntityDetails {
	const details = getEntityDetails(executor, input.entityId);
	const types = input.types?.length ? new Set(input.types) : undefined;
	const includeIncoming = input.direction === undefined || input.direction === "both" || input.direction === "incoming";
	const includeOutgoing = input.direction === undefined || input.direction === "both" || input.direction === "outgoing";

	return {
		entity: details.entity,
		incoming: includeIncoming ? details.incoming.filter(({ relationType }) => !types || types.has(relationType)) : [],
		outgoing: includeOutgoing ? details.outgoing.filter(({ relationType }) => !types || types.has(relationType)) : []
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

export function queryEntities(
	db: SqliteExecutor,
	input: { kind: string; statuses?: string[]; parentId?: string; limit?: number }
): { entities: EntityRecord[]; total: number } {
	let selected = listEntities(db, input.kind);
	if (input.statuses?.length) {
		const statuses = new Set(input.statuses);
		selected = selected.filter((entity) => statuses.has(entity.status));
	}
	if (input.parentId) {
		const parent = resolveSqliteEntity(db, input.parentId);
		if (!parent) {
			return { entities: [], total: 0 };
		}
		const childIds = new Set(listAllRelations(db)
			.filter((relation) => relation.fromId === parent.id && isStructuralRelationType(relation.type))
			.map((relation) => relation.toId));
		selected = selected.filter((entity) => childIds.has(entity.id));
	}

	return {
		entities: input.limit === undefined ? selected : selected.slice(0, input.limit),
		total: selected.length
	};
}

// Materializes the full revision history for `entityId` from the
// reverse-delta chain in `revision_entries`, oldest first.  Does NOT
// require the entity to be live: tombstoned entities (deleted but still in
// the DB) return their complete chain.  Returns [] only when the entity
// does not exist at all.
export function listEntityHistory(db: SqliteExecutor, entityId: string): HistoryEntryRecord[] {
	const row = first<EntityRow>(db, sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND id = ${entityId}`);
	if (!row) {
		return [];
	}

	const headRevision = row.revision ?? 1;
	const currentParentId = getStructuralParentRelations(db, entityId)[0]?.fromId ?? null;

	type DeltaRow = {
		id: string;
		revision: number;
		author: string;
		patch_format: number;
		reverse_patch: Uint8Array;
		source_hash: Uint8Array;
		target_hash: Uint8Array;
		created_at: string;
	};

	const deltaRows = all<DeltaRow>(
		db,
		sql`SELECT id, revision, author, patch_format, reverse_patch, source_hash, target_hash, created_at
			FROM revision_entries
			WHERE tenant_id = ${db.tenantId}
				AND record_kind = 'entity'
				AND record_key = ${encodeEntityRecordKey(entityId)}
			ORDER BY revision DESC`
	);

	const patchByRevision = new Map(deltaRows.map((d) => [d.revision, d]));

	let state: { title: string; body: string; bodySource: BodySource; status: string; parentId: string | null; tombstone: boolean | null } = {
		title: row.title,
		body: row.body,
		bodySource: isBodySource(row.body_source ?? "") ? (row.body_source as BodySource) : "authored",
		status: row.status,
		parentId: currentParentId,
		tombstone: row.tombstone !== 0
	};

	const entries: HistoryEntryRecord[] = [];

	for (let revision = headRevision; revision >= 1; revision--) {
		const patch = patchByRevision.get(revision);
		if (!patch) {
			throw new EntityRevisionError(entityId, "broken-chain", `Missing revision_entries row for entity ${entityId} at revision ${revision}`, headRevision);
		}
		entries.push({
			id: patch.id,
			entityId,
			version: revision,
			author: patch.author,
			title: state.title,
			body: state.body,
			bodySource: state.bodySource,
			status: state.status,
			parentId: state.parentId,
			createdAt: patch.created_at
		});
		if (revision > 1) {
			state = applyReversePatch(state, {
				revision: patch.revision,
				author: patch.author,
				createdAt: patch.created_at,
				patchFormat: patch.patch_format,
				reversePatch: patch.reverse_patch,
				sourceHash: decodeRevisionPatchHash(patch.source_hash),
				targetHash: decodeRevisionPatchHash(patch.target_hash)
			});
		}
	}

	return entries.reverse();
}

// Relations are an idempotent key union after canonical heads import. This
// includes structural rows: the canonical parent is already present and is a
// no-op, while additional structural-type annotations must still transfer.
export function listAllRelations(db: SqliteExecutor): RelationRecord[] {
	const rows = all<RelationRow>(db, sql`SELECT * FROM relations WHERE tenant_id = ${db.tenantId}`);

	return rows.map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdAt: row.created_at
	}));
}

// The write half (ISS60/ADR16): idempotently inserts whatever relations this
// tenant doesn't already have, keyed by the table's own primary key
// (tenantId, fromId, toId, type). Must run after canonical entity import, so both endpoints of every relation already
// exist as entities on this side (`relations` has FK constraints on both
// from_id and to_id).
export function applyRelations(db: SqliteExecutor, relations: RelationRecord[]): { inserted: number } {
	let inserted = 0;
	for (const relation of relations) {
		const from = getEntityOrThrow(db, relation.fromId);
		const to = getEntityOrThrow(db, relation.toId);
		const result = insertRelation(db, { ...relation, fromId: from.id, toId: to.id });
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
	const defaultProject = getEntityOrThrow(db, deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId);
	const projects = entities.filter((entity) => entity.kind === "project" && entity.id !== defaultProject.id);
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
		reference: row.reference,
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

function getRelationOrThrow(
	db: SqliteExecutor,
	input: { fromId: string; toId: string; relationType: string }
): RelationRecord {
	const from = getEntityOrThrow(db, input.fromId);
	const to = getEntityOrThrow(db, input.toId);
	const row = first<RelationRow>(db, sql`SELECT * FROM relations
		WHERE tenant_id = ${db.tenantId}
			AND from_id = ${from.id}
			AND to_id = ${to.id}
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
		sql`SELECT * FROM relations WHERE tenant_id = ${db.tenantId} AND to_id = ${entityId} ORDER BY created_at, from_id, type`
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

function insertRelation(db: SqliteExecutor, relation: RelationRecord) {
	return run(db, sql`INSERT OR IGNORE INTO relations (tenant_id, from_id, to_id, type, created_at)
		VALUES (${db.tenantId}, ${relation.fromId}, ${relation.toId}, ${relation.type}, ${relation.createdAt})`);
}

// Appends an entity reverse-patch entry to `revision_entries` for one atomic
// title/body edit (ADR55/ISS257). The entry records the predecessor's
// title/body/bodySource so ISS261's history materializer can reconstruct
// prior states by walking the chain backwards from the current head.
function appendDeltaEntry(
	db: SqliteExecutor,
	entityId: string,
	newRevision: number,
	priorTitle: string,
	priorBody: string,
	priorBodySource: string,
	author: string | undefined,
	createdAt: string,
	lifecycle: { priorStatus?: string; priorParentId?: string | null; priorTombstone?: boolean | null; restoredFromRevision?: number } = {}
): void {
	const row = first<EntityRow>(db, sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND id = ${entityId}`);
	if (!row) {
		throw new Error(`Cannot append reverse patch for missing entity ${entityId}.`);
	}
	const successor = { title: row.title, body: row.body, bodySource: row.body_source ?? "authored", status: row.status, parentId: getStructuralParentRelations(db, entityId)[0]?.fromId ?? null, tombstone: row.tombstone !== 0 };
	const predecessor = {
		...successor,
		title: priorTitle,
		body: priorBody,
		bodySource: priorBodySource,
		...(lifecycle.priorStatus !== undefined && { status: lifecycle.priorStatus }),
		...(Object.hasOwn(lifecycle, "priorParentId") && { parentId: lifecycle.priorParentId ?? null }),
		...(lifecycle.priorTombstone != null && { tombstone: lifecycle.priorTombstone })
	};
	const transition = createReverseFieldPatch(successor, predecessor, ENTITY_REVERSE_PATCH_REGISTRY);
	if (!row.project_id) {
		throw new Error(`Cannot append reverse patch for entity ${entityId} without a project.`);
	}
	run(db, sql`INSERT INTO revision_entries
		(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
		VALUES (${randomUUID()}, ${db.tenantId}, ${row.project_id}, 'entity', ${encodeEntityRecordKey(row.id)}, ${newRevision}, ${author?.trim() || RESERVED_SYSTEM_AUTHOR}, ${transition.patchFormat}, ${Buffer.from(transition.reversePatch)}, ${encodeRevisionPatchHash(transition.sourceHash)}, ${encodeRevisionPatchHash(transition.targetHash)}, ${lifecycle.restoredFromRevision ?? null}, ${createdAt})`);
}

function getAllEntities(db: SqliteExecutor): EntityRecord[] {
	const rows = all<EntityRow>(
		db,
		sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND project_id = ${db.currentProjectId} AND tombstone = 0 ORDER BY id`
	);
	return rows.map(mapEntityRow);
}

function getTenantEntities(db: SqliteExecutor): EntityRecord[] {
	const rows = all<EntityRow>(db, sql`SELECT * FROM entities WHERE tenant_id = ${db.tenantId} AND tombstone = 0 ORDER BY id`);
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
	return row?.id ?? deriveMigratedEntityIdentity("epic", DEFAULT_EPIC_ID).stableId;
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
		reference: row.reference,
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

function tenantParams<T extends Record<string, unknown>>(db: SqliteExecutor, values: T): T & { tenantId: string } {
	return {
		tenantId: db.tenantId,
		...values
	};
}