import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { RESERVED_SYSTEM_AUTHOR, STRUCTURAL_RELATION_TYPES } from "../domain.js";
import type { Migration, MigrationConn } from "../migration-engine.js";

/**
 * Every distinct `tenant_id` with real content in this database - excludes
 * `counters`, since a counters row alone does not mean a tenant has any
 * real content: it can be pure debris left behind by an incomplete
 * `deleteTenant`, or a workspace opened once but never used (ISS177).
 * Mirrors `database.ts`'s `findUnmigratedLegacyTenantIds`, which already
 * gets this right. This migration only ever inserts history for entities
 * that already exist, so a counters-only ghost tenant was already a no-op
 * here in practice (nothing to seed) - excluded anyway for scope
 * consistency with the other two bootstrap-backfill migrations.
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
 * forward.
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
 * One-time, all-tenants sweep that retroactively backfills a version-1
 * history entry (ADR8) for every historyless entity, across every tenant
 * already present in the database file, not only whichever tenant happens
 * to be open (ADR43) — fixing the historical gap left by
 * `ensureHistorySeed` only ever running for the current tenant.
 */
export const backfillHistorySeedMigration: Migration = {
	id: "0006-backfill-history-seed",
	up: async (conn) => {
		for (const tenantId of await listDistinctTenantIds(conn)) {
			await ensureHistorySeedForTenant(conn, tenantId);
		}
	}
};
