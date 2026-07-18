import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

const TENANT_SCOPED_TABLES = ["counters", "entities", "relations", "contexts", "context_terms", "history_entries"] as const;

/**
 * Enables Postgres row-level security as defense-in-depth on every
 * tenant-scoped table (ADR9), ported from drizzle-kit's
 * `0001_enable-rls-policies.sql`. `metadata` carries no `tenant_id` and is
 * intentionally excluded. `ENABLE`/`FORCE ROW LEVEL SECURITY` are already
 * idempotent in Postgres; `CREATE POLICY` is not, so this module checks
 * `pg_policies` first and only creates the policy where it is missing. Stays
 * api-only (Postgres RLS has no SQLite equivalent) but is still authored
 * against the shared `MigrationConn`/`sql` mechanism (ISS174) for
 * consistency with every other migration module.
 */
export const enableRlsPoliciesMigration: Migration = {
	id: "0001-enable-rls-policies",
	up: async (conn) => {
		for (const table of TENANT_SCOPED_TABLES) {
			await conn.run(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
			await conn.run(sql.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));

			const existingPolicy = await conn.all(
				sql`SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = ${table} AND policyname = 'tenant_isolation'`
			);
			if (existingPolicy.length === 0) {
				await conn.run(
					sql.raw(`
						CREATE POLICY tenant_isolation ON ${table}
						USING (tenant_id = current_setting('app.tenant_id', true))
						WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
					`)
				);
			}
		}
	}
};
