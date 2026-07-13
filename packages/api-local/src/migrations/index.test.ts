import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "./index.js";

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
	const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-migration-chain-"));
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

describe("ordered migration chain", () => {
	it("produces the same table set that drizzle-kit currently produces on a fresh install", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, migrations);

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
				"handoffs",
				"history_entries",
				"metadata",
				"project_migrations",
				"relations",
				"schema_migrations"
			].sort()
		);
	});

	it("produces the same named indexes that drizzle-kit currently produces on a fresh install", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, migrations);

		const indexes = (
			db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(indexes).toEqual([
			"context_terms_tenant_context_key_idx",
			"contexts_tenant_scope_entity_id_idx",
			"handoffs_tenant_entity_id_idx",
			"handoffs_tenant_initiative_id_idx",
			"history_entries_tenant_entity_version_idx",
			"relations_tenant_to_id_idx"
		]);
	});

	it("reproduces the v7 entities columns with defaults and composite primary key", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, migrations);

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

	it("records every migration id in the ledger, in order, after a single run", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, migrations);

		const applied = db.prepare(`SELECT id FROM schema_migrations ORDER BY rowid`).all();
		expect(applied).toEqual(migrations.map((migration) => ({ id: migration.id })));
	});
});

describe("golden-fixture migration wall", () => {
	it("carries every original record through the full chain unchanged", async () => {
		const staged = stageFixture();
		const db = new Database(staged);
		const before = snapshotDomainTables(db);

		try {
			await runMigrations(db, migrations);

			const after = snapshotDomainTables(db);
			for (const table of DOMAIN_TABLES) {
				// The fixture predates the bootstrap invariants (0004-0006),
				// which correctly ADD sentinel/counter/history rows for its
				// tenant - so we assert every original row survives unchanged
				// (a subset check), not byte-identical tables.
				for (const originalRow of before[table]) {
					expect(after[table]).toContainEqual(originalRow);
				}
			}

			const applied = db.prepare(`SELECT id FROM schema_migrations ORDER BY rowid`).all();
			expect(applied).toEqual(migrations.map((migration) => ({ id: migration.id })));
		} finally {
			db.close();
		}
	});

	it("backfills the PROJ0/EPIC0 sentinels, project/epic counters, and initiative history for the fixture's pre-existing tenant", async () => {
		const staged = stageFixture();
		const db = new Database(staged);

		try {
			await runMigrations(db, migrations);

			const project = db.prepare(`SELECT id FROM entities WHERE tenant_id = 'fixture' AND id = 'PROJ0'`).get();
			const epic = db.prepare(`SELECT id FROM entities WHERE tenant_id = 'fixture' AND id = 'EPIC0'`).get();
			expect(project).toBeTruthy();
			expect(epic).toBeTruthy();

			const counterKinds = (
				db.prepare(`SELECT kind FROM counters WHERE tenant_id = 'fixture' ORDER BY kind`).all() as Array<{ kind: string }>
			).map((row) => row.kind);
			expect(counterKinds).toEqual(
				["adr", "epic", "handoff", "initiative", "issue", "project", "prd", "userStory", "version"].sort()
			);

			const initiativeHistory = db
				.prepare(`SELECT entity_id FROM history_entries WHERE tenant_id = 'fixture' AND entity_id = 'INIT1'`)
				.all();
			expect(initiativeHistory).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("leaves a counters-only ghost tenant entirely untouched across the whole bootstrap-backfill chain (ISS177)", async () => {
		const staged = stageFixture();
		const db = new Database(staged);

		try {
			// A counters-only "ghost" tenant with no rows in entities/relations/
			// contexts/context_terms/handoffs/history_entries - the kind of
			// debris an incomplete deleteTenant or a never-used workspace can
			// leave behind. Before ISS177's fix, 0004/0005/0006 would each
			// enumerate this id (via a `counters`-inclusive UNION), manufacture
			// a PROJ0/EPIC0 sentinel pair for it, and hand it a full set of
			// counters and history rows - turning debris into a phantom tenant.
			db.prepare(`INSERT INTO counters (tenant_id, kind, next_value) VALUES ('ghost-tenant', 'issue', 1)`).run();

			await runMigrations(db, migrations);

			const ghostEntities = db.prepare(`SELECT id FROM entities WHERE tenant_id = 'ghost-tenant'`).all();
			expect(ghostEntities).toEqual([]);

			const ghostCounters = db.prepare(`SELECT kind FROM counters WHERE tenant_id = 'ghost-tenant'`).all() as Array<{
				kind: string;
			}>;
			expect(ghostCounters).toEqual([{ kind: "issue" }]);

			const ghostHistory = db.prepare(`SELECT id FROM history_entries WHERE tenant_id = 'ghost-tenant'`).all();
			expect(ghostHistory).toEqual([]);
		} finally {
			db.close();
		}
	});
});
