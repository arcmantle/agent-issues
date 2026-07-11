import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../migration-runner.js";
import { migrations as coreMigrations } from "./index.js";
import { backfillTenantCountersMigration } from "./0004-backfill-tenant-counters.js";

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

function seedEntity(db: Database.Database, tenantId: string, id: string): void {
	db.prepare(
		`INSERT INTO entities (tenant_id, id, kind, title, status, created_at, updated_at)
		 VALUES (?, ?, 'issue', 'Seed', 'todo', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
	).run(tenantId, id);
}

describe("backfillTenantCountersMigration", () => {
	it("seeds missing counter rows for every tenant present in the database, not only one", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1");
		seedEntity(db, "tenant-b", "ISS1");

		await runMigrations(db, [backfillTenantCountersMigration]);

		const counterKinds = db.prepare(`SELECT tenant_id, kind FROM counters ORDER BY tenant_id, kind`).all() as Array<{
			tenant_id: string;
			kind: string;
		}>;
		const tenantIdsWithCounters = new Set(counterKinds.map((row) => row.tenant_id));
		expect(tenantIdsWithCounters).toEqual(new Set(["tenant-a", "tenant-b"]));
	});

	it("does not reset an already-advanced counter for a tenant that already had one", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1");
		db.prepare(
			`INSERT INTO counters (tenant_id, kind, next_value) VALUES ('tenant-a', 'issue', 42)`
		).run();

		await runMigrations(db, [backfillTenantCountersMigration]);

		const counter = db.prepare(`SELECT next_value FROM counters WHERE tenant_id = 'tenant-a' AND kind = 'issue'`).get() as {
			next_value: number;
		};
		expect(counter.next_value).toBe(42);
	});

	it("does not backfill any additional counter kinds for a tenant that exists only as counters debris (ISS177)", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1");
		// A counters-only "ghost" tenant with no rows in entities/relations/
		// contexts/context_terms/handoffs/history_entries - the kind of debris
		// an incomplete deleteTenant or a never-used workspace can leave behind.
		db.prepare(`INSERT INTO counters (tenant_id, kind, next_value) VALUES ('ghost-tenant', 'issue', 1)`).run();

		await runMigrations(db, [backfillTenantCountersMigration]);

		const ghostCounters = db.prepare(`SELECT kind FROM counters WHERE tenant_id = 'ghost-tenant'`).all() as Array<{ kind: string }>;
		expect(ghostCounters).toEqual([{ kind: "issue" }]);
	});
});
