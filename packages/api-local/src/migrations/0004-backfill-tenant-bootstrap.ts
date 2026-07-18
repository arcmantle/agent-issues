import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	ENTITY_KINDS,
	RESERVED_SYSTEM_AUTHOR,
	STRUCTURAL_RELATION_TYPES,
	type Migration,
	type MigrationConn
} from "@agent-issues/core";

/**
 * Every distinct `tenant_id` with real content in this database - excludes
 * `counters`, since a counters row alone does not mean a tenant has any
 * real content: it can be pure debris left behind by an incomplete
 * `deleteTenant`, or a workspace opened once but never used (ISS177).
 * Mirrors `database.ts`'s `findUnmigratedLegacyTenantIds`, which already
 * gets this right.
 */
async function listDistinctTenantIds(conn: MigrationConn): Promise<string[]> {
	const rows = await conn.all<{ tenant_id: string }>(sql`
		SELECT tenant_id FROM entities
		UNION SELECT tenant_id FROM relations
		UNION SELECT tenant_id FROM contexts
		UNION SELECT tenant_id FROM context_terms
		UNION SELECT tenant_id FROM history_entries
		ORDER BY tenant_id
	`);

	return rows.map((row) => row.tenant_id);
}

async function insertSentinelEntity(
	conn: MigrationConn,
	tenantId: string,
	id: string,
	kind: string,
	title: string,
	now: string
): Promise<void> {
	await conn.run(sql`
		INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		VALUES (${tenantId}, ${id}, ${kind}, ${title}, 'active', '', 'generated', ${now}, ${now})
		ON CONFLICT (tenant_id, id) DO NOTHING
	`);
}

async function insertSentinelRelation(conn: MigrationConn, tenantId: string, fromId: string, toId: string, now: string): Promise<void> {
	await conn.run(sql`
		INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
		VALUES (${tenantId}, ${fromId}, ${toId}, 'contains', ${now})
		ON CONFLICT (tenant_id, from_id, to_id, type) DO NOTHING
	`);
}

async function attachOrphanInitiativesToDefaultEpic(conn: MigrationConn, tenantId: string, now: string): Promise<void> {
	const orphanInitiatives = await conn.all<{ id: string }>(sql`
		SELECT id FROM entities
		WHERE tenant_id = ${tenantId} AND kind = 'initiative'
		  AND id NOT IN (
		    SELECT to_id FROM relations WHERE tenant_id = ${tenantId} AND type = 'contains'
		  )
	`);

	for (const { id } of orphanInitiatives) {
		await insertSentinelRelation(conn, tenantId, DEFAULT_EPIC_ID, id, now);
	}
}

/**
 * Synthesizes the PROJ0/EPIC0 sentinels and attaches any parentless
 * initiative for one tenant. Mirrors `database.ts`'s
 * `ensureFullChainInvariant`, which does the same thing but only for
 * `db.tenantId` on every open — that ongoing, per-open bootstrap is
 * unaffected by this migration and keeps running unchanged for brand-new
 * tenants going forward.
 */
async function ensureFullChainInvariantForTenant(conn: MigrationConn, tenantId: string): Promise<void> {
	const now = new Date().toISOString();
	await insertSentinelEntity(conn, tenantId, DEFAULT_PROJECT_ID, "project", DEFAULT_PROJECT_TITLE, now);
	await insertSentinelEntity(conn, tenantId, DEFAULT_EPIC_ID, "epic", DEFAULT_EPIC_TITLE, now);
	await insertSentinelRelation(conn, tenantId, DEFAULT_PROJECT_ID, DEFAULT_EPIC_ID, now);
	await attachOrphanInitiativesToDefaultEpic(conn, tenantId, now);
}

/**
 * Seeds a missing per-kind counter row for one tenant. Mirrors
 * `database.ts`'s `ensureTenantCounters`, which does the same thing but only
 * for `db.tenantId` (the currently-open tenant) on every open — that
 * ongoing, per-open bootstrap is unaffected by this migration and keeps
 * running unchanged for brand-new tenants going forward.
 */
async function ensureTenantCountersForTenant(conn: MigrationConn, tenantId: string): Promise<void> {
	for (const kind of [...ENTITY_KINDS, "handoff"]) {
		await conn.run(sql`
			INSERT INTO counters (tenant_id, kind, next_value)
			VALUES (${tenantId}, ${kind}, 1)
			ON CONFLICT (tenant_id, kind) DO NOTHING
		`);
	}
}

// Structural relation types are a fixed, code-controlled constant (never
// user input), so inlining them into the SQL text below via `sql.raw` is
// safe and keeps this query automatically in sync with domain.ts's canonical
// list.
const STRUCTURAL_TYPES_SQL_LIST = STRUCTURAL_RELATION_TYPES.map((type) => `'${type}'`).join(", ");

type UnseededEntity = {
	id: string;
	title: string;
	body: string;
	body_source: string;
	status: string;
	updated_at: string;
};

/**
 * Backfills a synthetic version-1 history entry (ADR8) for every historyless
 * entity belonging to one tenant. Mirrors `database.ts`'s
 * `ensureHistorySeed`, which does the same thing but only for `db.tenantId`
 * on every open — that ongoing, per-open bootstrap is unaffected by this
 * migration and keeps running unchanged for brand-new tenants going
 * forward. Runs after `ensureFullChainInvariantForTenant` in the loop below
 * so the PROJ0/EPIC0 sentinels and any orphan-initiative attachment already
 * exist and get swept up as ordinary "entities lacking history" - no
 * special-casing needed.
 */
async function ensureHistorySeedForTenant(conn: MigrationConn, tenantId: string): Promise<void> {
	const unseeded = await conn.all<UnseededEntity>(sql`
		SELECT id, title, body, body_source, status, updated_at FROM entities
		WHERE tenant_id = ${tenantId}
		  AND id NOT IN (SELECT entity_id FROM history_entries WHERE tenant_id = ${tenantId})
	`);

	if (unseeded.length === 0) {
		return;
	}

	for (const entity of unseeded) {
		const parent = await conn.all<{ from_id: string }>(sql`
			SELECT from_id FROM relations
			WHERE tenant_id = ${tenantId} AND to_id = ${entity.id} AND type IN (${sql.raw(STRUCTURAL_TYPES_SQL_LIST)})
			LIMIT 1
		`);

		await conn.run(sql`
			INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			VALUES (${randomUUID()}, ${tenantId}, ${entity.id}, 1, ${RESERVED_SYSTEM_AUTHOR}, ${entity.title}, ${entity.body}, ${entity.body_source}, ${entity.status}, ${parent[0]?.from_id ?? null}, ${entity.updated_at})
		`);
	}
}

/**
 * One-time, all-tenants sweep that retroactively bootstraps every tenant
 * already present in the database file - not only whichever tenant happens
 * to be open - with the same three invariants `ensureDatabase` guarantees a
 * brand-new tenant on its first open: the PROJ0/EPIC0 full-chain sentinels
 * (ADR7), per-kind counter rows, and a version-1 history seed (ADR8) for
 * every historyless entity (ADR43).
 *
 * Originally three separate modules (0004-backfill-tenant-counters,
 * 0005-backfill-full-chain-invariant, 0006-backfill-history-seed) - merged
 * into one once it was confirmed all three are mutually idempotent,
 * order-independent across tenants, and were never split for a real
 * historical-fidelity reason (unlike 0000-0003, they were invented
 * wholesale by this project, not ported from a pre-existing drizzle-kit
 * file). Within one tenant, the three steps below still run in the same
 * order the per-open bootstrap trio in `database.ts` uses
 * (full-chain-invariant, then counters, then history-seed), since
 * history-seed depends on the sentinels/relations the full-chain-invariant
 * step creates.
 */
export const backfillTenantBootstrapMigration: Migration = {
	id: "0004-backfill-tenant-bootstrap",
	up: async (conn) => {
		for (const tenantId of await listDistinctTenantIds(conn)) {
			await ensureFullChainInvariantForTenant(conn, tenantId);
			await ensureTenantCountersForTenant(conn, tenantId);
			await ensureHistorySeedForTenant(conn, tenantId);
		}
	}
};
