import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { deriveMigratedEntityIdentity, type HistoryEntryRecord } from "@agent-issues/core";
import type { DatabaseHandle } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { createSqliteExecutor } from "../db/sqlite-executor.js";
import { createEntity, listEntityHistory, materializeEntityRevision, updateEntityStatus } from "../features/entity-store/store.js";
import { migrations } from "./index.js";
import { removeHistoryEntriesMigration } from "./0029-remove-history-entries.js";

const databases: Database.Database[] = [];

const migrationsBeforeHistoryRemoval = migrations.slice(
	0,
	migrations.findIndex((migration) => migration.id === removeHistoryEntriesMigration.id)
);

async function createValidFixture(): Promise<{ database: DatabaseHandle; entityId: string }> {
	const database = new Database(":memory:") as DatabaseHandle;
	databases.push(database);
	await runMigrations(database, migrationsBeforeHistoryRemoval);
	database.tenantId = "tenant-a";
	database.currentProjectId = "00000000-0000-0000-0000-000000000001";
	const executor = createSqliteExecutor(database);
	const created = createEntity(executor, { kind: "issue", title: "Original", body: "Body", author: "alice" });
	updateEntityStatus(executor, { entityId: created.id, status: "in-progress", author: "bob" });
	insertSnapshots(database, listEntityHistory(executor, created.id));
	return { database, entityId: created.id };
}

function insertSnapshots(database: Database.Database, entries: HistoryEntryRecord[]): void {
	const insert = database.prepare(`INSERT INTO history_entries
		(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
		VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (const entry of entries) {
		insert.run(`snapshot-${entry.version}`, entry.entityId, entry.version, entry.author, entry.title, entry.body, entry.bodySource, entry.status, entry.parentId, entry.createdAt);
	}
}

function expectHistoryTable(database: Database.Database, present: boolean): void {
	const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_entries'").get();
	expect(table !== undefined).toBe(present);
}

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

describe("history snapshot removal (SQLite 0029)", () => {
	it("drops valid snapshots after preserving a complete materializable chain", async () => {
		const { database } = await createValidFixture();
		await runMigrations(database, [removeHistoryEntriesMigration]);
		expectHistoryTable(database, false);
		expect(database.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(removeHistoryEntriesMigration.id)).toEqual({ id: removeHistoryEntriesMigration.id });
	});

	it("drops an empty history table", async () => {
		const database = new Database(":memory:") as DatabaseHandle;
		databases.push(database);
		await runMigrations(database, migrationsBeforeHistoryRemoval);
		await runMigrations(database, [removeHistoryEntriesMigration]);
		expectHistoryTable(database, false);
	});

	it("recovers a missing revision-1 baseline from its exact snapshot", async () => {
		const { database, entityId } = await createValidFixture();
		const snapshot = database.prepare("SELECT id, author, created_at FROM history_entries WHERE entity_id = ? AND version = 1").get(entityId) as {
			id: string;
			author: string;
			created_at: string;
		};
		database.prepare("DELETE FROM revision_entries WHERE record_kind = 'entity' AND revision = 1").run();

		await runMigrations(database, [removeHistoryEntriesMigration]);

		expectHistoryTable(database, false);
		expect(database.prepare(`SELECT id, revision, author, created_at, length(reverse_patch) AS patch_bytes
			FROM revision_entries WHERE record_kind = 'entity' AND revision = 1`).get()).toEqual({
			author: snapshot.author,
			created_at: snapshot.created_at,
			id: snapshot.id,
			patch_bytes: 0,
			revision: 1
		});
	});

	it("recovers a deleted legacy entity as a tombstoned materializable chain", async () => {
		const database = new Database(":memory:") as DatabaseHandle;
		databases.push(database);
		await runMigrations(database, migrationsBeforeHistoryRemoval);
		database.tenantId = "tenant-a";
		database.currentProjectId = "00000000-0000-0000-0000-000000000001";
		const executor = createSqliteExecutor(database);
		const project = createEntity(executor, { kind: "project", title: "Project" });
		const epic = createEntity(executor, { kind: "epic", parentId: project.id, title: "Epic" });
		const recovered = deriveMigratedEntityIdentity("initiative", "INIT18");
		database.prepare("INSERT OR REPLACE INTO counters (tenant_id, kind, next_value) VALUES ('tenant-a', 'initiative', 19)").run();
		database.prepare(`INSERT INTO history_entries
			(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			VALUES ('legacy-init18-v1', 'tenant-a', ?, 1, 'alice', 'Recovered initiative', 'Original body', 'authored', 'draft', ?, '2026-01-01T00:00:00.000Z')`)
			.run(recovered.stableId, epic.id);

		await runMigrations(database, [removeHistoryEntriesMigration]);

		expectHistoryTable(database, false);
		expect(database.prepare("SELECT reference, kind, revision, tombstone FROM entities WHERE id = ?").get(recovered.stableId)).toEqual({
			kind: "initiative",
			reference: recovered.reference,
			revision: 2,
			tombstone: 1
		});
		expect(listEntityHistory(executor, recovered.stableId)).toEqual([
			expect.objectContaining({
				author: "alice",
				body: "Original body",
				createdAt: "2026-01-01T00:00:00.000Z",
				parentId: epic.id,
				status: "draft",
				title: "Recovered initiative",
				version: 1
			}),
			expect.objectContaining({ parentId: null, version: 2 })
		]);
		expect(materializeEntityRevision(executor, { entityId: recovered.stableId, revision: 1 })).toMatchObject({
			parentId: epic.id,
			tombstone: false
		});
		expect(materializeEntityRevision(executor, { entityId: recovered.stableId, revision: 2 })).toMatchObject({
			parentId: null,
			tombstone: true
		});
	});

	it.each([
		["orphan snapshot", (database: Database.Database) => database.prepare("UPDATE history_entries SET entity_id = 'missing'").run(), /orphan history snapshots/],
		["revision gap", (database: Database.Database) => database.prepare("DELETE FROM revision_entries WHERE revision = 2").run(), /gap in revision chain/],
		["duplicate snapshot version", (database: Database.Database) => database.prepare("INSERT INTO history_entries SELECT 'duplicate', tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at FROM history_entries WHERE version = 1").run(), /duplicate history entry versions/],
		["divergent facts", (database: Database.Database) => database.prepare("UPDATE history_entries SET title = 'Divergent' WHERE version = 1").run(), /divergent title/],
		["revision-1 author mismatch", (database: Database.Database) => database.prepare("UPDATE history_entries SET author = 'mallory' WHERE version = 1").run(), /author mismatch/],
		["author mismatch", (database: Database.Database) => database.prepare("UPDATE history_entries SET author = 'mallory' WHERE version = 2").run(), /author mismatch/],
		["timestamp mismatch", (database: Database.Database) => database.prepare("UPDATE history_entries SET created_at = '2000-01-01T00:00:00.000Z' WHERE version = 2").run(), /timestamp mismatch/]
	] as const)("aborts transactionally for %s", async (_name, corrupt, expectedError) => {
		const { database } = await createValidFixture();
		corrupt(database);
		await expect(runMigrations(database, [removeHistoryEntriesMigration])).rejects.toThrow(expectedError);
		expectHistoryTable(database, true);
		expect(database.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(removeHistoryEntriesMigration.id)).toBeUndefined();
	});
});
