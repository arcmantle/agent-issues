import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { DatabaseHandle } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "./index.js";
import { removeMetadataMigration } from "./0031-remove-metadata.js";

const databases: Database.Database[] = [];
const removeMetadataIndex = migrations.findIndex((migration) => migration.id === removeMetadataMigration.id);
const migrationsBeforeMetadataRemoval = migrations.slice(0, removeMetadataIndex);

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

describe("metadata removal (SQLite 0031)", () => {
	it("removes legacy database metadata", async () => {
		const database = new Database(":memory:") as DatabaseHandle;
		databases.push(database);
		await runMigrations(database, migrationsBeforeMetadataRemoval);
		database.prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', '7')").run();

		await runMigrations(database, [removeMetadataMigration]);

		expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get()).toBeUndefined();
		expect(database.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(removeMetadataMigration.id)).toEqual({
			id: removeMetadataMigration.id
		});
	});
});