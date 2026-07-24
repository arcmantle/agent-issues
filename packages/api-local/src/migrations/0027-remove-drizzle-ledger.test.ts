import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "./index.js";

const databases: Database.Database[] = [];

function markPreviousMigrationsApplied(database: Database.Database): void {
	database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		id TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`);
	const insertMigration = database.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)");
	// Mark everything before 0027-remove-drizzle-ledger as applied so 0027 (and
	// any later migrations) are the only ones that run during the test.
	const targetIdx = migrations.findIndex((m) => m.id === "0027-remove-drizzle-ledger");
	for (const migration of migrations.slice(0, targetIdx)) {
		insertMigration.run(migration.id, "2026-07-23T00:00:00.000Z");
	}
	for (const migration of migrations.slice(targetIdx + 1)) {
		insertMigration.run(migration.id, "2026-07-23T00:00:00.000Z");
	}
}

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

describe("drizzle-kit ledger cleanup", () => {
	it("removes a populated stale ledger without replacing schema_migrations", async () => {
		const database = new Database(":memory:");
		databases.push(database);
		markPreviousMigrationsApplied(database);
		database.exec(`
			INSERT INTO schema_migrations VALUES ('authoritative-sentinel', '2026-07-23T00:00:00.000Z');
			CREATE TABLE __drizzle_migrations (
				id INTEGER PRIMARY KEY,
				hash TEXT NOT NULL,
				created_at INTEGER
			);
			INSERT INTO __drizzle_migrations VALUES (1, 'obsolete', 1721692800000);
		`);

		await runMigrations(database, migrations);

		expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get()).toBeUndefined();
		expect(database.prepare("SELECT id, applied_at FROM schema_migrations WHERE id = ?").get("authoritative-sentinel")).toEqual({
			id: "authoritative-sentinel",
			applied_at: "2026-07-23T00:00:00.000Z"
		});
	});

	it("removes an empty stale ledger", async () => {
		const database = new Database(":memory:");
		databases.push(database);
		markPreviousMigrationsApplied(database);
		database.exec(`CREATE TABLE __drizzle_migrations (
			id INTEGER PRIMARY KEY,
			hash TEXT NOT NULL,
			created_at INTEGER
		)`);

		await runMigrations(database, migrations);

		expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get()).toBeUndefined();
	});

	it("migrates successfully when the stale ledger is absent", async () => {
		const database = new Database(":memory:");
		databases.push(database);

		await runMigrations(database, migrations);

		expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get()).toBeUndefined();
		expect(database.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("0027-remove-drizzle-ledger")).toEqual({
			id: "0027-remove-drizzle-ledger"
		});
	});
});