import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "./index.js";

const databases: Database.Database[] = [];
const renameMigrationIndex = migrations.findIndex((migration) => migration.id === "0028-rename-revision-entries");
const migrationsBeforeRename = migrations.slice(0, renameMigrationIndex);
const migrationsThroughRename = migrations.slice(0, renameMigrationIndex + 1);

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

describe("revision-entries rename (SQLite 0028)", () => {
	it("renames revision_patch_entries to revision_entries preserving all rows", async () => {
		const database = new Database(":memory:");
		databases.push(database);

		// Run all migrations up to (but not including) the rename.
		await runMigrations(database, migrationsBeforeRename);

		// Seed a test row into revision_patch_entries
		const reverseBytes = Buffer.from([0x01, 0x02]);
		const sourceHash = Buffer.alloc(32, 0x01);
		const targetHash = Buffer.alloc(32, 0x02);
		database
			.prepare(
				`INSERT INTO revision_patch_entries
					(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format,
					 reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run("row-1", "tenant-a", "00000000-0000-0000-0000-000000000001", "entity", "4:ISS1", 1, "tester", 1, reverseBytes, sourceHash, targetHash, null, "2026-01-01T00:00:00.000Z");

		const rowsBefore = database.prepare("SELECT * FROM revision_patch_entries ORDER BY id").all();
		expect(rowsBefore).toHaveLength(1);

		// Apply the rename while the legacy history table still exists.
		await runMigrations(database, migrationsThroughRename);

		// Old table must be absent
		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revision_patch_entries'").get()
		).toBeUndefined();

		// New table must be present
		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revision_entries'").get()
		).toBeDefined();

		// Row-for-row equality
		const rowsAfter = database.prepare("SELECT * FROM revision_entries ORDER BY id").all();
		expect(rowsAfter).toEqual(rowsBefore);

		// New index names present
		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='revision_entries_project_idx'").get()
		).toBeDefined();
		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='revision_entries_chain_idx'").get()
		).toBeDefined();
		expect(database.prepare("PRAGMA index_list(revision_entries)").all()).toContainEqual(
			expect.objectContaining({ name: "revision_entries_chain_idx", unique: 1 })
		);

		// Old index names absent
		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='revision_patch_entries_project_idx'").get()
		).toBeUndefined();
		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='revision_patch_entries_chain_idx'").get()
		).toBeUndefined();

		// Migration recorded in ledger
		expect(database.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("0028-rename-revision-entries")).toEqual({
			id: "0028-rename-revision-entries"
		});
	});

	it("migrates successfully when revision_patch_entries has no rows", async () => {
		const database = new Database(":memory:");
		databases.push(database);

		await runMigrations(database, migrationsBeforeRename);
		await runMigrations(database, migrationsThroughRename);

		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revision_patch_entries'").get()
		).toBeUndefined();
		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revision_entries'").get()
		).toBeDefined();
	});

	it("is idempotent when run twice", async () => {
		const database = new Database(":memory:");
		databases.push(database);

		await runMigrations(database, migrations);
		await runMigrations(database, migrations);

		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revision_entries'").get()
		).toBeDefined();
		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revision_patch_entries'").get()
		).toBeUndefined();
	});
});
