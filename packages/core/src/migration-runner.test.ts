import { sql } from "drizzle-orm";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Migration } from "./migration-runner.js";
import { runMigrations } from "./migration-runner.js";

describe("runMigrations", () => {
	it("applies an unapplied migration once and records it in the ledger", async () => {
		const db = new Database(":memory:");
		let runCount = 0;
		const migrations: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
					runCount += 1;
				}
			}
		];

		await runMigrations(db, migrations);
		await runMigrations(db, migrations);

		expect(runCount).toBe(1);
		expect(db.prepare("SELECT id FROM schema_migrations").all()).toEqual([{ id: "0001-create-widgets" }]);
	});

	it("applies only the new migrations, in order, when the module list grows", async () => {
		const db = new Database(":memory:");
		const applied: string[] = [];
		const firstBatch: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
					applied.push("0001-create-widgets");
				}
			}
		];

		await runMigrations(db, firstBatch);

		const secondBatch: Migration[] = [
			...firstBatch,
			{
				id: "0002-create-gadgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE gadgets (id TEXT PRIMARY KEY)`);
					applied.push("0002-create-gadgets");
				}
			}
		];

		await runMigrations(db, secondBatch);

		expect(applied).toEqual(["0001-create-widgets", "0002-create-gadgets"]);
		expect(db.prepare("SELECT id FROM schema_migrations ORDER BY id").all()).toEqual([
			{ id: "0001-create-widgets" },
			{ id: "0002-create-gadgets" }
		]);
	});

	it("rolls back a failing migration and leaves it unrecorded so it retries next run", async () => {
		const db = new Database(":memory:");
		const migrations: Migration[] = [
			{
				id: "0001-partial-failure",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
					await conn.run(sql`INSERT INTO widgets (id) VALUES ('w1')`);
					throw new Error("boom");
				}
			}
		];

		await expect(runMigrations(db, migrations)).rejects.toThrow("boom");

		expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'widgets'").get()).toBeUndefined();
		expect(db.prepare("SELECT id FROM schema_migrations").all()).toEqual([]);
	});

	it("backs up the database file before applying an unapplied migration", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-migration-runner-"));
		const dbPath = path.join(tempDir, "test.db");
		const db = new Database(dbPath);
		const migrations: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
				}
			}
		];

		try {
			await runMigrations(db, migrations, { dbPath });

			const backups = readdirSync(tempDir).filter((name) => name !== "test.db" && name.startsWith("test.db."));
			expect(backups).toHaveLength(1);
		} finally {
			db.close();
			rmSync(tempDir, { force: true, recursive: true });
		}
	});
});
