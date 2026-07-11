import { sql } from "drizzle-orm";

import { DEFAULT_EPIC_ID, DEFAULT_EPIC_TITLE, DEFAULT_PROJECT_ID, DEFAULT_PROJECT_TITLE } from "../domain.js";
import type { Migration, MigrationConn } from "../migration-engine.js";

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
		UNION SELECT tenant_id FROM handoffs
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
 * One-time, all-tenants sweep that retroactively synthesizes the
 * PROJ0/EPIC0 sentinels (ADR7's "full-chain invariant") for every tenant
 * already present in the database file, not only whichever tenant happens
 * to be open (ADR43) — fixing the historical gap left by
 * `ensureFullChainInvariant` only ever running for the current tenant. The
 * runner's own pre-migration file backup (when `dbPath` is supplied to
 * `runMigrations`) covers ADR13/ADR20's backup guarantee generically here,
 * replacing this migration's need for its own `backupDatabaseFile` call.
 */
export const backfillFullChainInvariantMigration: Migration = {
	id: "0005-backfill-full-chain-invariant",
	up: async (conn) => {
		for (const tenantId of await listDistinctTenantIds(conn)) {
			await ensureFullChainInvariantForTenant(conn, tenantId);
		}
	}
};
