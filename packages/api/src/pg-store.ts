import { randomUUID } from "node:crypto";

import Fuse from "fuse.js";

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
	type ContextDirectory,
	type ContextDirectoryTerm,
	type ContextDirectoryTermSource,
	type ContextDirectoryView,
	type ContextListResult,
	type ContextRecord,
	type ContextTermRecord,
	type DefineContextTermResult,
	type DeleteTenantResult,
	type EntityKind,
	type EntityRecord,
	type ForgetContextTermResult,
	type HandoffRecord,
	type HistoryEntryRecord,
	type QueryContextDirectoryInput,
	type QueryContextDirectoryResult,
	type RelationRecord,
	type RelationType,
	type RenameTenantResult,
	type StorageDriver,
	type TenantRecordCounts,
	type TenantSummary
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

type CounterRow = {
	kind: string;
	next_value: number;
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

type ContextRow = {
	key: string;
	scope_entity_id: string | null;
	title: string;
	summary: string;
	created_at: string;
	updated_at: string;
};

type ContextTermRow = {
	term: string;
	definition: string;
	avoid_terms: string;
	created_at: string;
	updated_at: string;
};

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

// Walks owns/records/tracks/creates relations (deliberately narrower than
// isStructuralRelationType's full set, matching context-store.ts) from
// `entityId` up to its owning initiative.
async function getOwningInitiativeOrThrow(client: PoolClient, tenantId: string, entityId: string): Promise<EntityRecord> {
	let currentId = entityId;
	const seen = new Set<string>([entityId]);

	while (true) {
		const result = await client.query<EntityRow>(
			`SELECT entities.*
			 FROM relations
			 JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			 WHERE relations.tenant_id = $1
			   AND relations.to_id = $2
			   AND relations.type IN ('owns', 'records', 'tracks', 'creates')
			 ORDER BY entities.id`,
			[tenantId, currentId]
		);

		if (result.rows.length === 0) {
			throw new Error(`No owning initiative found for ${entityId}.`);
		}

		if (result.rows.length > 1) {
			throw new Error(`Cannot resolve owning initiative for ${entityId} because ${currentId} has multiple structural parents.`);
		}

		const parent = mapEntityRow(result.rows[0]!);
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

async function resolveContextScope(client: PoolClient, tenantId: string, scopeRef?: string): Promise<ResolvedContextScope> {
	if (!scopeRef || scopeRef === DEFAULT_CONTEXT_KEY) {
		return getDefaultContextScope();
	}

	const entity = await getEntityOrThrow(client, tenantId, scopeRef);
	if (entity.kind === "initiative") {
		return createInitiativeScope(entity);
	}

	const initiative = await getOwningInitiativeOrThrow(client, tenantId, entity.id);
	return createInitiativeScope(initiative);
}

async function fetchContextRow(client: PoolClient, tenantId: string, key: string): Promise<ContextRow | undefined> {
	const result = await client.query<ContextRow>(`SELECT * FROM contexts WHERE tenant_id = $1 AND key = $2`, [tenantId, key]);
	return result.rows[0];
}

async function fetchContextTermRows(client: PoolClient, tenantId: string, key: string): Promise<ContextTermRow[]> {
	const result = await client.query<ContextTermRow>(
		`SELECT term, definition, avoid_terms, created_at, updated_at FROM context_terms WHERE tenant_id = $1 AND context_key = $2 ORDER BY lower(term), term`,
		[tenantId, key]
	);
	return result.rows;
}

async function queryContextDetails(client: PoolClient, tenantId: string, scopeRef?: string): Promise<ContextDetails> {
	const scope = await resolveContextScope(client, tenantId, scopeRef);
	const row = await fetchContextRow(client, tenantId, scope.key);
	const termRows = row ? await fetchContextTermRows(client, tenantId, scope.key) : [];

	return {
		context: row ? mapContextRow(row, scope) : createContextRecord(scope),
		terms: termRows.map(mapContextTermRow)
	};
}

async function queryContextTermCount(client: PoolClient, tenantId: string, contextKey: string): Promise<number> {
	const result = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM context_terms WHERE tenant_id = $1 AND context_key = $2`, [
		tenantId,
		contextKey
	]);
	return Number(result.rows[0]?.count ?? "0");
}

async function queryListContexts(client: PoolClient, tenantId: string): Promise<ContextListResult> {
	const defaultScope = getDefaultContextScope();
	const defaultRow = await fetchContextRow(client, tenantId, defaultScope.key);
	const contexts = [
		{
			context: defaultRow ? mapContextRow(defaultRow, defaultScope) : createContextRecord(defaultScope),
			termCount: await queryContextTermCount(client, tenantId, defaultScope.key)
		}
	];

	const initiativeRows = await client.query<EntityRow>(`SELECT * FROM entities WHERE tenant_id = $1 AND kind = 'initiative' ORDER BY id`, [
		tenantId
	]);

	for (const initiativeRow of initiativeRows.rows) {
		const initiative = mapEntityRow(initiativeRow);
		const scope = createInitiativeScope(initiative);
		const row = await fetchContextRow(client, tenantId, scope.key);
		contexts.push({
			context: row ? mapContextRow(row, scope) : createContextRecord(scope),
			termCount: await queryContextTermCount(client, tenantId, scope.key)
		});
	}

	return { contexts };
}

async function buildContextDirectory(client: PoolClient, tenantId: string): Promise<ContextDirectory> {
	const shared = await queryContextDetails(client, tenantId);
	const initiativeRows = await client.query<EntityRow>(`SELECT * FROM entities WHERE tenant_id = $1 AND kind = 'initiative' ORDER BY id`, [
		tenantId
	]);
	const initiatives = await Promise.all(initiativeRows.rows.map((row) => queryContextDetails(client, tenantId, row.id)));
	const termsByKey = new Map<string, ContextDirectoryTerm>();

	for (const details of [shared, ...initiatives]) {
		for (const term of details.terms) {
			const key = term.term.toLowerCase();
			const existing = termsByKey.get(key);
			const source: ContextDirectoryTermSource = {
				avoid: [...term.avoid],
				contextKey: details.context.key,
				contextTitle: details.context.title,
				definition: term.definition,
				scopeEntityId: details.context.scopeEntityId,
				scopeKind: details.context.scopeKind,
				scopeLabel: details.context.scopeLabel,
				updatedAt: term.updatedAt
			};

			if (!existing) {
				termsByKey.set(key, {
					term: term.term,
					sources: [source],
					hasSharedSource: details.context.scopeKind === "default",
					hasDuplicates: false,
					hasConflictingDefinitions: false
				});
				continue;
			}

			existing.sources.push(source);
			existing.hasDuplicates = existing.sources.length > 1;
			existing.hasSharedSource = existing.hasSharedSource || details.context.scopeKind === "default";
			existing.hasConflictingDefinitions = hasConflictingDefinitions(existing.sources);
			if (term.term.localeCompare(existing.term) < 0) {
				existing.term = term.term;
			}
		}
	}

	const terms = [...termsByKey.values()]
		.map((entry) => ({ ...entry, sources: entry.sources.sort(compareContextDirectorySources) }))
		.sort((left, right) => left.term.localeCompare(right.term));

	return {
		shared,
		initiatives,
		terms,
		duplicateTerms: terms.filter((entry) => entry.hasDuplicates).map((entry) => entry.term)
	};
}

function hasConflictingDefinitions(sources: ContextDirectoryTermSource[]): boolean {
	const normalizedDefinitions = new Set(
		sources.map((source) => source.definition.trim().toLowerCase()).filter((definition) => definition.length > 0)
	);

	return normalizedDefinitions.size > 1;
}

function compareContextDirectorySources(left: ContextDirectoryTermSource, right: ContextDirectoryTermSource): number {
	if (left.scopeKind !== right.scopeKind) {
		return left.scopeKind === "default" ? -1 : 1;
	}

	if (left.scopeLabel !== right.scopeLabel) {
		return left.scopeLabel.localeCompare(right.scopeLabel);
	}

	return left.contextKey.localeCompare(right.contextKey);
}

function tokenizeContextSearch(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

function buildContextQuery(queryTokens: string[]): { $and: Array<{ tokens: string }> } | { tokens: string } {
	if (queryTokens.length === 1) {
		return { tokens: `^${queryTokens[0]}` };
	}

	return { $and: queryTokens.map((token) => ({ tokens: `^${token}` })) };
}

function matchesContextQuery(text: string, normalizedQuery: string): boolean {
	const queryTokens = tokenizeContextSearch(normalizedQuery);

	if (queryTokens.length === 0) {
		return true;
	}

	const fuse = new Fuse([{ tokens: tokenizeContextSearch(text) }], {
		ignoreLocation: true,
		isCaseSensitive: false,
		keys: ["tokens"],
		threshold: 0,
		useExtendedSearch: true
	});

	return fuse.search(buildContextQuery(queryTokens)).length > 0;
}

function filterContextDetails(details: ContextDetails, normalizedQuery: string): ContextDetails | null {
	if (normalizedQuery.length === 0) {
		return details;
	}

	const contextMatches = matchesContextQuery(
		[details.context.key, details.context.scopeLabel, details.context.summary, details.context.title].join(" "),
		normalizedQuery
	);
	const terms = details.terms.filter((term) => matchesContextQuery([term.term, term.definition, ...term.avoid].join(" "), normalizedQuery));

	if (!contextMatches && terms.length === 0) {
		return null;
	}

	return {
		context: { ...details.context, summary: contextMatches ? details.context.summary : "" },
		terms
	};
}

function filterContextDirectoryTerm(entry: ContextDirectoryTerm, normalizedQuery: string, view: ContextDirectoryView): ContextDirectoryTerm | null {
	const sources = entry.sources.filter((source) => {
		if (view === "global" && source.scopeKind !== "default") {
			return false;
		}

		if (view === "initiatives" && source.scopeKind === "default") {
			return false;
		}

		if (normalizedQuery.length === 0) {
			return true;
		}

		return matchesContextQuery([entry.term, source.scopeLabel, source.contextTitle, source.definition, ...source.avoid].join(" "), normalizedQuery);
	});

	if (sources.length === 0) {
		return null;
	}

	return {
		term: entry.term,
		sources,
		hasSharedSource: sources.some((source) => source.scopeKind === "default"),
		hasDuplicates: sources.length > 1,
		hasConflictingDefinitions: hasConflictingDefinitions(sources)
	};
}

async function ensureContextExists(client: PoolClient, tenantId: string, scopeRef?: string): Promise<ResolvedContextScope> {
	const scope = await resolveContextScope(client, tenantId, scopeRef);
	const existing = await fetchContextRow(client, tenantId, scope.key);
	if (existing) {
		return scope;
	}

	const now = new Date().toISOString();
	await client.query(
		`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $6)`,
		[tenantId, scope.key, scope.scopeEntityId, scope.defaultTitle, scope.defaultSummary, now]
	);

	return scope;
}

async function getContextTermRecord(client: PoolClient, tenantId: string, contextKey: string, term: string): Promise<ContextTermRecord | null> {
	const result = await client.query<ContextTermRow>(
		`SELECT term, definition, avoid_terms, created_at, updated_at FROM context_terms WHERE tenant_id = $1 AND context_key = $2 AND term = $3`,
		[tenantId, contextKey, term]
	);
	const row = result.rows[0];
	return row ? mapContextTermRow(row) : null;
}

// Mirrors database.ts's formatTenantDisplayName field-for-field: strips a
// trailing 12-hex-char workspace hash suffix, then title-cases the
// remaining hyphen/underscore-separated segments.
function formatTenantDisplayName(tenantId: string): string {
	const withoutHashSuffix = tenantId.replace(/-[0-9a-f]{12}$/i, "");
	return withoutHashSuffix
		.split(/[-_]+/)
		.filter((segment) => segment.length > 0)
		.map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
		.join(" ");
}

async function getTenantRecordCounts(client: PoolClient, tenantId: string): Promise<TenantRecordCounts> {
	const result = await client.query<{
		entity_count: string;
		relation_count: string;
		context_count: string;
		context_term_count: string;
		handoff_count: string;
		history_entry_count: string;
	}>(
		`SELECT
			(SELECT COUNT(*) FROM entities WHERE tenant_id = $1) AS entity_count,
			(SELECT COUNT(*) FROM relations WHERE tenant_id = $1) AS relation_count,
			(SELECT COUNT(*) FROM contexts WHERE tenant_id = $1) AS context_count,
			(SELECT COUNT(*) FROM context_terms WHERE tenant_id = $1) AS context_term_count,
			(SELECT COUNT(*) FROM handoffs WHERE tenant_id = $1) AS handoff_count,
			(SELECT COUNT(*) FROM history_entries WHERE tenant_id = $1) AS history_entry_count`,
		[tenantId]
	);
	const row = result.rows[0]!;

	return {
		contexts: Number(row.context_count),
		contextTerms: Number(row.context_term_count),
		entities: Number(row.entity_count),
		handoffs: Number(row.handoff_count),
		historyEntries: Number(row.history_entry_count),
		relations: Number(row.relation_count)
	};
}

async function getTenantCounterCount(client: PoolClient, tenantId: string): Promise<number> {
	const result = await client.query<{ counter_count: string }>(`SELECT COUNT(*) AS counter_count FROM counters WHERE tenant_id = $1`, [
		tenantId
	]);
	return Number(result.rows[0]!.counter_count);
}

async function tenantHasAnyRows(client: PoolClient, tenantId: string): Promise<boolean> {
	const result = await client.query<{ has_rows: boolean }>(
		`SELECT EXISTS(
			SELECT 1 FROM counters WHERE tenant_id = $1
			UNION SELECT 1 FROM entities WHERE tenant_id = $1
			UNION SELECT 1 FROM relations WHERE tenant_id = $1
			UNION SELECT 1 FROM contexts WHERE tenant_id = $1
			UNION SELECT 1 FROM context_terms WHERE tenant_id = $1
			UNION SELECT 1 FROM handoffs WHERE tenant_id = $1
			UNION SELECT 1 FROM history_entries WHERE tenant_id = $1
		) AS has_rows`,
		[tenantId]
	);
	return result.rows[0]!.has_rows;
}

// RLS (ADR9, the 0001 migration) scopes every query to whatever
// `app.tenant_id` is currently set to, so re-pointing it mid-transaction is
// how a tenant-administration method deliberately looks at (or writes) rows
// for a tenant other than the one `withTenantTransaction` opened for.
async function setSessionTenant(client: PoolClient, tenantId: string): Promise<void> {
	await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

// Tenant-administration methods only ever act on the calling store's own
// tenant (ADR9): a request authenticated for one tenant must never be able
// to delete or rename another tenant's data just by passing a different id.
// This also matches Postgres reality - RLS makes every query silently see
// zero rows for any tenant other than `this.tenantId`, so without this guard
// a mismatched id would fail confusingly quiet instead of loud.
function requireOwnTenant(ownTenantId: string, requestedTenantId: string, operation: string): void {
	if (requestedTenantId !== ownTenantId) {
		throw new Error(`${operation} may only act on this store's own tenant (${ownTenantId}), not ${requestedTenantId}.`);
	}
}

/**
 * Postgres implementation of the storage-driver seam (ADR11, ADR13, ISS39).
 * Every method opens exactly one `withTenantTransaction` (ADR9's `SET LOCAL
 * app.tenant_id`), so RLS is always active for the query.
 *
 * Tenant administration (`listTenants`/`deleteTenant`/`renameTenant`) is
 * necessarily narrower here than `SqliteStore`'s: RLS makes each `PgStore`
 * instance's own tenant the only one it can ever see or touch (ADR9), so
 * these methods only ever report on or act on `this.tenantId` - never an
 * arbitrary other tenant the way a single SQLite file's admin CLI can.
 * `renameTenant` copies every row to the new tenant id under a temporarily
 * re-pointed `app.tenant_id` and then deletes the old rows, rather than a
 * single `UPDATE ... SET tenant_id`, because RLS's `USING` (old value) and
 * `WITH CHECK` (new value) can never both pass for one statement scoped to
 * a single session tenant id.
 */
export class PgStore implements StorageDriver {
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

			const sharedContext = await queryContextDetails(client, this.tenantId);
			const initiativeContexts = await Promise.all(initiatives.map((entity) => queryContextDetails(client, this.tenantId, entity.id)));

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

	public async listContexts(): Promise<ContextListResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => queryListContexts(client, this.tenantId));
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => queryContextDetails(client, this.tenantId, input?.scopeRef));
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => buildContextDirectory(client, this.tenantId));
	}

	public async queryContextDirectory(input: QueryContextDirectoryInput = {}): Promise<QueryContextDirectoryResult> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const directory = await buildContextDirectory(client, this.tenantId);
			const view = input.view ?? "all";
			const query = input.query?.trim() ?? "";
			const conflictsOnly = input.conflictsOnly ?? false;
			const normalizedQuery = query.toLowerCase();

			const shared = view === "initiatives" ? null : filterContextDetails(directory.shared, normalizedQuery);
			const initiatives =
				view === "global"
					? []
					: directory.initiatives
							.map((details) => filterContextDetails(details, normalizedQuery))
							.filter((details): details is ContextDetails => details !== null);

			let terms = directory.terms
				.map((entry) => filterContextDirectoryTerm(entry, normalizedQuery, view))
				.filter((entry): entry is ContextDirectoryTerm => entry !== null);

			if (conflictsOnly) {
				terms = terms.filter((entry) => entry.hasDuplicates);
			}

			return {
				shared,
				initiatives,
				terms,
				duplicateTerms: terms.filter((entry) => entry.hasDuplicates).map((entry) => entry.term),
				query,
				view,
				conflictsOnly
			};
		});
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string }): Promise<ContextDetails> {
		const title = input.title.trim();
		const summary = input.summary.trim();

		if (title.length === 0) {
			throw new Error("Context title must not be empty.");
		}

		if (summary.length === 0) {
			throw new Error("Context summary must not be empty.");
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const scope = await resolveContextScope(client, this.tenantId, input.scopeRef);
			const existing = await queryContextDetails(client, this.tenantId, input.scopeRef);
			const now = new Date().toISOString();

			await client.query(
				`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 ON CONFLICT (tenant_id, key) DO UPDATE SET
				   scope_entity_id = excluded.scope_entity_id,
				   title = excluded.title,
				   summary = excluded.summary,
				   updated_at = excluded.updated_at`,
				[this.tenantId, scope.key, scope.scopeEntityId, title, summary, existing.context.createdAt ?? now, now]
			);

			return queryContextDetails(client, this.tenantId, input.scopeRef);
		});
	}

	public async defineContextTerm(input: {
		scopeRef?: string;
		term: string;
		definition: string;
		avoid?: string[];
	}): Promise<DefineContextTermResult> {
		const term = input.term.trim();
		const definition = input.definition.trim();

		if (term.length === 0) {
			throw new Error("Context term must not be empty.");
		}

		if (definition.length === 0) {
			throw new Error("Context term definition must not be empty.");
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const scope = await ensureContextExists(client, this.tenantId, input.scopeRef);
			const normalizedAvoid = normalizeAvoidTerms(input.avoid ?? [], term);
			const existing = await getContextTermRecord(client, this.tenantId, scope.key, term);
			const now = new Date().toISOString();

			await client.query(
				`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 ON CONFLICT (tenant_id, context_key, term) DO UPDATE SET
				   definition = excluded.definition,
				   avoid_terms = excluded.avoid_terms,
				   updated_at = excluded.updated_at`,
				[this.tenantId, scope.key, term, definition, JSON.stringify(normalizedAvoid), existing?.createdAt ?? now, now]
			);

			const storedTerm = await getContextTermRecord(client, this.tenantId, scope.key, term);
			if (!storedTerm) {
				throw new Error(`Failed to persist context term: ${term}`);
			}

			return {
				context: (await queryContextDetails(client, this.tenantId, input.scopeRef)).context,
				term: storedTerm,
				created: existing === null
			};
		});
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string }): Promise<ForgetContextTermResult> {
		const term = input.term.trim();
		if (term.length === 0) {
			throw new Error("Context term must not be empty.");
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const scope = await resolveContextScope(client, this.tenantId, input.scopeRef);
			const result = await client.query(`DELETE FROM context_terms WHERE tenant_id = $1 AND context_key = $2 AND term = $3`, [
				this.tenantId,
				scope.key,
				term
			]);

			return {
				context: (await queryContextDetails(client, this.tenantId, input.scopeRef)).context,
				term,
				removed: (result.rowCount ?? 0) > 0
			};
		});
	}

	public async listTenants(): Promise<TenantSummary[]> {
		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const counts = await getTenantRecordCounts(client, this.tenantId);
			const hasRows = Object.values(counts).some((count) => count > 0);

			if (!hasRows) {
				return [];
			}

			return [{ counts, displayName: formatTenantDisplayName(this.tenantId), id: this.tenantId }];
		});
	}

	public async deleteTenant(tenantId: string): Promise<DeleteTenantResult> {
		requireOwnTenant(this.tenantId, tenantId, "deleteTenant");

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			const counts = await getTenantRecordCounts(client, tenantId);

			await client.query(`DELETE FROM handoffs WHERE tenant_id = $1`, [tenantId]);
			await client.query(`DELETE FROM history_entries WHERE tenant_id = $1`, [tenantId]);
			await client.query(`DELETE FROM context_terms WHERE tenant_id = $1`, [tenantId]);
			await client.query(`DELETE FROM relations WHERE tenant_id = $1`, [tenantId]);
			await client.query(`DELETE FROM contexts WHERE tenant_id = $1`, [tenantId]);
			await client.query(`DELETE FROM entities WHERE tenant_id = $1`, [tenantId]);
			const deleteCounters = await client.query(`DELETE FROM counters WHERE tenant_id = $1`, [tenantId]);
			const counters = deleteCounters.rowCount ?? 0;

			return {
				counters,
				counts,
				displayName: formatTenantDisplayName(tenantId),
				removed: counters > 0 || Object.values(counts).some((count) => count > 0),
				tenantId
			};
		});
	}

	public async renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult> {
		requireOwnTenant(this.tenantId, previousTenantId, "renameTenant");

		if (previousTenantId === newTenantId) {
			throw new Error("Source and destination tenant ids are the same.");
		}

		return withTenantTransaction(this.pool, this.tenantId, async (client) => {
			// Briefly re-point RLS at the destination to answer "does it already
			// have rows?" - `previousTenantId`'s scope can never see that.
			await setSessionTenant(client, newTenantId);
			const targetHasRows = await tenantHasAnyRows(client, newTenantId);
			await setSessionTenant(client, previousTenantId);

			if (targetHasRows) {
				throw new Error(`Target tenant already exists: ${newTenantId}`);
			}

			const counts = await getTenantRecordCounts(client, previousTenantId);
			const counters = await getTenantCounterCount(client, previousTenantId);
			const renamed = counters > 0 || Object.values(counts).some((count) => count > 0);

			if (!renamed) {
				return {
					counters,
					counts,
					newDisplayName: formatTenantDisplayName(newTenantId),
					newTenantId,
					previousDisplayName: formatTenantDisplayName(previousTenantId),
					previousTenantId,
					renamed: false
				};
			}

			const entityRows = await client.query<EntityRow>(`SELECT * FROM entities WHERE tenant_id = $1`, [previousTenantId]);
			const relationRows = await client.query<RelationRow>(`SELECT * FROM relations WHERE tenant_id = $1`, [previousTenantId]);
			const contextRows = await client.query<ContextRow>(`SELECT * FROM contexts WHERE tenant_id = $1`, [previousTenantId]);
			const contextTermRows = await client.query<ContextTermRow & { context_key: string }>(
				`SELECT * FROM context_terms WHERE tenant_id = $1`,
				[previousTenantId]
			);
			const handoffRows = await client.query<HandoffRow>(`SELECT * FROM handoffs WHERE tenant_id = $1`, [previousTenantId]);
			const historyRows = await client.query<HistoryEntryRow>(`SELECT * FROM history_entries WHERE tenant_id = $1`, [previousTenantId]);
			const counterRows = await client.query<CounterRow>(`SELECT * FROM counters WHERE tenant_id = $1`, [previousTenantId]);

			// `history_entries.id` is a bare (non-tenant-scoped) primary key, so
			// the old rows must be gone before re-inserting the same ids under
			// the new tenant id - unlike every other table, whose primary key
			// includes tenant_id and so tolerates the copy-before-delete order.
			await client.query(`DELETE FROM history_entries WHERE tenant_id = $1`, [previousTenantId]);

			// Copy every row under the new tenant id (parent tables - entities,
			// contexts - before the tables that foreign-key to them), then
			// delete the old rows. A single cross-value `UPDATE ... SET
			// tenant_id` cannot satisfy RLS's USING (old value) and WITH CHECK
			// (new value) in one statement scoped to one session tenant id.
			await setSessionTenant(client, newTenantId);

			for (const row of entityRows.rows) {
				await client.query(
					`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[newTenantId, row.id, row.kind, row.title, row.status, row.body, row.body_source, row.created_at, row.updated_at]
				);
			}

			for (const row of contextRows.rows) {
				await client.query(
					`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[newTenantId, row.key, row.scope_entity_id, row.title, row.summary, row.created_at, row.updated_at]
				);
			}

			for (const row of relationRows.rows) {
				await client.query(`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES ($1, $2, $3, $4, $5)`, [
					newTenantId,
					row.from_id,
					row.to_id,
					row.type,
					row.created_at
				]);
			}

			for (const row of handoffRows.rows) {
				await client.query(
					`INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[newTenantId, row.id, row.entity_id, row.initiative_id, row.summary, row.body, row.created_at]
				);
			}

			for (const row of contextTermRows.rows) {
				await client.query(
					`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[newTenantId, row.context_key, row.term, row.definition, row.avoid_terms, row.created_at, row.updated_at]
				);
			}

			for (const row of historyRows.rows) {
				await client.query(
					`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
					[
						row.id,
						newTenantId,
						row.entity_id,
						row.version,
						row.author,
						row.title,
						row.body,
						row.body_source,
						row.status,
						row.parent_id,
						row.created_at
					]
				);
			}

			for (const row of counterRows.rows) {
				await client.query(`INSERT INTO counters (tenant_id, kind, next_value) VALUES ($1, $2, $3)`, [
					newTenantId,
					row.kind,
					row.next_value
				]);
			}

			await setSessionTenant(client, previousTenantId);
			await client.query(`DELETE FROM handoffs WHERE tenant_id = $1`, [previousTenantId]);
			await client.query(`DELETE FROM context_terms WHERE tenant_id = $1`, [previousTenantId]);
			await client.query(`DELETE FROM relations WHERE tenant_id = $1`, [previousTenantId]);
			await client.query(`DELETE FROM contexts WHERE tenant_id = $1`, [previousTenantId]);
			await client.query(`DELETE FROM entities WHERE tenant_id = $1`, [previousTenantId]);
			await client.query(`DELETE FROM counters WHERE tenant_id = $1`, [previousTenantId]);

			return {
				counters,
				counts,
				newDisplayName: formatTenantDisplayName(newTenantId),
				newTenantId,
				previousDisplayName: formatTenantDisplayName(previousTenantId),
				previousTenantId,
				renamed: true
			};
		});
	}

	public async close(): Promise<void> {
		await this.pool.end();
	}
}

export function openPgStore(pool: Pool, tenantId: string): PgStore {
	return new PgStore(pool, tenantId);
}
