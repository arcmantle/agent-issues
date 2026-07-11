import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrations as coreMigrations } from "./index.js";
import { runMigrations } from "../migration-runner.js";
import { backfillFullChainInvariantMigration } from "./0005-backfill-full-chain-invariant.js";

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

function seedEntity(db: Database.Database, tenantId: string, id: string, kind: string, title: string): void {
	db.prepare(
		`INSERT INTO entities (tenant_id, id, kind, title, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'todo', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
	).run(tenantId, id, kind, title);
}

describe("backfillFullChainInvariantMigration", () => {
	it("creates the PROJ0/EPIC0 sentinels for every tenant present in the database, not only one", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "issue", "Something");
		seedEntity(db, "tenant-b", "ISS1", "issue", "Something else");

		await runMigrations(db, [backfillFullChainInvariantMigration]);

		for (const tenantId of ["tenant-a", "tenant-b"]) {
			const project = db.prepare(`SELECT id FROM entities WHERE tenant_id = ? AND id = 'PROJ0'`).get(tenantId);
			const epic = db.prepare(`SELECT id FROM entities WHERE tenant_id = ? AND id = 'EPIC0'`).get(tenantId);
			expect(project).toBeTruthy();
			expect(epic).toBeTruthy();
		}
	});

	it("attaches an orphan initiative (no pre-existing parent) to EPIC0, for every tenant", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "INIT1", "initiative", "Orphan initiative");

		await runMigrations(db, [backfillFullChainInvariantMigration]);

		const relation = db
			.prepare(`SELECT from_id, to_id, type FROM relations WHERE tenant_id = 'tenant-a' AND to_id = 'INIT1'`)
			.get() as { from_id: string; to_id: string; type: string } | undefined;
		expect(relation).toEqual({ from_id: "EPIC0", to_id: "INIT1", type: "contains" });
	});

	it("does not manufacture a PROJ0/EPIC0 sentinel pair for a tenant that exists only as counters debris (ISS177)", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "issue", "Something");
		// A counters-only "ghost" tenant with no rows in entities/relations/
		// contexts/context_terms/handoffs/history_entries - the kind of debris
		// an incomplete deleteTenant or a never-used workspace can leave behind.
		db.prepare(`INSERT INTO counters (tenant_id, kind, next_value) VALUES ('ghost-tenant', 'issue', 1)`).run();

		await runMigrations(db, [backfillFullChainInvariantMigration]);

		const ghostEntities = db.prepare(`SELECT id FROM entities WHERE tenant_id = 'ghost-tenant'`).all();
		expect(ghostEntities).toEqual([]);
	});
});
