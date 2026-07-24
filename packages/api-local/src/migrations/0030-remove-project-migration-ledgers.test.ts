import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { type DatabaseHandle } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { createSqliteExecutor } from "../db/sqlite-executor.js";
import { createEntity } from "../features/entity-store/store.js";
import { migrations } from "./index.js";
import { removeProjectMigrationLedgersMigration } from "./0030-remove-project-migration-ledgers.js";

const databases: Database.Database[] = [];

async function createFixture(): Promise<{ database: DatabaseHandle; projectId: string }> {
	const database = new Database(":memory:") as DatabaseHandle;
	databases.push(database);
	await runMigrations(database, migrations.slice(0, -1));
	database.tenantId = "tenant-a";
	database.currentProjectId = "00000000-0000-0000-0000-000000000001";
	const project = createEntity(createSqliteExecutor(database), { kind: "project", title: "Agent Issues" });
	database.prepare(`INSERT INTO project_migrations (tenant_id, legacy_tenant_id, project_id, created_at)
		VALUES ('tenant-a', 'agent-issues-de3fbe614e21', ?, '2026-01-01T00:00:00.000Z')`).run(project.id);
	database.exec(`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY)`);
	return { database, projectId: project.id };
}

function hasTable(database: Database.Database, name: string): boolean {
	return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

describe("project migration ledger removal (SQLite 0030)", () => {
	it("drops empty legacy ledgers", async () => {
		const database = new Database(":memory:") as DatabaseHandle;
		databases.push(database);
		await runMigrations(database, migrations.slice(0, -1));
		database.exec(`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY)`);

		await runMigrations(database, [removeProjectMigrationLedgersMigration]);

		expect(hasTable(database, "project_migrations")).toBe(false);
		expect(hasTable(database, "__drizzle_migrations")).toBe(false);
	});

	it("drops both legacy ledgers after every mapping resolves to the same project", async () => {
		const { database, projectId } = await createFixture();

		await runMigrations(database, [removeProjectMigrationLedgersMigration]);

		expect(hasTable(database, "project_migrations")).toBe(false);
		expect(hasTable(database, "__drizzle_migrations")).toBe(false);
		expect(database.prepare("SELECT id FROM entities WHERE id = ?").get(projectId)).toEqual({ id: projectId });
	});

	it("ignores a tombstoned project with the same normalized title", async () => {
		const { database } = await createFixture();
		const duplicate = createEntity(createSqliteExecutor(database), { kind: "project", title: "agent_issues" });
		database.prepare("UPDATE entities SET tombstone = 1 WHERE id = ?").run(duplicate.id);

		await runMigrations(database, [removeProjectMigrationLedgersMigration]);

		expect(hasTable(database, "project_migrations")).toBe(false);
		expect(hasTable(database, "__drizzle_migrations")).toBe(false);
	});

	it("retains both source ledgers when a mapping cannot preserve project selection", async () => {
		const { database } = await createFixture();
		database.prepare("UPDATE entities SET title = 'Different Project' WHERE title = 'Agent Issues'").run();

		await expect(runMigrations(database, [removeProjectMigrationLedgersMigration])).rejects.toThrow(/cannot uniquely preserve project mapping/i);

		expect(hasTable(database, "project_migrations")).toBe(true);
		expect(hasTable(database, "__drizzle_migrations")).toBe(true);
		expect(database.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(removeProjectMigrationLedgersMigration.id)).toBeUndefined();
	});

	it("retains both source ledgers when the mapped project is missing", async () => {
		const { database, projectId } = await createFixture();
		database.prepare("DELETE FROM entities WHERE id = ?").run(projectId);

		await expect(runMigrations(database, [removeProjectMigrationLedgersMigration])).rejects.toThrow(/cannot uniquely preserve project mapping/i);

		expect(hasTable(database, "project_migrations")).toBe(true);
		expect(hasTable(database, "__drizzle_migrations")).toBe(true);
	});

	it("retains both source ledgers when the normalized project title is ambiguous", async () => {
		const { database } = await createFixture();
		createEntity(createSqliteExecutor(database), { kind: "project", title: "agent_issues" });

		await expect(runMigrations(database, [removeProjectMigrationLedgersMigration])).rejects.toThrow(/cannot uniquely preserve project mapping/i);

		expect(hasTable(database, "project_migrations")).toBe(true);
		expect(hasTable(database, "__drizzle_migrations")).toBe(true);
	});
});