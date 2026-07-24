import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

import { encodeRevisionPatchHash } from "../db/revision-patch-hash.js";

type RevisionPatchHashRow = {
	id: string;
	source_hash: string | Uint8Array;
	target_hash: string | Uint8Array;
};

function normalizeHash(hash: string | Uint8Array): Buffer {
	if (typeof hash === "string") {
		return encodeRevisionPatchHash(hash);
	}
	if (hash.byteLength !== 32) {
		throw new Error("Stored revision patch hash must contain exactly 32 bytes.");
	}
	return Buffer.from(hash);
}

export const binaryRevisionPatchHashesMigration: Migration = {
	id: "0022-binary-revision-patch-hashes",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite binary revision patch hash migration requires the SQLite dialect.");
		}
		const rows = await conn.all<RevisionPatchHashRow>(sql`SELECT id, source_hash, target_hash FROM revision_patch_entries`);
		await conn.run(sql`CREATE TABLE revision_patch_entries_binary (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			record_kind TEXT NOT NULL CHECK (record_kind IN ('entity', 'context', 'context-term')),
			record_key TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			author TEXT NOT NULL,
			patch_format INTEGER NOT NULL CHECK (patch_format > 0),
			reverse_patch BLOB NOT NULL,
			source_hash BLOB NOT NULL CHECK (typeof(source_hash) = 'blob' AND length(source_hash) = 32),
			target_hash BLOB NOT NULL CHECK (typeof(target_hash) = 'blob' AND length(target_hash) = 32),
			restored_from_revision INTEGER,
			created_at TEXT NOT NULL,
			UNIQUE (tenant_id, project_id, record_kind, record_key, revision)
		)`);
		for (const row of rows) {
			await conn.run(sql`INSERT INTO revision_patch_entries_binary
				SELECT id, tenant_id, project_id, record_kind, record_key, revision, author,
					patch_format, reverse_patch, ${normalizeHash(row.source_hash)}, ${normalizeHash(row.target_hash)}, restored_from_revision, created_at
				FROM revision_patch_entries WHERE id = ${row.id}`);
		}
		await conn.run(sql`DROP TABLE revision_patch_entries`);
		await conn.run(sql`ALTER TABLE revision_patch_entries_binary RENAME TO revision_patch_entries`);
		await conn.run(sql`CREATE INDEX revision_patch_entries_project_idx ON revision_patch_entries (tenant_id, project_id)`);
		await conn.run(sql`CREATE INDEX revision_patch_entries_chain_idx ON revision_patch_entries (tenant_id, project_id, record_kind, record_key, revision)`);
	}
};