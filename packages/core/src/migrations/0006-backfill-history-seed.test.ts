import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrations as coreMigrations } from "./index.js";
import { runMigrations } from "../migration-runner.js";
import { backfillHistorySeedMigration } from "./0006-backfill-history-seed.js";

const dbs: Database.Database[] = [];

afterEach(() => {
	for (const db of dbs.splice(0)) {
		db.close();
	}
});

// Only the schema-establishing migrations, not the bootstrap backfills
// (0004-0006) themselves - a test seeding data and then explicitly running
// the migration under test needs it to still be unapplied.
const schemaMigrations = coreMigrations.slice(0, 4);

async function freshDatabase(): Promise<Database.Database> {
	const db = new Database(":memory:");
	dbs.push(db);
	await runMigrations(db, schemaMigrations);
	return db;
}

function seedEntity(db: Database.Database, tenantId: string, id: string, title: string): void {
	db.prepare(
		`INSERT INTO entities (tenant_id, id, kind, title, status, created_at, updated_at)
		 VALUES (?, ?, 'issue', ?, 'todo', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
	).run(tenantId, id, title);
}

describe("backfillHistorySeedMigration", () => {
	it("backfills a version-1 history entry for every historyless entity, across every tenant", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "Predates history (a)");
		seedEntity(db, "tenant-b", "ISS1", "Predates history (b)");

		await runMigrations(db, [backfillHistorySeedMigration]);

		for (const tenantId of ["tenant-a", "tenant-b"]) {
			const history = db
				.prepare(`SELECT entity_id, version, title FROM history_entries WHERE tenant_id = ?`)
				.all(tenantId) as Array<{ entity_id: string; version: number; title: string }>;
			expect(history).toHaveLength(1);
			expect(history[0]).toMatchObject({ entity_id: "ISS1", version: 1 });
		}
	});

	it("does not add a second history entry for an entity that already has one", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "Already has history");
		db.prepare(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			 VALUES ('existing-history-id', 'tenant-a', 'ISS1', 1, 'someone', 'Already has history', '', 'authored', 'todo', NULL, '2024-01-01T00:00:00.000Z')`
		).run();

		await runMigrations(db, [backfillHistorySeedMigration]);

		const history = db.prepare(`SELECT id FROM history_entries WHERE tenant_id = 'tenant-a' AND entity_id = 'ISS1'`).all();
		expect(history).toEqual([{ id: "existing-history-id" }]);
	});
});
