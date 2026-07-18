import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_FIXTURE = path.join(here, "__fixtures__", "schema-v7.db");
const DOMAIN_TABLES = ["counters", "entities", "relations", "contexts", "context_terms", "handoffs", "metadata"] as const;

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

function stageFixture(): string {
	const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-baseline-v7-"));
	tempDirs.push(tempDir);
	const staged = path.join(tempDir, "schema-v7.db");
	copyFileSync(GOLDEN_FIXTURE, staged);
	return staged;
}

function snapshotDomainTables(db: Database.Database): Record<string, unknown[]> {
	const snapshot: Record<string, unknown[]> = {};
	for (const table of DOMAIN_TABLES) {
		snapshot[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
	}
	return snapshot;
}

type ColumnShape = { name: string; type: string; notnull: number; dflt: string | null; pk: number };

function describeTable(db: Database.Database, table: string): ColumnShape[] {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
		type: string;
		notnull: number;
		dflt_value: string | null;
		pk: number;
	}>;
	return columns.map((column) => ({
		name: column.name,
		type: column.type.toUpperCase(),
		notnull: column.notnull,
		dflt: column.dflt_value,
		pk: column.pk
	}));
}

describe("baselineV7Migration", () => {
	it("creates the entities table matching the live schema_version 7 shape on a fresh install", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, [baselineV7Migration]);

		expect(describeTable(db, "entities")).toEqual([
			{ name: "tenant_id", type: "TEXT", notnull: 1, dflt: null, pk: 1 },
			{ name: "id", type: "TEXT", notnull: 1, dflt: null, pk: 2 },
			{ name: "kind", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "title", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "status", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "body", type: "TEXT", notnull: 1, dflt: "''", pk: 0 },
			{ name: "body_source", type: "TEXT", notnull: 1, dflt: "'authored'", pk: 0 },
			{ name: "created_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "updated_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 }
		]);
	});

	it("creates the current table set without legacy handoffs storage on a fresh install", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, [baselineV7Migration]);

		const tables = (
			db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(tables).toEqual(
			[
				"context_terms",
				"contexts",
				"counters",
				"entities",
				"history_entries",
				"metadata",
				"project_migrations",
				"relations",
				"schema_migrations"
			].sort()
		);

		const indexes = (
			db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(indexes).toEqual([
			"context_terms_tenant_context_key_idx",
			"contexts_tenant_scope_entity_id_idx",
			"history_entries_tenant_entity_version_idx",
			"relations_tenant_to_id_idx"
		]);
	});

	it("reproduces the exact column shape of every current table", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, [baselineV7Migration]);

		expect(describeTable(db, "relations")).toEqual([
			{ name: "tenant_id", type: "TEXT", notnull: 1, dflt: null, pk: 1 },
			{ name: "from_id", type: "TEXT", notnull: 1, dflt: null, pk: 2 },
			{ name: "to_id", type: "TEXT", notnull: 1, dflt: null, pk: 3 },
			{ name: "type", type: "TEXT", notnull: 1, dflt: null, pk: 4 },
			{ name: "created_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 }
		]);
		expect(describeTable(db, "contexts")).toEqual([
			{ name: "tenant_id", type: "TEXT", notnull: 1, dflt: null, pk: 1 },
			{ name: "key", type: "TEXT", notnull: 1, dflt: null, pk: 2 },
			{ name: "scope_entity_id", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
			{ name: "title", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "summary", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "created_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "updated_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 }
		]);
		expect(describeTable(db, "context_terms")).toEqual([
			{ name: "tenant_id", type: "TEXT", notnull: 1, dflt: null, pk: 1 },
			{ name: "context_key", type: "TEXT", notnull: 1, dflt: null, pk: 2 },
			{ name: "term", type: "TEXT", notnull: 1, dflt: null, pk: 3 },
			{ name: "definition", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "avoid_terms", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "created_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "updated_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 }
		]);
		expect(describeTable(db, "metadata")).toEqual([
			{ name: "key", type: "TEXT", notnull: 0, dflt: null, pk: 1 },
			{ name: "value", type: "TEXT", notnull: 1, dflt: null, pk: 0 }
		]);
		expect(describeTable(db, "counters")).toEqual([
			{ name: "tenant_id", type: "TEXT", notnull: 1, dflt: null, pk: 1 },
			{ name: "kind", type: "TEXT", notnull: 1, dflt: null, pk: 2 },
			{ name: "next_value", type: "INTEGER", notnull: 1, dflt: null, pk: 0 }
		]);
		expect(describeTable(db, "history_entries")).toEqual([
			{ name: "id", type: "TEXT", notnull: 1, dflt: null, pk: 1 },
			{ name: "tenant_id", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "entity_id", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "version", type: "INTEGER", notnull: 1, dflt: null, pk: 0 },
			{ name: "author", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "title", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "body", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "body_source", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "status", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "parent_id", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
			{ name: "created_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 }
		]);
		expect(describeTable(db, "project_migrations")).toEqual([
			{ name: "tenant_id", type: "TEXT", notnull: 1, dflt: null, pk: 1 },
			{ name: "legacy_tenant_id", type: "TEXT", notnull: 1, dflt: null, pk: 2 },
			{ name: "project_id", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "created_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 }
		]);
	});

	it("creates history_entries_tenant_entity_version_idx as non-unique", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, [baselineV7Migration]);

		const index = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'history_entries_tenant_entity_version_idx'`)
			.get() as { sql: string };
		expect(index.sql).not.toContain("UNIQUE");
	});

	it("leaves every record in the golden-fixture v7 database untouched", async () => {
		const staged = stageFixture();
		const db = new Database(staged);
		const before = snapshotDomainTables(db);

		try {
			await runMigrations(db, [baselineV7Migration]);

			const after = snapshotDomainTables(db);
			expect(after).toEqual(before);

			const applied = db.prepare(`SELECT id FROM schema_migrations`).all();
			expect(applied).toEqual([{ id: "0000-baseline-v7" }]);
		} finally {
			db.close();
		}
	});
});
