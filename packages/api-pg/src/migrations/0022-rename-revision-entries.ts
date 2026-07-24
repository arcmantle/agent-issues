import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const renameRevisionEntriesMigration: Migration = {
	id: "0022-rename-revision-entries",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Revision entries rename migration requires the PostgreSQL dialect.");
		}
		// Guard: if the old table is absent the rename either already ran or was
		// never needed on this database instance — skip safely.
		const oldTable = await conn.all<{ to_regclass: string | null }>(sql`SELECT to_regclass('revision_patch_entries') AS to_regclass`);
		if (oldTable[0]?.to_regclass === null) {
			return;
		}
		// Rename the table; RLS policies remain attached to it.
		await conn.run(sql`ALTER TABLE revision_patch_entries RENAME TO revision_entries`);
		// Renaming the primary-key constraint also renames its backing index.
		await conn.run(sql`ALTER TABLE revision_entries RENAME CONSTRAINT revision_patch_entries_pkey TO revision_entries_pkey`);
		// Rename the non-unique project index.
		await conn.run(sql`ALTER INDEX revision_patch_entries_project_idx RENAME TO revision_entries_project_idx`);
		// Renaming the unique constraint also renames its backing index.
		await conn.run(
			sql`ALTER TABLE revision_entries RENAME CONSTRAINT revision_patch_entries_chain_idx TO revision_entries_chain_idx`
		);
		// Rename the two hash-length check constraints added by 0015 (pure check
		// constraints — no backing index, only pg_constraint name changes).
		await conn.run(
			sql`ALTER TABLE revision_entries RENAME CONSTRAINT revision_patch_entries_source_hash_length TO revision_entries_source_hash_length`
		);
		await conn.run(
			sql`ALTER TABLE revision_entries RENAME CONSTRAINT revision_patch_entries_target_hash_length TO revision_entries_target_hash_length`
		);
		await conn.run(
			sql`ALTER TABLE revision_entries RENAME CONSTRAINT revision_patch_entries_record_kind_check TO revision_entries_record_kind_check`
		);
		await conn.run(
			sql`ALTER TABLE revision_entries RENAME CONSTRAINT revision_patch_entries_revision_check TO revision_entries_revision_check`
		);
		await conn.run(
			sql`ALTER TABLE revision_entries RENAME CONSTRAINT revision_patch_entries_patch_format_check TO revision_entries_patch_format_check`
		);
	}
};
