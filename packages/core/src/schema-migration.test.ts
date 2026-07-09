import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDatabase } from "./database.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_FIXTURE = path.join(here, "__fixtures__", "schema-v7.db");
const DOMAIN_TABLES = ["counters", "entities", "relations", "contexts", "context_terms", "handoffs", "metadata"] as const;

const tempDirs: string[] = [];

function stageFixture(): string {
	const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-golden-"));
	tempDirs.push(tempDir);
	const staged = path.join(tempDir, "schema-v7.db");
	copyFileSync(GOLDEN_FIXTURE, staged);
	return staged;
}

function snapshotTables(dbPath: string): Record<string, unknown[]> {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const snapshot: Record<string, unknown[]> = {};
		for (const table of DOMAIN_TABLES) {
			snapshot[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
		}
		return snapshot;
	} finally {
		db.close();
	}
}

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

describe("golden-fixture migration wall", () => {
	it("preserves every record when a pre-Drizzle v7 database is opened", () => {
		const staged = stageFixture();
		const before = snapshotTables(staged);

		const { db } = ensureDatabase(staged, { tenant: "fixture" });
		db.close();

		const after = snapshotTables(staged);

		// Tables untouched by the full-chain-invariant bootstrap (ISS34) stay byte-for-byte identical.
		for (const table of ["contexts", "context_terms", "handoffs", "metadata"] as const) {
			expect(after[table]).toEqual(before[table]);
		}

		// counters/entities/relations gain the synthesized default project+epic (and
		// the "fixture" tenant's one pre-existing initiative gaining a valid parent),
		// but every original row survives unchanged.
		for (const table of ["counters", "entities", "relations"] as const) {
			expect(after[table]).toEqual(expect.arrayContaining(before[table]));
			expect(after[table]).toHaveLength(before[table].length + 2);
		}

		expect(after.entities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tenant_id: "fixture", id: "PROJ0", kind: "project" }),
				expect.objectContaining({ tenant_id: "fixture", id: "EPIC0", kind: "epic" })
			])
		);
		expect(after.relations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tenant_id: "fixture", from_id: "PROJ0", to_id: "EPIC0", type: "contains" }),
				expect.objectContaining({ tenant_id: "fixture", from_id: "EPIC0", to_id: "INIT1", type: "contains" })
			])
		);
		expect(after.counters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tenant_id: "fixture", kind: "project", next_value: 1 }),
				expect.objectContaining({ tenant_id: "fixture", kind: "epic", next_value: 1 })
			])
		);
	});

	it("marks the Drizzle 0000 baseline as applied without re-running it", () => {
		const staged = stageFixture();

		const { db } = ensureDatabase(staged, { tenant: "fixture" });
		db.close();

		const db2 = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const hasMigrationsTable = db2
				.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`)
				.get();
			expect(hasMigrationsTable).toBeTruthy();

			const applied = db2.prepare(`SELECT COUNT(*) AS count FROM __drizzle_migrations`).get() as { count: number };
			expect(applied.count).toBe(1);
		} finally {
			db2.close();
		}
	});
});

function freshDatabasePath(): string {
	const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-fresh-"));
	tempDirs.push(tempDir);
	return path.join(tempDir, "fresh.db");
}

type ColumnShape = { name: string; type: string; notnull: number; dflt: string | null; pk: number };

function describeTable(dbPath: string, table: string): ColumnShape[] {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
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
	} finally {
		db.close();
	}
}

function indexNames(dbPath: string): string[] {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		return (
			db
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
	} finally {
		db.close();
	}
}

describe("fresh install schema parity", () => {
	it("creates the exact v7 table set via the Drizzle baseline", () => {
		const dbPath = freshDatabasePath();
		const { db } = ensureDatabase(dbPath, { tenant: "fresh" });
		db.close();

		const tables = (
			new Database(dbPath, { readonly: true, fileMustExist: true })
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
				.all() as Array<{ name: string }>
		).map((row) => row.name);

		expect(tables).toEqual(
			["__drizzle_migrations", "context_terms", "contexts", "counters", "entities", "handoffs", "metadata", "relations"].sort()
		);
	});

	it("reproduces the v7 entities columns with defaults and composite primary key", () => {
		const dbPath = freshDatabasePath();
		const { db } = ensureDatabase(dbPath, { tenant: "fresh" });
		db.close();

		expect(describeTable(dbPath, "entities")).toEqual([
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

	it("reproduces the v7 named indexes", () => {
		const dbPath = freshDatabasePath();
		const { db } = ensureDatabase(dbPath, { tenant: "fresh" });
		db.close();

		expect(indexNames(dbPath)).toEqual([
			"context_terms_tenant_context_key_idx",
			"contexts_tenant_scope_entity_id_idx",
			"handoffs_tenant_entity_id_idx",
			"handoffs_tenant_initiative_id_idx",
			"relations_tenant_to_id_idx"
		]);
	});

	it("records the 0000 baseline so forward migrations are tracked", () => {
		const dbPath = freshDatabasePath();
		const { db } = ensureDatabase(dbPath, { tenant: "fresh" });
		db.close();

		const db2 = new Database(dbPath, { readonly: true, fileMustExist: true });
		try {
			const applied = db2.prepare(`SELECT COUNT(*) AS count FROM __drizzle_migrations`).get() as { count: number };
			expect(applied.count).toBe(1);
		} finally {
			db2.close();
		}
	});
});

describe("legacy pre-tenant migration through Drizzle", () => {
	function writePreTenantDatabase(dbPath: string): void {
		const db = new Database(dbPath);
		try {
			db.exec(`
				CREATE TABLE counters (kind TEXT PRIMARY KEY, next_value INTEGER NOT NULL);
				CREATE TABLE entities (
					id TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					title TEXT NOT NULL,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE TABLE relations (
					from_id TEXT NOT NULL,
					to_id TEXT NOT NULL,
					type TEXT NOT NULL,
					created_at TEXT NOT NULL,
					PRIMARY KEY (from_id, to_id, type)
				);
				CREATE TABLE contexts (
					key TEXT PRIMARY KEY,
					scope_entity_id TEXT,
					title TEXT NOT NULL,
					summary TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE TABLE context_terms (
					context_key TEXT NOT NULL,
					term TEXT NOT NULL,
					definition TEXT NOT NULL,
					avoid_terms TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (context_key, term)
				);
			`);
			const now = "2024-01-01T00:00:00.000Z";
			db.prepare(`INSERT INTO counters (kind, next_value) VALUES ('initiative', 2), ('issue', 2)`).run();
			db.prepare(`INSERT INTO entities (id, kind, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
				"INIT1",
				"initiative",
				"Legacy initiative",
				"active",
				now,
				now
			);
			db.prepare(`INSERT INTO entities (id, kind, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
				"ISS1",
				"issue",
				"Legacy issue",
				"todo",
				now,
				now
			);
			db.prepare(`INSERT INTO relations (from_id, to_id, type, created_at) VALUES ('INIT1', 'ISS1', 'tracks', ?)`).run(now);
			db.prepare(`INSERT INTO contexts (key, scope_entity_id, title, summary, created_at, updated_at) VALUES ('INIT1', 'INIT1', 'Legacy context', 'Scope summary', ?, ?)`).run(now, now);
			db.prepare(`INSERT INTO context_terms (context_key, term, definition, avoid_terms, created_at, updated_at) VALUES ('INIT1', 'Widget', 'A legacy widget.', '', ?, ?)`).run(now, now);
		} finally {
			db.close();
		}
	}

	it("moves legacy data into the tenant schema and records the baseline", () => {
		const dbPath = freshDatabasePath();
		writePreTenantDatabase(dbPath);

		const { db } = ensureDatabase(dbPath, { tenant: "legacy" });
		db.close();

		const db2 = new Database(dbPath, { readonly: true, fileMustExist: true });
		try {
			const entities = db2.prepare(`SELECT tenant_id, id, kind, body, body_source FROM entities ORDER BY id`).all();
			expect(entities).toEqual([
				{ tenant_id: "legacy", id: "EPIC0", kind: "epic", body: "", body_source: "generated" },
				{ tenant_id: "legacy", id: "INIT1", kind: "initiative", body: "", body_source: "authored" },
				{ tenant_id: "legacy", id: "ISS1", kind: "issue", body: "", body_source: "authored" },
				{ tenant_id: "legacy", id: "PROJ0", kind: "project", body: "", body_source: "generated" }
			]);

			const relations = db2.prepare(`SELECT tenant_id, from_id, to_id, type FROM relations ORDER BY from_id, to_id`).all();
			expect(relations).toEqual([
				{ tenant_id: "legacy", from_id: "EPIC0", to_id: "INIT1", type: "contains" },
				{ tenant_id: "legacy", from_id: "INIT1", to_id: "ISS1", type: "tracks" },
				{ tenant_id: "legacy", from_id: "PROJ0", to_id: "EPIC0", type: "contains" }
			]);

			const terms = db2.prepare(`SELECT tenant_id, context_key, term FROM context_terms`).all();
			expect(terms).toEqual([{ tenant_id: "legacy", context_key: "INIT1", term: "Widget" }]);

			const applied = db2.prepare(`SELECT COUNT(*) AS count FROM __drizzle_migrations`).get() as { count: number };
			expect(applied.count).toBe(1);

			const legacyTables = db2
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'legacy_%'`)
				.all();
			expect(legacyTables).toEqual([]);
		} finally {
			db2.close();
		}
	});
});
