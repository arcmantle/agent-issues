import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const renameRevisionEntriesMigration: Migration = {
	id: "0028-rename-revision-entries",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("Revision entries rename migration requires the SQLite dialect.");
		}
		// Guard: if the old table is absent the rename either already ran or was
		// never needed on this database instance (e.g. test isolation setups that
		// skip historical migration content) — skip safely.
		const oldTable = await conn.all<{ name: string }>(
			sql`SELECT name FROM sqlite_master WHERE type='table' AND name='revision_patch_entries'`
		);
		if (oldTable.length === 0) {
			return;
		}
		// Drop the named indexes before renaming so we can re-create them with
		// new names pointing at the new table name. The inline UNIQUE constraint
		// stays embedded in the table and continues to enforce the chain uniqueness.
		await conn.run(sql`DROP INDEX IF EXISTS revision_patch_entries_project_idx`);
		await conn.run(sql`DROP INDEX IF EXISTS revision_patch_entries_chain_idx`);
		await conn.run(sql`ALTER TABLE revision_patch_entries RENAME TO revision_entries`);
		await conn.run(sql`CREATE INDEX revision_entries_project_idx ON revision_entries (tenant_id, project_id)`);
		await conn.run(sql`CREATE UNIQUE INDEX revision_entries_chain_idx ON revision_entries (tenant_id, project_id, record_kind, record_key, revision)`);
	}
};
