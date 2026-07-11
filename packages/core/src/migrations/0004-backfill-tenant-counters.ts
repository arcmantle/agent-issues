import { sql } from "drizzle-orm";

import { ENTITY_KINDS } from "../domain.js";
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

/**
 * One-time, all-tenants sweep that retroactively seeds missing counter rows
 * for every tenant already present in the database file, not only whichever
 * tenant happens to be open (ADR43) — fixing the historical gap left by
 * `ensureTenantCounters` only ever running for the current tenant.
 */
export const backfillTenantCountersMigration: Migration = {
	id: "0004-backfill-tenant-counters",
	up: async (conn) => {
		for (const tenantId of await listDistinctTenantIds(conn)) {
			await ensureTenantCountersForTenant(conn, tenantId);
		}
	}
};
