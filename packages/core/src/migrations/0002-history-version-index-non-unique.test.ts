import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { historyEntriesMigration } from "./0001-history-entries.js";
import { historyVersionIndexNonUniqueMigration } from "./0002-history-version-index-non-unique.js";

describe("historyVersionIndexNonUniqueMigration", () => {
	it("leaves history_entries queryable by tenant/entity/version after running on top of 0001", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, [baselineV7Migration, historyEntriesMigration, historyVersionIndexNonUniqueMigration]);

		const index = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'history_entries_tenant_entity_version_idx'`)
			.get() as { sql: string };
		expect(index.sql).not.toContain("UNIQUE");

		const applied = db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all();
		expect(applied).toEqual([
			{ id: "0000-baseline-v7" },
			{ id: "0001-history-entries" },
			{ id: "0002-history-version-index-non-unique" }
		]);
	});
});
