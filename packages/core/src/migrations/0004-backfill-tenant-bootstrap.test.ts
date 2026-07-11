import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../migration-runner.js";
import { migrations as coreMigrations } from "./index.js";
import { backfillTenantBootstrapMigration } from "./0004-backfill-tenant-bootstrap.js";

const dbs: Database.Database[] = [];

afterEach(() => {
	for (const db of dbs.splice(0)) {
		db.close();
	}
});

// Only the schema-establishing migration, not the bootstrap backfill itself
// (0004) - a test seeding data and then explicitly running the migration
// under test needs it to still be unapplied.
const schemaMigrations = coreMigrations.slice(0, 1);

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

describe("backfillTenantBootstrapMigration", () => {
	it("seeds missing counter rows for every tenant present in the database, not only one", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "issue", "Something");
		seedEntity(db, "tenant-b", "ISS1", "issue", "Something else");

		await runMigrations(db, [backfillTenantBootstrapMigration]);

		const counterKinds = db.prepare(`SELECT tenant_id, kind FROM counters ORDER BY tenant_id, kind`).all() as Array<{
			tenant_id: string;
			kind: string;
		}>;
		const tenantIdsWithCounters = new Set(counterKinds.map((row) => row.tenant_id));
		expect(tenantIdsWithCounters).toEqual(new Set(["tenant-a", "tenant-b"]));
	});

	it("does not reset an already-advanced counter for a tenant that already had one", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "issue", "Something");
		db.prepare(`INSERT INTO counters (tenant_id, kind, next_value) VALUES ('tenant-a', 'issue', 42)`).run();

		await runMigrations(db, [backfillTenantBootstrapMigration]);

		const counter = db.prepare(`SELECT next_value FROM counters WHERE tenant_id = 'tenant-a' AND kind = 'issue'`).get() as {
			next_value: number;
		};
		expect(counter.next_value).toBe(42);
	});

	it("creates the PROJ0/EPIC0 sentinels for every tenant present in the database, not only one", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "issue", "Something");
		seedEntity(db, "tenant-b", "ISS1", "issue", "Something else");

		await runMigrations(db, [backfillTenantBootstrapMigration]);

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

		await runMigrations(db, [backfillTenantBootstrapMigration]);

		const relation = db
			.prepare(`SELECT from_id, to_id, type FROM relations WHERE tenant_id = 'tenant-a' AND to_id = 'INIT1'`)
			.get() as { from_id: string; to_id: string; type: string } | undefined;
		expect(relation).toEqual({ from_id: "EPIC0", to_id: "INIT1", type: "contains" });
	});

	it("backfills a version-1 history entry for every historyless entity, across every tenant", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "issue", "Predates history (a)");
		seedEntity(db, "tenant-b", "ISS1", "issue", "Predates history (b)");

		await runMigrations(db, [backfillTenantBootstrapMigration]);

		for (const tenantId of ["tenant-a", "tenant-b"]) {
			const history = db
				.prepare(`SELECT entity_id, version, title FROM history_entries WHERE tenant_id = ?`)
				.all(tenantId) as Array<{ entity_id: string; version: number; title: string }>;
			expect(history.map((row) => row.entity_id)).toEqual(expect.arrayContaining(["ISS1", "PROJ0", "EPIC0"]));
			expect(history.every((row) => row.version === 1)).toBe(true);
		}
	});

	it("does not add a second history entry for an entity that already has one", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "issue", "Already has history");
		db.prepare(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			 VALUES ('existing-history-id', 'tenant-a', 'ISS1', 1, 'someone', 'Already has history', '', 'authored', 'todo', NULL, '2024-01-01T00:00:00.000Z')`
		).run();

		await runMigrations(db, [backfillTenantBootstrapMigration]);

		const history = db.prepare(`SELECT id FROM history_entries WHERE tenant_id = 'tenant-a' AND entity_id = 'ISS1'`).all();
		expect(history).toEqual([{ id: "existing-history-id" }]);
	});

	it("leaves a tenant that exists only as counters debris entirely untouched (ISS177)", async () => {
		const db = await freshDatabase();
		seedEntity(db, "tenant-a", "ISS1", "issue", "Something");
		// A counters-only "ghost" tenant with no rows in entities/relations/
		// contexts/context_terms/handoffs/history_entries - the kind of debris
		// an incomplete deleteTenant or a never-used workspace can leave behind.
		db.prepare(`INSERT INTO counters (tenant_id, kind, next_value) VALUES ('ghost-tenant', 'issue', 1)`).run();

		await runMigrations(db, [backfillTenantBootstrapMigration]);

		const ghostEntities = db.prepare(`SELECT id FROM entities WHERE tenant_id = 'ghost-tenant'`).all();
		expect(ghostEntities).toEqual([]);

		const ghostCounters = db.prepare(`SELECT kind FROM counters WHERE tenant_id = 'ghost-tenant'`).all() as Array<{ kind: string }>;
		expect(ghostCounters).toEqual([{ kind: "issue" }]);

		const ghostHistory = db.prepare(`SELECT id FROM history_entries WHERE tenant_id = 'ghost-tenant'`).all();
		expect(ghostHistory).toEqual([]);
	});
});
