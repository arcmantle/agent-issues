import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { migrateHandoffsToEntitiesMigration } from "./0010-migrate-handoffs-to-entities.js";

const dbs: Database.Database[] = [];

afterEach(() => {
	for (const db of dbs.splice(0)) {
		db.close();
	}
});

describe("migrateHandoffsToEntitiesMigration (ISS204)", () => {
	it("converts legacy handoffs into timestamp-preserving graph entities and relations", async () => {
		const db = new Database(":memory:");
		dbs.push(db);
		await runMigrations(db, [baselineV7Migration]);
		db.exec("ALTER TABLE entities ADD COLUMN project_id TEXT");
		db.exec(`
			CREATE TABLE handoffs (
				tenant_id TEXT NOT NULL,
				id TEXT NOT NULL,
				entity_id TEXT NOT NULL,
				initiative_id TEXT,
				summary TEXT NOT NULL DEFAULT '',
				body TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (tenant_id, id)
			)
		`);
		db.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, project_id, created_at, updated_at)
			 VALUES ('test', 'INIT1', 'initiative', 'Migration', 'active', '', 'authored', 'PROJ1', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
			 VALUES ('test', 'HO4', 'INIT1', 'INIT1', '', 'Continue here.', '2024-02-03T04:05:06.000Z')`
		).run();

		await runMigrations(db, [migrateHandoffsToEntitiesMigration]);

		expect(
			db.prepare("SELECT id, kind, title, body, project_id, created_at, updated_at FROM entities WHERE tenant_id = 'test' AND id = 'HO4'").get()
		).toEqual({
			id: "HO4",
			kind: "handoff",
			title: "Handoff HO4",
			body: "Continue here.",
			project_id: "PROJ1",
			created_at: "2024-02-03T04:05:06.000Z",
			updated_at: "2024-02-03T04:05:06.000Z"
		});
		expect(
			db.prepare("SELECT from_id, to_id, type, created_at FROM relations WHERE tenant_id = 'test' AND from_id = 'HO4'").get()
		).toEqual({
			from_id: "HO4",
			to_id: "INIT1",
			type: "handsOff",
			created_at: "2024-02-03T04:05:06.000Z"
		});
		expect(
			db.prepare("SELECT entity_id, title, body, created_at FROM history_entries WHERE tenant_id = 'test' AND entity_id = 'HO4'").get()
		).toEqual({
			entity_id: "HO4",
			title: "Handoff HO4",
			body: "Continue here.",
			created_at: "2024-02-03T04:05:06.000Z"
		});
		expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'").get()).toBeUndefined();
	});
});