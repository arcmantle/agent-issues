import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { revisionPatchLedgerMigration } from "./0021-revision-patch-ledger.js";

const databases: Database.Database[] = [];

function createFixture(): Database.Database {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(`
		CREATE TABLE entities (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			project_id TEXT,
			PRIMARY KEY (tenant_id, id)
		);
		CREATE TABLE contexts (
			tenant_id TEXT NOT NULL,
			key TEXT NOT NULL,
			scope_entity_id TEXT,
			PRIMARY KEY (tenant_id, key)
		);
		CREATE TABLE context_terms (
			tenant_id TEXT NOT NULL,
			context_key TEXT NOT NULL,
			term TEXT NOT NULL,
			PRIMARY KEY (tenant_id, context_key, term)
		);
		CREATE TABLE entity_delta_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			author TEXT NOT NULL,
			patch_format INTEGER NOT NULL,
			reverse_patch BLOB NOT NULL,
			source_hash TEXT NOT NULL,
			target_hash TEXT NOT NULL,
			restored_from_revision INTEGER,
			created_at TEXT NOT NULL
		);
		CREATE TABLE context_delta_entries AS SELECT
			id, tenant_id, entity_id AS context_key, revision, author, patch_format,
			reverse_patch, source_hash, target_hash, restored_from_revision, created_at
		FROM entity_delta_entries WHERE 0;
		CREATE TABLE context_term_delta_entries AS SELECT
			id, tenant_id, entity_id AS context_key, entity_id AS term, revision, author,
			patch_format, reverse_patch, source_hash, target_hash,
			restored_from_revision, created_at
		FROM entity_delta_entries WHERE 0;
	`);
	db.prepare("INSERT INTO entities (tenant_id, id, project_id) VALUES (?, ?, ?)").run("tenant-a", "ISS1", "PROJ1");
	db.prepare("INSERT INTO contexts (tenant_id, key, scope_entity_id) VALUES (?, ?, ?)").run("tenant-a", "initiative", "ISS1");
	db.prepare("INSERT INTO context_terms (tenant_id, context_key, term) VALUES (?, ?, ?)").run("tenant-a", "initiative", "record:key");
	db.prepare(`INSERT INTO entity_delta_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run("entity-history", "tenant-a", "ISS1", 2, "alice", 1, Buffer.from([0, 1, 255]), "entity-source", "entity-target", null, "2026-07-20T10:00:00.000Z");
	db.prepare(`INSERT INTO context_delta_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run("context-history", "tenant-a", "initiative", 3, "bob", 1, Buffer.from([2, 3, 254]), "context-source", "context-target", 1, "2026-07-20T11:00:00.000Z");
	db.prepare(`INSERT INTO context_term_delta_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run("term-history", "tenant-a", "initiative", "record:key", 4, "carol", 1, Buffer.from([4, 5, 253]), "term-source", "term-target", 2, "2026-07-20T12:00:00.000Z");
	return db;
}

afterEach(() => {
	for (const db of databases.splice(0)) {
		db.close();
	}
});

describe("revision patch ledger migration", () => {
	it("preserves every legacy envelope and patch byte before removing the three delta tables", async () => {
		const db = createFixture();

		await runMigrations(db, [revisionPatchLedgerMigration]);

		const rows = db.prepare(`SELECT
			id, tenant_id, project_id, record_kind, record_key, revision, author,
			patch_format, hex(reverse_patch) AS reverse_patch, source_hash, target_hash,
			restored_from_revision, created_at
			FROM revision_patch_entries ORDER BY revision`).all();
		expect(rows).toEqual([
			{
				id: "entity-history", tenant_id: "tenant-a", project_id: "PROJ1",
				record_kind: "entity", record_key: "4:ISS1", revision: 2, author: "alice",
				patch_format: 1, reverse_patch: "0001FF", source_hash: "entity-source",
				target_hash: "entity-target", restored_from_revision: null,
				created_at: "2026-07-20T10:00:00.000Z"
			},
			{
				id: "context-history", tenant_id: "tenant-a", project_id: "PROJ1",
				record_kind: "context", record_key: "10:initiative", revision: 3, author: "bob",
				patch_format: 1, reverse_patch: "0203FE", source_hash: "context-source",
				target_hash: "context-target", restored_from_revision: 1,
				created_at: "2026-07-20T11:00:00.000Z"
			},
			{
				id: "term-history", tenant_id: "tenant-a", project_id: "PROJ1",
				record_kind: "context-term", record_key: "10:initiative10:record:key", revision: 4, author: "carol",
				patch_format: 1, reverse_patch: "0405FD", source_hash: "term-source",
				target_hash: "term-target", restored_from_revision: 2,
				created_at: "2026-07-20T12:00:00.000Z"
			}
		]);
		const legacyTables = db.prepare(`SELECT name FROM sqlite_master
			WHERE type = 'table' AND name IN ('entity_delta_entries', 'context_delta_entries', 'context_term_delta_entries')`).all();
		expect(legacyTables).toEqual([]);
	});
});