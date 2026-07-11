import { sql } from "drizzle-orm";

import type { Migration } from "../migration-engine.js";

/**
 * Adds the `project_migrations` table (ISS63's tenant-to-project
 * consolidation ledger), ported from drizzle-kit's
 * `0003_project_migrations.sql`. Only the table shape is ported here; the
 * consolidation logic that writes to it (`consolidateAllLegacyTenants`)
 * is folded into the ADR43 runner separately.
 */
export const projectMigrationsMigration: Migration = {
	id: "0003-project-migrations",
	up: async (conn) => {
		await conn.run(sql`
			CREATE TABLE IF NOT EXISTS project_migrations (
				tenant_id TEXT NOT NULL,
				legacy_tenant_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (tenant_id, legacy_tenant_id)
			)
		`);
	}
};
