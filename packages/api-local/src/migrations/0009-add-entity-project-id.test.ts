import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { addEntityProjectIdMigration } from "./0009-add-entity-project-id.js";

const dbs: Database.Database[] = [];

afterEach(() => {
	for (const db of dbs.splice(0)) {
		db.close();
	}
});

async function freshDatabase(): Promise<Database.Database> {
	const db = new Database(":memory:");
	dbs.push(db);
	await runMigrations(db, [baselineV7Migration]);
	return db;
}

function seedEntity(db: Database.Database, tenantId: string, id: string, kind: string): void {
	db.prepare(
		`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'active', '', 'authored', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
	).run(tenantId, id, kind, id);
}

function seedRelation(db: Database.Database, tenantId: string, fromId: string, toId: string, type: string): void {
	db.prepare(`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES (?, ?, ?, ?, '2024-01-01T00:00:00.000Z')`).run(
		tenantId,
		fromId,
		toId,
		type
	);
}

function projectIdOf(db: Database.Database, tenantId: string, id: string): string | null {
	const row = db.prepare(`SELECT project_id AS projectId FROM entities WHERE tenant_id = ? AND id = ?`).get(tenantId, id) as
		| { projectId: string | null }
		| undefined;
	return row?.projectId ?? null;
}

describe("addEntityProjectIdMigration (ISS166)", () => {
	it("adds a nullable project_id column to entities", async () => {
		const db = await freshDatabase();

		await runMigrations(db, [addEntityProjectIdMigration]);

		const columns = db.prepare(`PRAGMA table_info(entities)`).all() as Array<{ name: string; notnull: number }>;
		const projectIdColumn = columns.find((column) => column.name === "project_id");
		expect(projectIdColumn).toMatchObject({ notnull: 0 });
	});

	it("assigns each entity to the project it is structurally reachable from", async () => {
		const db = await freshDatabase();
		// First project's full structural subtree.
		seedEntity(db, "t", "PROJ0", "project");
		seedEntity(db, "t", "EPIC0", "epic");
		seedEntity(db, "t", "INIT1", "initiative");
		seedEntity(db, "t", "ISS1", "issue");
		seedRelation(db, "t", "PROJ0", "EPIC0", "contains");
		seedRelation(db, "t", "EPIC0", "INIT1", "contains");
		seedRelation(db, "t", "INIT1", "ISS1", "tracks");
		// A second project and its own subtree.
		seedEntity(db, "t", "PROJ1", "project");
		seedEntity(db, "t", "EPIC1", "epic");
		seedRelation(db, "t", "PROJ1", "EPIC1", "contains");
		// A structurally unattached orphan issue and parentless project ADR.
		seedEntity(db, "t", "ISS9", "issue");
		seedEntity(db, "t", "ADR1", "adr");

		await runMigrations(db, [addEntityProjectIdMigration]);

		expect(projectIdOf(db, "t", "PROJ0")).toBe("PROJ0");
		expect(projectIdOf(db, "t", "EPIC0")).toBe("PROJ0");
		expect(projectIdOf(db, "t", "INIT1")).toBe("PROJ0");
		expect(projectIdOf(db, "t", "ISS1")).toBe("PROJ0");
		expect(projectIdOf(db, "t", "PROJ1")).toBe("PROJ1");
		expect(projectIdOf(db, "t", "EPIC1")).toBe("PROJ1");
		// Leftovers fall back to the tenant's PROJ0 sentinel.
		expect(projectIdOf(db, "t", "ISS9")).toBe("PROJ0");
		expect(projectIdOf(db, "t", "ADR1")).toBe("PROJ0");
	});

	it("backfills each tenant independently", async () => {
		const db = await freshDatabase();
		seedEntity(db, "solo", "PROJ7", "project");
		seedEntity(db, "solo", "ISS7", "issue");
		seedEntity(db, "other", "PROJ0", "project");
		seedEntity(db, "other", "ISS0", "issue");

		await runMigrations(db, [addEntityProjectIdMigration]);

		// The sole project of a tenant with no PROJ0 catches its own leftovers.
		expect(projectIdOf(db, "solo", "ISS7")).toBe("PROJ7");
		expect(projectIdOf(db, "other", "ISS0")).toBe("PROJ0");
	});
});
