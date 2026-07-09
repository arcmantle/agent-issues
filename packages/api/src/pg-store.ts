import { randomUUID } from "node:crypto";

import {
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	deriveEntityStatuses,
	ENTITY_KINDS,
	getAllowedRelationType,
	getInitialStatus,
	isBodySource,
	isEntityKind,
	isStructuralRelationType,
	isValidStatus,
	RESERVED_SYSTEM_AUTHOR,
	ID_PREFIX,
	type BodySource,
	type EntityKind,
	type EntityRecord,
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

export type EntityDetails = {
	entity: EntityRecord;
	incoming: Array<{ relationType: RelationType; entity: EntityRecord }>;
	outgoing: Array<{ relationType: RelationType; entity: EntityRecord }>;
};

export type LinkResult = {
	relation: RelationRecord;
	created: boolean;
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

/**
 * Postgres implementation of the entity-lifecycle slice of the
 * storage-driver seam (ADR11, ADR13, ISS39). Every method opens exactly one
 * `withTenantTransaction` (ADR9's `SET LOCAL app.tenant_id`), so RLS is
 * always active for the query.
 *
 * This is a partial implementation: it does not yet `implements
 * StorageDriver` because the handoff, context, and tenant-administration
 * sections of that seam are unimplemented here (tracked as ISS39 follow-up
 * work), as is the JSON-RPC gate and change/event stream ISS39 also calls
 * for. Entity-lifecycle write-guard rules that depend on cross-entity
 * queries (e.g. "a userStory's status is derived from its fixing issues")
 * are likewise not yet ported - `updateEntityStatus` here only performs the
 * unconditional write core's `SqliteStore` does after its guards pass.
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

	public async close(): Promise<void> {
		await this.pool.end();
	}
}

export function openPgStore(pool: Pool, tenantId: string): PgStore {
	return new PgStore(pool, tenantId);
}
