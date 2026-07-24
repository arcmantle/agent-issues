import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const binaryRevisionPatchHashesMigration: Migration = {
	id: "0015-binary-revision-patch-hashes",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("PostgreSQL binary revision patch hash migration requires the PostgreSQL dialect.");
		}
		await conn.run(sql`ALTER TABLE revision_patch_entries
			ALTER COLUMN source_hash TYPE BYTEA USING decode(source_hash, 'hex'),
			ALTER COLUMN target_hash TYPE BYTEA USING decode(target_hash, 'hex')`);
		await conn.run(sql`ALTER TABLE revision_patch_entries
			ADD CONSTRAINT revision_patch_entries_source_hash_length CHECK (octet_length(source_hash) = 32),
			ADD CONSTRAINT revision_patch_entries_target_hash_length CHECK (octet_length(target_hash) = 32)`);
	}
};