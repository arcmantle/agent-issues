import { randomUUID } from "node:crypto";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
	applyReversePatch,
	collectReachableIds,
	computeEntityContentHash,
	createReverseFieldPatch,
	encodeEntityRecordKey,
	EntityConflictError,
	EntityRevisionError,
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	assignEntitiesToProjects,
	deriveEntityStatuses,
	ENTITY_REVERSE_PATCH_REGISTRY,
	ENTITY_KINDS,
	generateCanonicalIdentity,
	getAllowedRelationType,
	getArchiveStatus,
	deriveMigratedEntityIdentity,
	getInitialStatus,
	isAllowedRelation,
	isBodySource,
	isDirectEntitySelector,
	isEntityKind,
	isInitiativeComplete,
	isStructuralRelationType,
	isValidStatus,
	materializeFromPatches,
	RESERVED_SYSTEM_AUTHOR,
	sanitizePathSegment,
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
import { counters, entities, relations, revisionEntries } from "../../schema.js";

import { queryContextDetails, queryProjectContextDetails } from "../context/pg-context-store.js";

export type EntityRow = {
	id: string;
	reference: string;
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

/**
 * Seeds a fresh cloud tenant (per-kind id counters + the PROJ0/EPIC0
 * sentinels the full-chain invariant requires, ADR7) so `createEntity` has
 * somewhere to attach a parent-less initiative, exactly like the context
 * feature's `getOrCreateProjectByIdentity` and local's `SqliteStore`
 * bootstrap (`ensureTenantCounters` / `ensureFullChainInvariant` in core's
 * `database.ts`). No legacy-data import or backup step applies here: a
 * cloud tenant starts empty.
 */
export async function ensurePgTenant(client: PoolClient): Promise<void> {
	for (const kind of ENTITY_KINDS) {
		await client.insert(counters).values({ tenantId: client.tenantId, kind, nextValue: 1 }).onConflictDoNothing();
	}

	const now = new Date().toISOString();
	const projectIdentity = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID);
	const epicIdentity = deriveMigratedEntityIdentity("epic", DEFAULT_EPIC_ID);
	await client
		.insert(entities)
		.values({
			tenantId: client.tenantId,
			id: projectIdentity.stableId,
			reference: projectIdentity.reference,
			kind: "project",
			title: DEFAULT_PROJECT_TITLE,
			status: "active",
			body: "",
			bodySource: "generated",
			revision: 1,
			contentHash: computeEntityContentHash(DEFAULT_PROJECT_TITLE, ""),
			projectId: projectIdentity.stableId,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing();
	await client
		.insert(entities)
		.values({
			tenantId: client.tenantId,
			id: epicIdentity.stableId,
			reference: epicIdentity.reference,
			kind: "epic",
			title: DEFAULT_EPIC_TITLE,
			status: "active",
			body: "",
			bodySource: "generated",
			revision: 1,
			contentHash: computeEntityContentHash(DEFAULT_EPIC_TITLE, ""),
			projectId: projectIdentity.stableId,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing();
	await client
		.insert(relations)
		.values({ tenantId: client.tenantId, fromId: projectIdentity.stableId, toId: epicIdentity.stableId, type: "contains", createdAt: now })
		.onConflictDoNothing();
}

/**
 * Every live project in this tenant whose title normalizes to
 * `normalizedTitle`, mirroring local's `findProjectsByNormalizedTitle`. The
 * comparison is normalized rather than exact so `"My Project"` and
 * `"my-project"` name the same project on both drivers - the CLI derives an
 * identity from a repo/folder name, which differs in case and separators from
 * whatever title a human typed.
 */
async function findProjectsByNormalizedTitle(
	client: PoolClient,
	normalizedTitle: string
): Promise<Array<{ id: string; title: string }>> {
	const rows = await client
		.select({ id: entities.id, title: entities.title })
		.from(entities)
		.where(and(eq(entities.tenantId, client.tenantId), eq(entities.kind, "project"), eq(entities.tombstone, false)))
		.orderBy(asc(entities.id));
	return rows.filter((project) => sanitizePathSegment(project.title) === normalizedTitle);
}

/**
 * The `project` entity this tenant already minted for a client-resolved
 * `projectIdentity`, or a freshly minted one plus its own epic the first time
 * a request for that identity arrives - `ensurePgTenant`'s
 * project+epic+contains seeding, just per-identity rather than once per
 * tenant. The epic is what keeps ADR7's full-chain invariant true: without it
 * a parent-less initiative created for this identity would attach to the
 * sentinel `EPIC0` and land in Default Project instead.
 *
 * Resolution order mirrors local's `resolveCurrentProjectId` exactly: a
 * direct selector (stable id or Canonical reference) first, then a normalized
 * title match, then registration. Two projects normalizing to the same title
 * is ambiguous and refuses to guess.
 *
 * Shared by the context path and by `resolveProjectIdForWrite`, so a
 * workspace's entities and its glossary always agree on which project they
 * belong to.
 *
 * The advisory lock is transaction-scoped (ADR9 gives every store method
 * exactly one transaction) and keyed by tenant + identity, so two concurrent
 * first-touch requests for the same new workspace take turns instead of both
 * inserting: a duplicate title would make the identity permanently ambiguous,
 * which is worse than either request simply waiting.
 */
export async function getOrCreateProjectByIdentity(
	client: PoolClient,
	projectIdentity: string
): Promise<EntityRecord> {
	// Taken before `ensurePgTenant`, so the whole seed-then-check-then-create
	// sequence is inside the lock rather than only its tail.
	await client.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${client.tenantId}), hashtext(${projectIdentity}))`);
	await ensurePgTenant(client);

	const [direct] = await client
		.select({ id: entities.id })
		.from(entities)
		.where(
			and(
				eq(entities.tenantId, client.tenantId),
				eq(entities.kind, "project"),
				eq(entities.tombstone, false),
				// `id::text` rather than `eq(entities.id, ...)`: the column is a
				// uuid, and a repository-style identity like "my-repo" makes
				// Postgres fail the comparison outright (22P02) instead of simply
				// not matching the way SQLite's untyped column does.
				sql`(${entities.id}::text = ${projectIdentity} OR ${entities.reference} = ${projectIdentity})`
			)
		)
		.limit(1);
	if (direct) {
		return getEntityOrThrow(client, direct.id);
	}

	const matching = await findProjectsByNormalizedTitle(client, sanitizePathSegment(projectIdentity));
	if (matching.length > 1) {
		throw new Error(`Ambiguous project identity "${projectIdentity}" in tenant ${client.tenantId}.`);
	}
	if (matching.length === 1) {
		return getEntityOrThrow(client, matching[0]!.id);
	}
	if (isDirectEntitySelector(projectIdentity)) {
		throw new Error(`Cannot resolve project identity "${projectIdentity}" in tenant ${client.tenantId}.`);
	}

	const now = new Date().toISOString();
	const project = generateCanonicalIdentity("project");
	const epic = generateCanonicalIdentity("epic");

	await client.insert(entities).values({
		tenantId: client.tenantId,
		id: project.stableId,
		reference: project.reference,
		kind: "project",
		title: projectIdentity,
		status: "active",
		body: "",
		bodySource: "generated",
		revision: 1,
		contentHash: computeEntityContentHash(projectIdentity, ""),
		// A project owns itself, so project-scoped reads and its own revision
		// ledger (which rejects a null `project_id`) both resolve.
		projectId: project.stableId,
		createdAt: now,
		updatedAt: now
	});
	await client.insert(entities).values({
		tenantId: client.tenantId,
		id: epic.stableId,
		reference: epic.reference,
		kind: "epic",
		title: DEFAULT_EPIC_TITLE,
		status: "active",
		body: "",
		bodySource: "generated",
		revision: 1,
		contentHash: computeEntityContentHash(DEFAULT_EPIC_TITLE, ""),
		projectId: project.stableId,
		createdAt: now,
		updatedAt: now
	});
	await client
		.insert(relations)
		.values({ tenantId: client.tenantId, fromId: project.stableId, toId: epic.stableId, type: "contains", createdAt: now })
		.onConflictDoNothing();

	return getEntityOrThrow(client, project.stableId);
}

export function mapEntityRow(row: EntityRow): EntityRecord {
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

function mapDrizzleEntityRow(row: typeof entities.$inferSelect): EntityRecord {
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

export async function getEntityOrThrow(client: PoolClient, entityId: string): Promise<EntityRecord> {
	const row = await resolveEntity(client, entityId);
	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return mapDrizzleEntityRow(row);
}

async function resolveEntity(client: PoolClient, entityId: string, includeTombstone: boolean = false): Promise<typeof entities.$inferSelect | undefined> {
	const livePredicate = includeTombstone ? undefined : eq(entities.tombstone, false);
	let row: typeof entities.$inferSelect | undefined;
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entityId)) {
		[row] = await client
			.select()
			.from(entities)
			.where(and(eq(entities.tenantId, client.tenantId), eq(entities.id, entityId), livePredicate));
	} else {
		[row] = await client
			.select()
			.from(entities)
			.where(and(eq(entities.tenantId, client.tenantId), eq(entities.reference, entityId), livePredicate));
	}

	return row;
}

async function getStructuralParentRelations(client: PoolClient, entityId: string): Promise<RelationRecord[]> {
	const rows = await client
		.select()
		.from(relations)
		.where(and(eq(relations.tenantId, client.tenantId), eq(relations.toId, entityId)))
		.orderBy(asc(relations.createdAt), asc(relations.fromId), asc(relations.type));

	return rows
		.filter((row) => isStructuralRelationType(row.type))
		.map((row) => ({ fromId: row.fromId, toId: row.toId, type: row.type as RelationType, createdAt: row.createdAt }));
}

// Walks structural-only parent relations up to the root, mirroring core's
// store.ts getStructuralPath, so handoffs can resolve their owning
// initiative the same way locally and in the cloud.
async function getStructuralPath(
	client: PoolClient,
	entityId: string
): Promise<Array<{ relationType: RelationType; entity: EntityRecord }>> {
	const path: Array<{ relationType: RelationType; entity: EntityRecord }> = [];
	const seen = new Set<string>([entityId]);
	let currentId = entityId;

	while (true) {
		const parents = await getStructuralParentRelations(client, currentId);

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
		path.push({ relationType: parent.type, entity: await getEntityOrThrow(client, parent.fromId) });
		currentId = parent.fromId;
	}
}

async function resolveOwningInitiativeId(client: PoolClient, focus: EntityRecord): Promise<string | null> {
	if (focus.kind === "initiative") {
		return focus.id;
	}

	const structuralPath = await getStructuralPath(client, focus.id);
	return structuralPath.find((entry) => entry.entity.kind === "initiative")?.entity.id ?? null;
}

export async function nextEntityId(_client: PoolClient, kind: EntityKind): Promise<string> {
	return generateCanonicalIdentity(kind).reference;
}

// Appends a reverse-patch entry (ADR55/ISS257) mirroring appendDeltaEntry in
// core's store.ts. Records the predecessor title/body so ISS261's history
// materializer can walk back from the current head one step at a time.
async function appendDeltaEntry(
	client: PoolClient,
	entityId: string,
	newRevision: number,
	priorTitle: string,
	priorBody: string,
	priorBodySource: string,
	author: string | undefined,
	createdAt: string,
	lifecycle: { priorStatus?: string; priorParentId?: string | null; priorTombstone?: boolean | null; restoredFromRevision?: number } = {}
): Promise<void> {
	const [row] = await client.select().from(entities).where(and(eq(entities.tenantId, client.tenantId), eq(entities.id, entityId)));
	if (!row) {
		throw new Error(`Cannot append reverse patch for missing entity ${entityId}.`);
	}
	const successor = { title: row.title, body: row.body, bodySource: row.bodySource, status: row.status, parentId: (await getStructuralParentRelations(client, entityId))[0]?.fromId ?? null, tombstone: row.tombstone };
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
	if (!row.projectId) throw new Error(`Cannot append reverse patch for entity ${entityId} without a project.`);
	await client.insert(revisionEntries).values({ id: randomUUID(), tenantId: client.tenantId, projectId: row.projectId, recordKind: "entity", recordKey: encodeEntityRecordKey(row.id), revision: newRevision, author: author?.trim() || RESERVED_SYSTEM_AUTHOR, patchFormat: transition.patchFormat, reversePatch: Buffer.from(transition.reversePatch), sourceHash: encodeRevisionPatchHash(transition.sourceHash), targetHash: encodeRevisionPatchHash(transition.targetHash), restoredFromRevision: lifecycle.restoredFromRevision ?? null, createdAt });
}

/**
 * The project every project-scoped read below filters by, resolved once per
 * transaction and memoized on the executor - the cloud counterpart of local's
 * `db.currentProjectId`, which `ensureDatabase` fills in at open.
 *
 * Resolution itself mirrors local's `resolveCurrentProjectId`: a carried
 * identity registers itself on first use, and a tenant with no identity and
 * more than one project refuses to guess which one the caller meant rather
 * than silently blending them.
 */
function currentProjectId(client: PoolClient): Promise<string> {
	client.currentProjectId ??= resolveCurrentProjectId(client, client.projectIdentity);
	return client.currentProjectId;
}

/**
 * Forces the resolution `currentProjectId` would otherwise defer, so a store
 * settles on its project the way local's `ensureDatabase` does at open -
 * before the caller has had a chance to create a second project and make the
 * choice ambiguous.
 */
export async function primeCurrentProjectId(client: PoolClient): Promise<string> {
	return currentProjectId(client);
}

async function resolveCurrentProjectId(client: PoolClient, projectIdentity: string | undefined): Promise<string> {
	const selector = projectIdentity?.trim();
	if (selector) {
		return (await getOrCreateProjectByIdentity(client, selector)).id;
	}

	// No identity resolves to the `PROJ0` sentinel rather than local's literal
	// "refuse when the tenant has more than one project". That refusal is
	// reachable in local only by opening a database that ALREADY holds several
	// projects without saying which you mean; every ordinary local session
	// resolves at open, when the sentinel is the only project, and then keeps
	// it for the session. Cloud has no equivalent open-once moment - the gate
	// builds a fresh store per request - so copying the refusal literally would
	// make an unidentified caller start failing the moment a second project
	// appeared, which is not what the same caller experiences locally.
	await ensurePgTenant(client);
	return deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
}

/**
 * Runs `fn` with the current project pinned to `projectId`, restoring whatever
 * was resolved before. Mirrors local's `getDatabaseSnapshot` swapping
 * `db.currentProjectId`: it lets an explicitly-selected project reuse the same
 * project-scoped read path instead of needing a parallel set of queries.
 *
 * Save-and-restore around a mutable field only holds for one pin at a time, so
 * this must not be nested or run concurrently with itself on the same client -
 * two overlapping pins would restore each other's value. There is exactly one
 * call site (`getDatabaseSnapshot` with an explicit project), and nothing it
 * calls pins again.
 */
async function withCurrentProject<T>(client: PoolClient, projectId: string, fn: () => Promise<T>): Promise<T> {
	const previous = client.currentProjectId;
	client.currentProjectId = Promise.resolve(projectId);
	try {
		return await fn();
	} finally {
		client.currentProjectId = previous;
	}
}

async function getAllEntities(client: PoolClient): Promise<EntityRecord[]> {
	const projectId = await currentProjectId(client);
	const rows = await client
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, client.tenantId), eq(entities.projectId, projectId), eq(entities.tombstone, false)));
	return rows.map(mapDrizzleEntityRow);
}

async function getAllRelations(client: PoolClient): Promise<RelationRecord[]> {
	const projectId = await currentProjectId(client);
	const result = await client.execute(sql`
		SELECT relations.* FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${client.tenantId} AND entities.project_id = ${projectId}
		ORDER BY relations.from_id, relations.to_id, relations.type
	`);
	return (result.rows as RelationRow[]).map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdAt: row.created_at
	}));
}

/** Tenant-wide reads, for the callers that legitimately span every project: project discovery and whole-tenant synchronize. Mirrors local's `getTenantEntities`/`getTenantRelations`. */
async function getTenantEntities(client: PoolClient): Promise<EntityRecord[]> {
	const rows = await client.select().from(entities).where(and(eq(entities.tenantId, client.tenantId), eq(entities.tombstone, false)));
	return rows.map(mapDrizzleEntityRow);
}

async function getTenantRelations(client: PoolClient): Promise<RelationRecord[]> {
	const rows = await client.select().from(relations).where(eq(relations.tenantId, client.tenantId));
	return rows.map((row) => ({ fromId: row.fromId, toId: row.toId, type: row.type as RelationType, createdAt: row.createdAt }));
}

async function getDerivedStatusMap(client: PoolClient, rootIds?: string[]): Promise<Map<string, string>> {
	if (rootIds?.length === 0) {
		return new Map();
	}
	const result = rootIds
		? await client.execute(sql`
			WITH RECURSIVE status_entities AS (
				SELECT id, kind, status
				FROM entities
				WHERE tenant_id = ${client.tenantId} AND tombstone = false AND id IN ${rootIds}
				UNION
				SELECT dependency.id, dependency.kind, dependency.status
				FROM status_entities AS current
				JOIN relations AS dependency_relation ON dependency_relation.tenant_id = ${client.tenantId}
				JOIN entities AS dependency ON dependency.tenant_id = dependency_relation.tenant_id
					AND dependency.tombstone = false
					AND (
						(current.kind = 'issue' AND dependency_relation.type = 'decomposes' AND dependency_relation.from_id = current.id AND dependency.id = dependency_relation.to_id)
						OR (current.kind = 'userStory' AND dependency_relation.type = 'fixes' AND dependency_relation.to_id = current.id AND dependency.id = dependency_relation.from_id)
						OR (current.kind = 'prd' AND dependency_relation.type = 'creates' AND dependency_relation.from_id = current.id AND dependency.id = dependency_relation.to_id)
						OR (current.kind = 'initiative' AND dependency_relation.type IN ('tracks', 'owns') AND dependency_relation.from_id = current.id AND dependency.id = dependency_relation.to_id)
						OR (current.kind = 'adr' AND dependency_relation.type = 'constrains' AND dependency_relation.from_id = current.id AND dependency.id = dependency_relation.to_id)
						OR (dependency_relation.type = 'supersedes' AND dependency_relation.to_id = current.id AND dependency.id = dependency_relation.from_id AND dependency.kind = current.kind)
					)
			)
			SELECT id, kind, status FROM status_entities
		`)
		: await client.execute(sql`
			SELECT id, kind, status FROM entities
			WHERE tenant_id = ${client.tenantId} AND tombstone = false
		`);
	const statusEntities = (result.rows as Array<{ id: string; kind: string; status: string }>).map((row) => ({
		id: row.id,
		reference: "",
		kind: row.kind as EntityKind,
		title: "",
		status: row.status,
		body: "",
		bodySource: "authored" as const,
		revision: 1,
		contentHash: "",
		createdAt: "",
		updatedAt: ""
	}));
	const statusEntityIds = statusEntities.map((entity) => entity.id);
	const relationRows = rootIds
		? await client
			.select()
			.from(relations)
			.where(and(
				eq(relations.tenantId, client.tenantId),
				inArray(relations.fromId, statusEntityIds),
				inArray(relations.toId, statusEntityIds)
			))
		: undefined;
	const statusRelations = relationRows
		? relationRows.map((row) => ({ fromId: row.fromId, toId: row.toId, type: row.type as RelationType, createdAt: row.createdAt }))
		: await getAllRelations(client);
	const entities = deriveEntityStatuses(statusEntities, statusRelations);
	return new Map(entities.map((entity) => [entity.id, entity.status]));
}

function applyDerivedStatus(entity: EntityRecord, statusMap: ReadonlyMap<string, string>): EntityRecord {
	const derived = statusMap.get(entity.id);
	return derived === undefined || derived === entity.status ? entity : { ...entity, status: derived };
}

async function getRelationOrThrow(
	client: PoolClient,
	input: { fromId: string; toId: string; relationType: string }
): Promise<RelationRecord> {
	const [row] = await client
		.select()
		.from(relations)
		.where(
			and(
				eq(relations.tenantId, client.tenantId),
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

async function insertRelation(client: PoolClient, relation: RelationRecord): Promise<{ inserted: boolean }> {
	const inserted = await client
		.insert(relations)
		.values({ tenantId: client.tenantId, fromId: relation.fromId, toId: relation.toId, type: relation.type, createdAt: relation.createdAt })
		.onConflictDoNothing()
		.returning({ fromId: relations.fromId });

	return { inserted: inserted.length > 0 };
}

// Reconciles `entityId`'s structural parent relation to `newParentId` (see
// core's `reconcileStructuralParent` for the full rationale).
async function reconcileStructuralParent(
	client: PoolClient,
	entityId: string,
	kind: EntityKind,
	newParentId: string | null
): Promise<void> {
	const currentParents = await getStructuralParentRelations(client, entityId);
	const currentParentId = currentParents[0]?.fromId ?? null;

	if (currentParentId === newParentId) {
		return;
	}

	for (const relation of currentParents) {
		await client
			.delete(relations)
			.where(
				and(
					eq(relations.tenantId, client.tenantId),
					eq(relations.fromId, relation.fromId),
					eq(relations.toId, entityId),
					eq(relations.type, relation.type)
				)
			);
	}

	if (!newParentId) {
		return;
	}

	const parent = await getEntityOrThrow(client, newParentId);
	const relationType = getAllowedRelationType(parent.kind, kind);
	if (!relationType) {
		throw new Error(`Cannot resolve ${entityId} under ${parent.kind} via synchronize: no allowed relation from ${parent.kind} to ${kind}.`);
	}

	await insertRelation(client, { fromId: parent.id, toId: entityId, type: relationType, createdAt: new Date().toISOString() });
}

async function hasTypedPath(client: PoolClient, startId: string, targetId: string, relationType: string): Promise<boolean> {
	const relations = (await getAllRelations(client)).filter((relation) => relation.type === relationType);
	return collectReachableIds(relations, startId).has(targetId);
}

async function hasStructuralPath(client: PoolClient, startId: string, targetId: string): Promise<boolean> {
	const relations = (await getAllRelations(client)).filter((relation) => isStructuralRelationType(relation.type));
	return collectReachableIds(relations, startId).has(targetId);
}

async function wouldOrphanSubtree(client: PoolClient, relation: RelationRecord): Promise<boolean> {
	const [relations, entities] = await Promise.all([getAllRelations(client), getAllEntities(client)]);
	return wouldOrphanSubtreeInGraph(entities, relations, relation);
}

// Mirrors `wouldBreakFullChainInvariant` in core's `store.ts`: blocks
// unlinking a "contains" relation that is the sole remaining structural
// parent of an epic or initiative (ADR7's full-chain invariant).
async function wouldBreakFullChainInvariant(client: PoolClient, relation: RelationRecord): Promise<boolean> {
	if (relation.type !== "contains") {
		return false;
	}

	const target = await getEntityOrThrow(client, relation.toId);
	if (target.kind !== "epic" && target.kind !== "initiative") {
		return false;
	}

	const [result] = await client
		.select({ count: sql<number>`count(*)` })
		.from(relations)
		.where(
			and(
				eq(relations.tenantId, client.tenantId),
				eq(relations.toId, relation.toId),
				eq(relations.type, "contains"),
				sql`${relations.fromId} <> ${relation.fromId}`
			)
		);

	return Number(result?.count ?? 0) === 0;
}

async function getActiveBlockingIssues(client: PoolClient, entityId: string): Promise<EntityRecord[]> {
	const result = await client.execute(sql`
		SELECT entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${client.tenantId}
			AND relations.type = 'blocks'
			AND relations.to_id = ${entityId}
			AND entities.status != 'done'
		ORDER BY entities.id
	`);

	return (result.rows as EntityRow[]).map(mapEntityRow);
}

async function getOpenSubIssues(client: PoolClient, issueId: string): Promise<EntityRecord[]> {
	const statusMap = await getDerivedStatusMap(client);
	const result = await client.execute(sql`
		SELECT entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${client.tenantId}
			AND relations.from_id = ${issueId}
			AND relations.type = 'decomposes'
		ORDER BY entities.id
	`);

	return (result.rows as EntityRow[])
		.map(mapEntityRow)
		.map((entity) => applyDerivedStatus(entity, statusMap))
		.filter((entity) => entity.status !== "done");
}

async function getFixingIssueStatuses(client: PoolClient, storyId: string): Promise<string[]> {
	const result = await client.execute(sql`
		SELECT entities.status
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${client.tenantId}
			AND relations.type = 'fixes'
			AND relations.to_id = ${storyId}
			AND entities.kind = 'issue'
	`);

	return (result.rows as Array<{ status: string }>).map((row) => row.status);
}

async function getCreatedStoryStatuses(client: PoolClient, prdId: string): Promise<string[]> {
	const statusMap = await getDerivedStatusMap(client);
	const result = await client.execute(sql`
		SELECT entities.id
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${client.tenantId}
			AND relations.type = 'creates'
			AND relations.from_id = ${prdId}
			AND entities.kind = 'userStory'
	`);

	return (result.rows as Array<{ id: string }>).map((row) => statusMap.get(row.id) ?? "");
}

async function getConstrainedIssueStatuses(client: PoolClient, adrId: string): Promise<string[]> {
	const result = await client.execute(sql`
		SELECT entities.status
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${client.tenantId}
			AND relations.type = 'constrains'
			AND relations.from_id = ${adrId}
			AND entities.kind = 'issue'
	`);

	return (result.rows as Array<{ status: string }>).map((row) => row.status);
}

async function isEntitySuperseded(
	client: PoolClient,
	entityId: string,
	kind: "prd" | "userStory" | "adr"
): Promise<boolean> {
	const result = await client.execute(sql`
		SELECT 1
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${client.tenantId}
			AND relations.type = 'supersedes'
			AND relations.to_id = ${entityId}
			AND entities.kind = ${kind}
		LIMIT 1
	`);

	return (result.rowCount ?? 0) > 0;
}

async function getInitiativeChildStatuses(
	client: PoolClient,
	initiativeId: string
): Promise<{ trackedIssueStatuses: string[]; ownedPrdStatuses: string[] }> {
	const statusMap = await getDerivedStatusMap(client);
	const structuralRelations = (await getAllRelations(client)).filter((relation) => isStructuralRelationType(relation.type));
	const reachableIds = collectReachableIds(structuralRelations, initiativeId);
	reachableIds.delete(initiativeId);
	const entities = await getAllEntities(client);

	return {
		trackedIssueStatuses: entities
			.filter((entity) => entity.kind === "issue" && reachableIds.has(entity.id))
			.map((entity) => statusMap.get(entity.id) ?? ""),
		ownedPrdStatuses: entities
			.filter((entity) => entity.kind === "prd" && reachableIds.has(entity.id))
			.map((entity) => statusMap.get(entity.id) ?? "")
	};
}

async function getAllDerivedEntities(client: PoolClient): Promise<EntityRecord[]> {
	return deriveEntityStatuses(await getAllEntities(client), await getAllRelations(client));
}

export async function createEntity(
	client: PoolClient,
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
	await ensurePgTenant(client);

	const now = new Date().toISOString();
	const parentId = input.parentId ?? (kind === "initiative" ? await resolveDefaultEpicId(client, projectIdentity) : undefined);
	const parent = parentId ? await getEntityOrThrow(client, parentId) : null;
	const relationType = parent ? getAllowedRelationType(parent.kind, kind) : null;

	if (parent && !relationType) {
		throw new Error(`Cannot create ${kind} under ${parent.kind}.`);
	}

	const identity = generateCanonicalIdentity(kind);
	const id = identity.stableId;
	// Resolved lazily per branch rather than up front: a project owns itself,
	// and asking `resolveProjectIdForWrite` for its owning project would mint a
	// second project under the same identity before this one is even inserted.
	// A parent predating the project backfill can still carry a null
	// `project_id`, so that case falls through to the request's own project
	// (matching local) rather than inserting a null the revision ledger rejects.
	const projectId =
		kind === "project"
			? id
			: ((parent ? await getEntityProjectId(client, parent.id) : null) ??
				(await resolveProjectIdForWrite(client, projectIdentity)));
	const contentHash = computeEntityContentHash(title, body);
	await client.insert(entities).values({
		tenantId: client.tenantId,
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

	if (parent && relationType) {
		await client
			.insert(relations)
			.values({ tenantId: client.tenantId, fromId: parent.id, toId: id, type: relationType, createdAt: now })
			.onConflictDoNothing();
	}

	for (const link of input.links ?? []) {
		await linkEntities(client, { fromId: identity.stableId, relationType: link.relationType, toId: link.targetId });
	}

	// Write the baseline revision-1 entry: a no-op patch (predecessor ==
	// successor) so listEntityHistory always has a real revision_entries row
	// for every revision in the chain, including the initial one.
	await appendDeltaEntry(client, id, 1, title, body, bodySource, input.author, now);

	return getEntityOrThrow(client, id);
}

export async function getEntityDetails(client: PoolClient, entityId: string): Promise<EntityDetails> {
	const entity = await getEntityOrThrow(client, entityId);

	const incomingResult = await client.execute(sql`
		SELECT relations.type, entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${client.tenantId} AND relations.to_id = ${entity.id}
		ORDER BY entities.id
	`);
	const outgoingResult = await client.execute(sql`
		SELECT relations.type, entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${client.tenantId} AND relations.from_id = ${entity.id}
		ORDER BY entities.id
	`);

	const statusMap = await getDerivedStatusMap(client);

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

export async function queryEntityRelations(
	client: PoolClient,
	input: { entityId: string; direction?: "incoming" | "outgoing" | "both"; types?: RelationType[] }
): Promise<EntityDetails> {
	const entity = await getEntityOrThrow(client, input.entityId);
	const typeFilter = input.types?.length ? sql`AND relations.type IN ${input.types}` : sql``;
	const includeIncoming = input.direction === undefined || input.direction === "both" || input.direction === "incoming";
	const includeOutgoing = input.direction === undefined || input.direction === "both" || input.direction === "outgoing";
	const incomingResult = includeIncoming
		? await client.execute(sql`
			SELECT relations.type, entities.*
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			WHERE relations.tenant_id = ${client.tenantId} AND relations.to_id = ${entity.id}
				AND entities.tombstone = false ${typeFilter}
			ORDER BY entities.id
		`)
		: { rows: [] };
	const outgoingResult = includeOutgoing
		? await client.execute(sql`
			SELECT relations.type, entities.*
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			WHERE relations.tenant_id = ${client.tenantId} AND relations.from_id = ${entity.id}
				AND entities.tombstone = false ${typeFilter}
			ORDER BY entities.id
		`)
		: { rows: [] };
	const relatedIds = [
		entity.id,
		...(incomingResult.rows as EntityRow[]).map((row) => row.id),
		...(outgoingResult.rows as EntityRow[]).map((row) => row.id)
	];
	const statusMap = await getDerivedStatusMap(client, relatedIds);

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

export async function listEntities(client: PoolClient, kind: string): Promise<EntityRecord[]> {
	if (!isEntityKind(kind)) {
		throw new Error(`Unknown entity kind: ${kind}`);
	}

	const entities = deriveEntityStatuses(await getAllEntities(client), await getAllRelations(client));
	return entities.filter((entity) => entity.kind === kind);
}

export async function queryEntities(
	client: PoolClient,
	input: { kind: string; statuses?: string[]; parentId?: string; limit?: number }
): Promise<{ entities: EntityRecord[]; total: number }> {
	if (!isEntityKind(input.kind)) {
		throw new Error(`Unknown entity kind: ${input.kind}`);
	}

	let parentId: string | undefined;
	if (input.parentId) {
		const parent = await resolveEntity(client, input.parentId);
		if (!parent) {
			return { entities: [], total: 0 };
		}
		parentId = parent.id;
	}
	const candidateResult = parentId
		? await client.execute(sql`
			SELECT entity.id
			FROM entities AS entity
			JOIN relations AS parent_relation
				ON parent_relation.tenant_id = entity.tenant_id AND parent_relation.to_id = entity.id
			WHERE entity.tenant_id = ${client.tenantId}
				AND entity.tombstone = false
				AND entity.kind = ${input.kind}
				AND parent_relation.from_id = ${parentId}
				AND parent_relation.type IN ${STRUCTURAL_RELATION_TYPES}
			ORDER BY entity.id
		`)
		: await client.execute(sql`
			SELECT id FROM entities
			WHERE tenant_id = ${client.tenantId} AND tombstone = false AND kind = ${input.kind}
			ORDER BY id
		`);
	let selectedIds = (candidateResult.rows as Array<{ id: string }>).map((row) => row.id);
	let statusMap: Map<string, string>;
	if (input.statuses?.length) {
		statusMap = await getDerivedStatusMap(client, selectedIds);
		const statuses = new Set(input.statuses);
		selectedIds = selectedIds.filter((entityId) => statuses.has(statusMap.get(entityId) ?? ""));
	} else {
		const limitedIds = input.limit === undefined ? selectedIds : selectedIds.slice(0, input.limit);
		statusMap = await getDerivedStatusMap(client, limitedIds);
	}
	const total = selectedIds.length;
	const limitedIds = input.limit === undefined ? selectedIds : selectedIds.slice(0, input.limit);
	if (limitedIds.length === 0) {
		return { entities: [], total };
	}
	const selectedRows = await client.select().from(entities).where(and(
		eq(entities.tenantId, client.tenantId),
		inArray(entities.id, limitedIds)
	));
	const selectedById = new Map(selectedRows.map((row) => [row.id, applyDerivedStatus(mapDrizzleEntityRow(row), statusMap)]));

	return {
		entities: limitedIds.map((entityId) => selectedById.get(entityId)!),
		total
	};
}

export async function listEntityHistory(client: PoolClient, entityId: string): Promise<HistoryEntryRecord[]> {
	const row = await resolveEntity(client, entityId, true);
	if (!row) {
		return [];
	}

	const headRevision = row.revision ?? 1;
	const currentParentIds = (await getStructuralParentRelations(client, entityId)).map((relation) => relation.fromId);

	const deltaRows = await client
		.select()
		.from(revisionEntries)
		.where(
			and(
				eq(revisionEntries.tenantId, client.tenantId),
				eq(revisionEntries.recordKind, "entity"),
				eq(revisionEntries.recordKey, encodeEntityRecordKey(entityId))
			)
		)
		.orderBy(desc(revisionEntries.revision));

	const patchByRevision = new Map(deltaRows.map((d) => [d.revision, d]));
	const newestPatch = patchByRevision.get(headRevision);
	const headState = {
		title: row.title,
		body: row.body,
		bodySource: isBodySource(row.bodySource) ? (row.bodySource as BodySource) : "authored",
		status: row.status,
		tombstone: row.tombstone
	};
	const currentParentId = resolveRevisionHeadParentId(entityId, headState, currentParentIds, newestPatch?.sourceHash);

	let state: { title: string; body: string; bodySource: BodySource; status: string; parentId: string | null; tombstone: boolean | null } = {
		...headState,
		parentId: currentParentId,
	};

	const entries: HistoryEntryRecord[] = [];

	for (let revision = headRevision; revision >= 1; revision--) {
		const patch = patchByRevision.get(revision);
		if (!patch) {
			throw new EntityRevisionError(entityId, "broken-chain", `Missing revision_entries row for entity ${entityId} at revision ${revision}`, headRevision);
		}
		entries.push({
			id: patch.id,
			entityId: row.id,
			version: revision,
			author: patch.author,
			title: state.title,
			body: state.body,
			bodySource: state.bodySource,
			status: state.status,
			parentId: state.parentId,
			createdAt: patch.createdAt
		});
		if (revision > 1) {
			state = applyReversePatch(state, {
				revision: patch.revision,
				author: patch.author,
				createdAt: patch.createdAt,
				patchFormat: patch.patchFormat,
				reversePatch: patch.reversePatch,
				sourceHash: decodeRevisionPatchHash(patch.sourceHash),
				targetHash: decodeRevisionPatchHash(patch.targetHash)
			});
		}
	}

	return entries.reverse();
}

function resolveRevisionHeadParentId(
	entityId: string,
	state: { title: string; body: string; bodySource: BodySource; status: string; tombstone: boolean | null },
	parentIds: string[],
	sourceHash: Uint8Array | undefined
): string | null {
	if (!sourceHash) {
		return parentIds[0] ?? null;
	}
	const expectedHash = decodeRevisionPatchHash(sourceHash);
	const matches = [...new Set<string | null>([null, ...parentIds])].filter((parentId) =>
		createReverseFieldPatch({ ...state, parentId }, { ...state, parentId }, ENTITY_REVERSE_PATCH_REGISTRY).sourceHash === expectedHash
	);
	if (matches.length !== 1) {
		throw new EntityRevisionError(entityId, "broken-chain", `Cannot uniquely resolve revision head parent for entity ${entityId}`);
	}
	return matches[0]!;
}

// Relations are an idempotent key union after canonical heads import. This
// includes structural rows: the canonical parent is already present and is a
// no-op, while additional structural-type annotations must still transfer.
export async function listAllRelations(client: PoolClient): Promise<RelationRecord[]> {
	const result = await client.execute(sql`SELECT * FROM relations WHERE tenant_id = ${client.tenantId}`);
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
export async function applyRelations(client: PoolClient, relations: RelationRecord[]): Promise<{ inserted: number }> {
	let inserted = 0;
	for (const relation of relations) {
		const from = await getEntityOrThrow(client, relation.fromId);
		const to = await getEntityOrThrow(client, relation.toId);
		const { inserted: wasInserted } = await insertRelation(client, { ...relation, fromId: from.id, toId: to.id });
		if (wasInserted) {
			inserted += 1;
		}
	}
	return { inserted };
}

export async function linkEntities(
	client: PoolClient,
	input: { fromId: string; toId: string; relationType: string }
): Promise<LinkResult> {
	if (input.fromId === input.toId) {
		throw new Error("Cannot create a relation from an entity to itself.");
	}

	const from = await getEntityOrThrow(client, input.fromId);
	const to = await getEntityOrThrow(client, input.toId);

	if (!isAllowedRelation(from.kind, to.kind, input.relationType)) {
		throw new Error(`Relation ${input.relationType} is not allowed from ${from.kind} to ${to.kind}.`);
	}

	if (
		(input.relationType === "blocks" || input.relationType === "supersedes") &&
		(await hasTypedPath(client, to.id, from.id, input.relationType))
	) {
		throw new Error(`Linking ${from.id} -> ${to.id} as ${input.relationType} would create a cycle.`);
	}

	const createdAt = new Date().toISOString();
	const relation: RelationRecord = { fromId: from.id, toId: to.id, type: input.relationType as RelationType, createdAt };
	const { inserted } = await insertRelation(client, relation);

	return { relation, created: inserted };
}

export async function unlinkEntities(
	client: PoolClient,
	input: { fromId: string; toId: string; relationType: string }
): Promise<UnlinkResult> {
	const relation = await getRelationOrThrow(client, input);

	if (await wouldOrphanSubtree(client, relation)) {
		throw new Error(
			`Unlinking ${relation.fromId} -> ${relation.toId} as ${relation.type} would orphan a subtree. Relink or delete descendants first.`
		);
	}

	if (await wouldBreakFullChainInvariant(client, relation)) {
		const target = await getEntityOrThrow(client, relation.toId);
		throw new Error(
			`Cannot unlink ${relation.fromId} -> ${relation.toId} as ${relation.type}: it is the only remaining structural parent, and every ${target.kind} must have one.`
		);
	}

	const removed = await client
		.delete(relations)
		.where(
			and(
				eq(relations.tenantId, client.tenantId),
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
	input: { entityId: string; status: string; author?: string }
): Promise<StatusUpdateResult> {
	const entity = await getEntityOrThrow(client, input.entityId);

	if (!isValidStatus(entity.kind, input.status)) {
		throw new Error(`Invalid status for ${entity.kind}: ${input.status}`);
	}

	if ((entity.kind === "prd" || entity.kind === "userStory" || entity.kind === "adr") && input.status === "superseded") {
		throw new Error(`${entity.id} status is derived (superseded); link a replacement record with supersedes instead.`);
	}

	if (
		(entity.kind === "prd" || entity.kind === "userStory" || entity.kind === "adr") &&
		(await isEntitySuperseded(client, entity.id, entity.kind))
	) {
		throw new Error(`${entity.id} status is derived (superseded) because another ${entity.kind} supersedes it.`);
	}

	if (entity.kind === "userStory") {
		const fixingIssueStatuses = await getFixingIssueStatuses(client, entity.id);
		if (fixingIssueStatuses.length > 0) {
			throw new Error(`${entity.id} status is derived from its fixing issues; update those issues instead of setting it directly.`);
		}
	}

	if (entity.kind === "prd") {
		const createdStoryStatuses = await getCreatedStoryStatuses(client, entity.id);
		if (createdStoryStatuses.length > 0) {
			throw new Error(`${entity.id} status is derived from its user stories; update the underlying issues instead of setting it directly.`);
		}
	}

	if (entity.kind === "adr") {
		if ((await getConstrainedIssueStatuses(client, entity.id)).length > 0) {
			throw new Error(`${entity.id} status is derived from the issues it constrains; update those issues instead of setting it directly.`);
		}
	}

	if (entity.kind === "initiative") {
		const { trackedIssueStatuses, ownedPrdStatuses } = await getInitiativeChildStatuses(client, entity.id);
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
		const openSubIssues = await getOpenSubIssues(client, entity.id);
		if (openSubIssues.length > 0) {
			throw new Error(
				`Cannot set ${entity.id} to ${input.status} while sub-issues remain open: ${openSubIssues.map((issue) => issue.id).join(", ")}.`
			);
		}

		const blockingIssues = await getActiveBlockingIssues(client, entity.id);
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
		.where(and(eq(entities.tenantId, client.tenantId), eq(entities.id, entity.id), eq(entities.revision, entity.revision)))
		.returning({ id: entities.id });
	if (updated.length === 0) {
		const current = await getEntityOrThrow(client, entity.id);
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}
	await appendDeltaEntry(client, entity.id, newRevision, entity.title, entity.body, entity.bodySource, input.author, updatedAt, {
		priorStatus: entity.status
	});

	return { entity: await getEntityOrThrow(client, entity.id), previousStatus };
}

export async function setEntityBody(
	client: PoolClient,
	input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }
): Promise<EntityRecord> {
	const current = await getEntityOrThrow(client, input.entityId);

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
		.where(and(eq(entities.tenantId, client.tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash)))
		.returning({ id: entities.id });

	if (!guard) {
		const fresh = await getEntityOrThrow(client, current.id);
		throw new EntityConflictError(input.entityId, fresh.revision, fresh.contentHash);
	}

	await appendDeltaEntry(client, current.id, newRevision, current.title, current.body, current.bodySource, input.author, updatedAt);
	return getEntityOrThrow(client, current.id);
}

export async function updateEntity(
	client: PoolClient,
	input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }
): Promise<EntityRecord> {
	const current = await getEntityOrThrow(client, input.entityId);
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
		.where(and(eq(entities.tenantId, client.tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash)))
		.returning({ id: entities.id });

	if (!guard) {
		const fresh = await getEntityOrThrow(client, current.id);
		throw new EntityConflictError(input.entityId, fresh.revision, fresh.contentHash);
	}

	await appendDeltaEntry(client, current.id, newRevision, current.title, current.body, current.bodySource, input.author, updatedAt);
	return getEntityOrThrow(client, current.id);
}

export async function materializeEntityRevision(
	client: PoolClient,
	input: { entityId: string; revision: number }
): Promise<MaterializedEntityRevision> {
	const row = await resolveEntity(client, input.entityId, true);
	if (!row) {
		throw new EntityRevisionError(input.entityId, "entity-not-found", `Entity not found: ${input.entityId}`);
	}

	const entity = mapDrizzleEntityRow(row);
	const parentId = (await getStructuralParentRelations(client, entity.id))[0]?.fromId ?? null;
	const deltaRows = await client
		.select()
		.from(revisionEntries)
		.where(and(eq(revisionEntries.tenantId, client.tenantId), eq(revisionEntries.recordKind, "entity"), eq(revisionEntries.recordKey, encodeEntityRecordKey(row.id))))
		.orderBy(desc(revisionEntries.revision));
	const patches: EntityRevisionPatch[] = deltaRows.map((delta) => ({
		revision: delta.revision,
		author: delta.author,
		createdAt: delta.createdAt,
		patchFormat: delta.patchFormat,
		reversePatch: delta.reversePatch,
		sourceHash: decodeRevisionPatchHash(delta.sourceHash),
		targetHash: decodeRevisionPatchHash(delta.targetHash),
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
	input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }
): Promise<MaterializedEntityRevision> {
	const row = await resolveEntity(client, input.entityId, true);
	if (!row) {
		throw new EntityRevisionError(input.entityId, "entity-not-found", `Entity not found: ${input.entityId}`);
	}
	const current = mapDrizzleEntityRow(row);
	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}
	const source = await materializeEntityRevision(client, { entityId: current.id, revision: input.revision });
	const currentParentId = (await getStructuralParentRelations(client, current.id))[0]?.fromId ?? null;
	let restoredParent: EntityRecord | null = null;
	let restoredRelationType: RelationType | null = null;
	if (!source.tombstone && source.parentId) {
		restoredParent = await getEntityOrThrow(client, source.parentId);
		restoredRelationType = getAllowedRelationType(restoredParent.kind, current.kind);
		if (!restoredRelationType || !isStructuralRelationType(restoredRelationType)) {
			throw new Error(`Cannot restore ${current.kind} under ${restoredParent.kind}.`);
		}
		if (await hasStructuralPath(client, current.id, restoredParent.id)) {
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
	}).where(and(eq(entities.tenantId, client.tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash))).returning({ id: entities.id });
	if (!guard) {
		const [freshRow] = await client.select().from(entities).where(and(eq(entities.tenantId, client.tenantId), eq(entities.id, current.id)));
		const fresh = mapDrizzleEntityRow(freshRow!);
		throw new EntityConflictError(current.id, fresh.revision, fresh.contentHash);
	}

	for (const relation of await getStructuralParentRelations(client, current.id)) {
		await client.delete(relations).where(and(eq(relations.tenantId, client.tenantId), eq(relations.fromId, relation.fromId), eq(relations.toId, relation.toId), eq(relations.type, relation.type)));
	}
	if (restoredParent && restoredRelationType) {
		await insertRelation(client, { fromId: restoredParent.id, toId: current.id, type: restoredRelationType, createdAt: updatedAt });
	}
	await refreshProjectAssignments(client);

	await appendDeltaEntry(client, current.id, newRevision, current.title, current.body, current.bodySource, input.author, updatedAt, {
		priorStatus: current.status,
		priorParentId: currentParentId,
		priorTombstone: row.tombstone,
		restoredFromRevision: input.revision
	});
	return materializeEntityRevision(client, { entityId: current.id, revision: newRevision });
}

export async function archiveEntity(client: PoolClient, input: { entityId: string }): Promise<StatusUpdateResult> {
	const entity = await getEntityOrThrow(client, input.entityId);
	return updateEntityStatus(client, { entityId: input.entityId, status: getArchiveStatus(entity.kind) });
}

export async function moveEntity(
	client: PoolClient,
	input: { entityId: string; newParentId: string; author?: string }
): Promise<MoveResult> {
	if (input.entityId === input.newParentId) {
		throw new Error("Cannot move an entity under itself.");
	}

	const entity = await getEntityOrThrow(client, input.entityId);
	const newParent = await getEntityOrThrow(client, input.newParentId);

	const relationType = getAllowedRelationType(newParent.kind, entity.kind);
	if (!relationType || !isStructuralRelationType(relationType)) {
		throw new Error(`Cannot move ${entity.kind} under ${newParent.kind}.`);
	}

	const currentParentRelations = await getStructuralParentRelations(client, entity.id);
	if (currentParentRelations.length > 1) {
		throw new Error(`Cannot move ${entity.id} because it has multiple structural parents.`);
	}

	if (await hasStructuralPath(client, entity.id, newParent.id)) {
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
					eq(relations.tenantId, client.tenantId),
					eq(relations.fromId, relation.fromId),
					eq(relations.toId, relation.toId),
					eq(relations.type, relation.type)
				)
			);
	}

	await insertRelation(client, { fromId: newParent.id, toId: entity.id, type: relationType, createdAt: updatedAt });
	await refreshProjectAssignments(client);

	const updated = await client
		.update(entities)
		.set({ revision: newRevision, updatedAt })
		.where(and(eq(entities.tenantId, client.tenantId), eq(entities.id, entity.id), eq(entities.revision, entity.revision)))
		.returning({ id: entities.id });
	if (updated.length === 0) {
		const current = await getEntityOrThrow(client, entity.id);
		throw new EntityConflictError(entity.id, current.revision, current.contentHash);
	}

	await appendDeltaEntry(client, entity.id, newRevision, entity.title, entity.body, entity.bodySource, input.author, updatedAt, {
		priorParentId: previousParentId
	});

	return {
		entity: await getEntityOrThrow(client, entity.id),
		previousParentId,
		newParentId: newParent.id,
		relationType
	};
}

export async function deleteEntity(client: PoolClient, input: { entityId: string }): Promise<DeleteResult> {
	const entity = await getEntityOrThrow(client, input.entityId);
	const previousParentId = (await getStructuralParentRelations(client, entity.id))[0]?.fromId ?? null;
	const dependentHandoffRows = await client
		.select({ id: entities.id })
		.from(entities)
		.innerJoin(relations, and(eq(relations.tenantId, entities.tenantId), eq(relations.fromId, entities.id)))
		.where(
			and(
				eq(entities.tenantId, client.tenantId),
				eq(entities.kind, "handoff"),
				eq(entities.tombstone, false),
				eq(relations.toId, entity.id),
				eq(relations.type, "handsOff")
			)
		);
	for (const { id: handoffId } of dependentHandoffRows) {
		const handoff = await getEntityOrThrow(client, handoffId);
		const handoffUpdatedAt = new Date().toISOString();
		const handoffRevision = handoff.revision + 1;
		await client
			.delete(relations)
			.where(and(eq(relations.tenantId, client.tenantId), or(eq(relations.fromId, handoff.id), eq(relations.toId, handoff.id))));
		await client
			.update(entities)
			.set({ tombstone: true, revision: handoffRevision, updatedAt: handoffUpdatedAt })
			.where(and(eq(entities.tenantId, client.tenantId), eq(entities.id, handoff.id), eq(entities.tombstone, false)));
		await appendDeltaEntry(client, handoff.id, handoffRevision, handoff.title, handoff.body, handoff.bodySource, undefined, handoffUpdatedAt, {
			priorTombstone: false
		});
	}

	const [outgoingResult] = await client
		.select({ count: sql<number>`count(*)` })
		.from(relations)
		.where(and(eq(relations.tenantId, client.tenantId), eq(relations.fromId, entity.id)));
	if (Number(outgoingResult?.count ?? 0) > 0) {
		throw new Error(`Cannot delete ${entity.id} while it still has outgoing relations. Unlink or delete dependents first.`);
	}

	const updatedAt = new Date().toISOString();
	const newRevision = entity.revision + 1;
	await client
		.delete(relations)
		.where(and(eq(relations.tenantId, client.tenantId), or(eq(relations.fromId, entity.id), eq(relations.toId, entity.id))));
	const removed = await client
		.update(entities)
		.set({ tombstone: true, revision: newRevision, updatedAt })
		.where(
			and(
				eq(entities.tenantId, client.tenantId),
				eq(entities.id, entity.id),
				eq(entities.tombstone, false),
				eq(entities.revision, entity.revision)
			)
		)
		.returning({ id: entities.id });
	if (removed.length === 0) {
		const current = await getEntityOrThrow(client, entity.id);
		throw new EntityConflictError(entity.id, current.revision, current.contentHash);
	}
	await appendDeltaEntry(client, entity.id, newRevision, entity.title, entity.body, entity.bodySource, undefined, updatedAt, {
		priorParentId: previousParentId,
		priorTombstone: false
	});

	return { entity, removed: removed.length > 0 };
}

export async function listOrphans(client: PoolClient, kind?: string): Promise<EntityRecord[]> {
	if (kind && !isEntityKind(kind)) {
		throw new Error(`Unknown entity kind: ${kind}`);
	}

	const entities = await getAllEntities(client);
	const relations = await getAllRelations(client);
	const reachable = new Set<string>();

	for (const entity of entities) {
		if (entity.kind !== "initiative") {
			continue;
		}

		for (const id of collectReachableIds(relations, entity.id)) {
			reachable.add(id);
		}
	}

	const statusMap = await getDerivedStatusMap(client);
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

export async function listProjectAdrs(client: PoolClient, projectId?: string): Promise<EntityRecord[]> {
	const entityRecords = await getAllEntities(client);
	const relations = await getAllRelations(client);
	const childIds = new Set(relations.filter((relation) => isStructuralRelationType(relation.type)).map((relation) => relation.toId));

	if (!projectId) {
		return entityRecords.filter((entity) => entity.kind === "adr" && !childIds.has(entity.id));
	}

	const rows = await client
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, client.tenantId), eq(entities.kind, "adr"), eq(entities.projectId, projectId)))
		.orderBy(asc(entities.id));
	return rows.map(mapDrizzleEntityRow).filter((entity) => !childIds.has(entity.id));
}

export async function getInitiativeBundle(
	client: PoolClient,
	initiativeId: string,
	allowedIds?: ReadonlySet<string>,
	statusMap?: ReadonlyMap<string, string>
): Promise<InitiativeBundle> {
	const initiative = await getEntityOrThrow(client, initiativeId);
	if (initiative.kind !== "initiative") {
		throw new Error(`${initiativeId} is not an initiative.`);
	}

	const reachableResult = await client.execute(sql`
		WITH RECURSIVE reachable(id) AS (
			SELECT ${initiative.id}::uuid
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
			WHERE relations.tenant_id = ${client.tenantId}
		)
		SELECT id FROM reachable
	`);
	const reachableIds = (reachableResult.rows as Array<{ id: string }>).map((row) => row.id);
	const selectedIds = new Set(reachableIds.filter((id) => !allowedIds || allowedIds.has(id)));

	const entityResult = await client.execute(sql`
		SELECT * FROM entities
		WHERE tenant_id = ${client.tenantId} AND id = ANY(ARRAY[${sql.join([...selectedIds], sql`, `)}]::uuid[])
		ORDER BY id
	`);
	const relationResult = await client.execute(sql`SELECT * FROM relations WHERE tenant_id = ${client.tenantId}`);
	const entityRows = entityResult.rows as EntityRow[];
	const relationRows = relationResult.rows as RelationRow[];

	const entities = entityRows.map(mapEntityRow);
	const selectedRelations = relationRows.filter(
		(relation) => selectedIds.has(relation.from_id) && selectedIds.has(relation.to_id)
	);
	const derivedStatusMap = statusMap ?? (await getDerivedStatusMap(client));
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

export async function getDatabaseSnapshot(client: PoolClient, projectIdentity: string | undefined): Promise<DatabaseSnapshot>;
export async function getDatabaseSnapshot(client: PoolClient, projectIdentity: string | undefined, input: { projectId: string }): Promise<ProjectSnapshot>;
export async function getDatabaseSnapshot(
	client: PoolClient,
	projectIdentity: string | undefined,
	input?: { projectId: string }
): Promise<DatabaseSnapshot | ProjectSnapshot> {
	if (input?.projectId) {
		const discovery = await getProjectDiscovery(client, input);
		if (discovery.kind === "unavailable") {
			return { kind: "unavailable" };
		}

		const project = discovery.projects.find((entry) => entry.project.id === input.projectId)!.project;
		const snapshot = await withCurrentProject(client, project.id, () => getProjectSnapshot(client, project));
		return { kind: "available", snapshot };
	}

	const entities = await getAllDerivedEntities(client);
	const relations = await getAllRelations(client);
	const initiatives = entities.filter((entity) => entity.kind === "initiative");
	const statusMap = new Map(entities.map((entity) => [entity.id, entity.status]));

	const orphans = await listOrphans(client);
	const projectAdrs = await listProjectAdrs(client);
	const initiativeBundles = await Promise.all(
		initiatives.map((entity) => getInitiativeBundle(client, entity.id, undefined, statusMap))
	);

	const sharedContext: ContextDetails = await queryContextDetails(client, projectIdentity);
	const initiativeContexts = await Promise.all(
		initiatives.map((entity) => queryContextDetails(client, projectIdentity, entity.id))
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

async function getProjectSnapshot(client: PoolClient, project: EntityRecord): Promise<DatabaseSnapshot> {
	const allEntities = await getAllDerivedEntities(client);
	const allRelations = await getAllRelations(client);
	const selectedIds = collectReachableIds(allRelations.filter((relation) => isStructuralRelationType(relation.type)), project.id);
	const entities = allEntities.filter((entity) => selectedIds.has(entity.id));
	const relations = allRelations.filter((relation) => selectedIds.has(relation.fromId) && selectedIds.has(relation.toId));
	const initiatives = entities.filter((entity) => entity.kind === "initiative");
	const structuralRelations = allRelations.filter((relation) => isStructuralRelationType(relation.type));
	const statusMap = new Map(allEntities.map((entity) => [entity.id, entity.status]));
	const projectAdrs = await listProjectAdrs(client, project.id);

	return {
		generatedAt: new Date().toISOString(),
		entities,
		relations,
		orphans: [],
		projectAdrs,
		initiatives: await Promise.all(
			initiatives.map((entity) =>
				getInitiativeBundle(client, entity.id, collectReachableIds(structuralRelations, entity.id), statusMap)
			)
		),
		contexts: {
			shared: await queryProjectContextDetails(client, project),
			initiatives: await Promise.all(initiatives.map((entity) => queryProjectContextDetails(client, project, entity.id)))
		}
	};
}

async function getEntityProjectId(client: PoolClient, entityId: string): Promise<string | null> {
	const result = await client.execute(sql`
		SELECT project_id FROM entities WHERE tenant_id = ${client.tenantId} AND id = ${entityId}
	`);
	return (result.rows as Array<{ project_id: string | null }>)[0]?.project_id ?? null;
}

/**
 * The epic a parent-less initiative attaches to, mirroring local's own
 * `resolveDefaultEpicId`: this request's project's epic, so an initiative
 * created from a workspace lands in that workspace's project rather than in
 * the tenant-wide `PROJ0`/`EPIC0` sentinel pair. Falls back to the sentinel
 * epic for a request carrying no identity at all, or for a project that
 * somehow has no epic of its own.
 */
async function resolveDefaultEpicId(client: PoolClient, projectIdentity: string | undefined): Promise<string> {
	const sentinelEpicId = deriveMigratedEntityIdentity("epic", DEFAULT_EPIC_ID).stableId;
	if (!projectIdentity) {
		return sentinelEpicId;
	}

	const projectId = await resolveProjectIdForWrite(client, projectIdentity);
	const result = await client.execute(sql`
		SELECT entities.id AS id
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${client.tenantId}
			AND relations.from_id = ${projectId}
			AND relations.type = 'contains'
			AND entities.kind = 'epic'
		ORDER BY entities.id
		LIMIT 1
	`);
	return (result.rows as Array<{ id: string }>)[0]?.id ?? sentinelEpicId;
}

/**
 * The project a write lands in when it has no parent to inherit from. A
 * request that carries a `projectIdentity` gets that identity's own project,
 * minted on first use (`getOrCreateProjectByIdentity`) - previously this
 * silently fell back to the `PROJ0` sentinel instead, so a fresh workspace's
 * first issue landed in Default Project while its context landed in a
 * correctly-minted project of its own. Only a request with no identity at all
 * (the tenant-wide backfill in `refreshProjectAssignments`) still resolves to
 * the sentinel, which is the only project it can mean.
 */
async function resolveProjectIdForWrite(client: PoolClient, projectIdentity: string | undefined): Promise<string> {
	if (projectIdentity) {
		return (await getOrCreateProjectByIdentity(client, projectIdentity)).id;
	}

	return (await getEntityOrThrow(client, deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId)).id;
}

async function refreshProjectAssignments(client: PoolClient, projectIdentity?: string): Promise<void> {
	const entityResult = await client.execute(sql`SELECT id, kind FROM entities WHERE tenant_id = ${client.tenantId}`);
	const relationResult = await client.execute(sql`
		SELECT from_id, to_id, type FROM relations WHERE tenant_id = ${client.tenantId}
	`);
	const entities = entityResult.rows as Array<{ id: string; kind: string }>;
	const relations = relationResult.rows as Array<{ from_id: string; to_id: string; type: string }>;
	const assignment = assignEntitiesToProjects(
		entities,
		relations.map((relation) => ({ fromId: relation.from_id, toId: relation.to_id, type: relation.type })),
		deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId
	);
	const fallbackProjectId = await resolveProjectIdForWrite(client, projectIdentity);

	for (const entity of entities) {
		const projectId = entity.kind === "project" ? entity.id : (assignment.get(entity.id) ?? fallbackProjectId);
		await client.execute(sql`
			UPDATE entities SET project_id = ${projectId} WHERE tenant_id = ${client.tenantId} AND id = ${entity.id}
		`);
	}
}

export async function getProjectDiscovery(
	client: PoolClient,
	input?: { projectId?: string }
): Promise<ProjectDiscovery> {
	// Deliberately tenant-wide (as local's is): this is the call that tells a
	// caller which projects exist, so it cannot itself require knowing one.
	const entities = await getTenantEntities(client);
	const relations = await getTenantRelations(client);
	const statusMap = new Map(deriveEntityStatuses(entities, relations).map((entity) => [entity.id, entity.status]));
	const derivedEntities = entities.map((entity) => applyDerivedStatus(entity, statusMap));
	const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
	const projects = derivedEntities.filter((entity) => entity.kind === "project" && entity.id !== defaultProjectId);
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
//
// `relations` is the exception: the table has no `updated_at` (a relation is
// never updated - the primary key covers every column but `created_at`, so a
// change is a delete plus an insert), and `created_at` is copied verbatim from
// the incoming payload on synchronize rather than being a local write clock.
// Count alone therefore misses a swap - unlink one relation, link another, and
// the total is unchanged. Summing a hash of each row's identity closes that:
// it is order-independent, so it needs no sort, and constant-memory, so it
// costs one extra aggregate over a scan `count(*)` was doing anyway rather
// than building a digest string proportional to the relation count.
export async function getSnapshotSignature(client: PoolClient): Promise<string> {
	const result = await client.execute(sql`
		SELECT
			(SELECT count(*) FROM entities WHERE tenant_id = ${client.tenantId}) AS entity_count,
			(SELECT max(updated_at) FROM entities WHERE tenant_id = ${client.tenantId}) AS entity_max_updated,
			(SELECT count(*) FROM relations WHERE tenant_id = ${client.tenantId}) AS relation_count,
			(SELECT sum(hashtext(from_id::text || to_id::text || type)::bigint) FROM relations WHERE tenant_id = ${client.tenantId}) AS relation_digest,
			(SELECT count(*) FROM contexts WHERE tenant_id = ${client.tenantId}) AS context_count,
			(SELECT max(updated_at) FROM contexts WHERE tenant_id = ${client.tenantId}) AS context_max_updated,
			(SELECT count(*) FROM context_terms WHERE tenant_id = ${client.tenantId}) AS term_count,
			(SELECT max(updated_at) FROM context_terms WHERE tenant_id = ${client.tenantId}) AS term_max_updated
	`);
	const row = (result.rows as Array<{
		entity_count: string;
		entity_max_updated: string | null;
		relation_count: string;
		relation_digest: string | null;
		context_count: string;
		context_max_updated: string | null;
		term_count: string;
		term_max_updated: string | null;
	}>)[0]!;
	return [
		`entities:${row.entity_count}:${row.entity_max_updated}`,
		`relations:${row.relation_count}:${row.relation_digest}`,
		`contexts:${row.context_count}:${row.context_max_updated}`,
		`terms:${row.term_count}:${row.term_max_updated}`
	].join("|");
}
