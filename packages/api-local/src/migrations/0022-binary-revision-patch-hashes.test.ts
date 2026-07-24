import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { binaryRevisionPatchHashesMigration } from "./0022-binary-revision-patch-hashes.js";

const databases: Database.Database[] = [];

function createFixture(): Database.Database {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(`CREATE TABLE revision_patch_entries (
		id TEXT PRIMARY KEY NOT NULL,
		tenant_id TEXT NOT NULL,
		project_id TEXT NOT NULL,
		record_kind TEXT NOT NULL,
		record_key TEXT NOT NULL,
		revision INTEGER NOT NULL,
		author TEXT NOT NULL,
		patch_format INTEGER NOT NULL,
		reverse_patch BLOB NOT NULL,
		source_hash TEXT NOT NULL,
		target_hash TEXT NOT NULL,
		restored_from_revision INTEGER,
		created_at TEXT NOT NULL
	)`);
	return db;
}

afterEach(() => {
	for (const db of databases.splice(0)) {
		db.close();
	}
});

describe("binary revision patch hash migration", () => {
	it("converts hexadecimal text losslessly and enforces 32-byte blobs", async () => {
		const db = createFixture();
		const sourceHash = "0123456789abcdef".repeat(4);
		const targetHash = "fedcba9876543210".repeat(4);
		db.prepare(`INSERT INTO revision_patch_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			"patch-1", "tenant-a", "PROJ1", "entity", "4:ISS1", 2, "alice", 1,
			Buffer.from([0, 1, 255]), sourceHash, targetHash, null, "2026-07-20T10:00:00.000Z"
		);

		await runMigrations(db, [binaryRevisionPatchHashesMigration]);

		expect(db.prepare(`SELECT typeof(source_hash) AS source_type, length(source_hash) AS source_length,
			hex(source_hash) AS source_hex, typeof(target_hash) AS target_type, length(target_hash) AS target_length,
			hex(target_hash) AS target_hex FROM revision_patch_entries`).get()).toEqual({
			source_type: "blob",
			source_length: 32,
			source_hex: sourceHash.toUpperCase(),
			target_type: "blob",
			target_length: 32,
			target_hex: targetHash.toUpperCase()
		});
		expect(() => db.prepare(`UPDATE revision_patch_entries SET source_hash = ? WHERE id = ?`).run(Buffer.alloc(31), "patch-1")).toThrow();
	});
});