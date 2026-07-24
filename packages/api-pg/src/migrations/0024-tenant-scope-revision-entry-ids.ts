import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const tenantScopeRevisionEntryIdsMigration: Migration = {
	id: "0024-tenant-scope-revision-entry-ids",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Tenant-scoped revision entry ids migration requires the PostgreSQL dialect.");
		}
		await conn.run(sql`ALTER TABLE revision_entries DROP CONSTRAINT IF EXISTS revision_entries_pkey`);
		await conn.run(sql`ALTER TABLE revision_entries DROP CONSTRAINT IF EXISTS revision_patch_entries_pkey`);
		await conn.run(sql`ALTER TABLE revision_entries ADD CONSTRAINT revision_entries_pkey PRIMARY KEY (tenant_id, id)`);
	}
};