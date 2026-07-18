import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDatabase, resolveWellKnownLocalTenantId } from "../db/database.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_FIXTURE = path.join(here, "__fixtures__", "schema-v7.db");
const DOMAIN_TABLES = ["counters", "entities", "relations", "contexts", "context_terms", "metadata"] as const;

// A real (not synthetic) pre-ADR43 backup of a personal `agent-issues.db`,
// scrubbed of the counters-only ghost tenants left behind by an unrelated,
// already-resolved test-isolation bug (ISS167) before being adopted here
// (ISS177) - see this fixture's provenance in ISS177's body for the full
// story of how it was captured and cleaned. Genuinely messier than the
// hand-written `schema-v7.db` fixture above: four real legacy per-folder
// tenants (ADR7's original, pre-ISS63 model), each with real entities,
// relations, contexts, context terms, and (for two of them) handoffs -
// exercising the full one-time legacy-tenant backfill migration
// (`buildConsolidateLegacyTenantsBackfillMigration`, ISS181) against real
// data shapes rather than a single minimal tenant.
const REAL_WORLD_FIXTURE = path.join(here, "__fixtures__", "real-world-multi-tenant-v7.db");
const REAL_WORLD_LEGACY_TENANT_IDS = [
	"agent-issues-de3fbe614e21",
	"content-hub-5ab5819bb0a8",
	"eye-share-devops-net-9999b3e54780",
	"weave-e2d77991499a"
] as const;

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
	it("preserves every record when a pre-Drizzle v7 database is opened", async () => {
		const staged = stageFixture();
		const before = snapshotTables(staged);
		const legacyHandoffs = new Database(staged, { readonly: true, fileMustExist: true });
		const handoffs = legacyHandoffs.prepare("SELECT * FROM handoffs ORDER BY rowid").all() as Array<{ id: string; entity_id: string; summary: string; body: string }>;
		legacyHandoffs.close();

		const { db } = await ensureDatabase(staged, { tenant: "fixture" });
		db.close();

		const after = snapshotTables(staged);

		// Tables untouched by the full-chain-invariant bootstrap (ISS34) stay byte-for-byte identical.
		for (const table of ["contexts", "context_terms", "metadata"] as const) {
			expect(after[table]).toEqual(before[table]);
		}

		// entities/relations gain the synthesized default project+epic (and the
		// "fixture" tenant's one pre-existing initiative gaining a valid parent),
		// but every original row survives unchanged.
		for (const table of ["entities", "relations"] as const) {
			expect(after[table]).toEqual(
				expect.arrayContaining((before[table] as Record<string, unknown>[]).map((row) => expect.objectContaining(row)))
			);
			expect(after[table]).toHaveLength(before[table].length + 2 + handoffs.length);
		}

		// counters gains one row per newly-recognized entity kind (project, epic,
		// version - ISS38) that this pre-existing tenant didn't have before.
		expect(after.counters).toEqual(expect.arrayContaining(before.counters));
		expect(after.counters).toHaveLength(before.counters.length + 3);

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
				expect.objectContaining({ tenant_id: "fixture", kind: "epic", next_value: 1 }),
				expect.objectContaining({ tenant_id: "fixture", kind: "version", next_value: 1 })
			])
		);
		expect(handoffs).toHaveLength(1);
		expect(after.entities).toContainEqual(expect.objectContaining({ id: handoffs[0]!.id, kind: "handoff", title: handoffs[0]!.summary, body: handoffs[0]!.body }));
		expect(after.relations).toContainEqual(expect.objectContaining({ from_id: handoffs[0]!.id, to_id: handoffs[0]!.entity_id, type: "handsOff" }));
	});

	it("backfills a synthetic version-1 history entry for every pre-existing record and the new sentinels", async () => {
		const staged = stageFixture();
		const before = snapshotTables(staged);

		const { db } = await ensureDatabase(staged, { tenant: "fixture" });
		db.close();

		const db2 = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const historyRows = db2
				.prepare(`SELECT entity_id, version, author, status, parent_id FROM history_entries WHERE tenant_id = 'fixture' ORDER BY entity_id`)
				.all() as Array<{ entity_id: string; version: number; author: string; status: string; parent_id: string | null }>;

			const preExistingIds = (before.entities as Array<{ id: string }>).map((entity) => entity.id);
			const seededIds = historyRows.map((row) => row.entity_id);
			expect(seededIds.sort()).toEqual([...preExistingIds, "HO1", "EPIC0", "PROJ0"].sort());
			expect(historyRows.every((row) => row.version === 1)).toBe(true);
			expect(historyRows.every((row) => row.author === "system")).toBe(true);

			expect(historyRows.find((row) => row.entity_id === "INIT1")).toMatchObject({ parent_id: "EPIC0" });
			expect(historyRows.find((row) => row.entity_id === "PROJ0")).toMatchObject({ parent_id: null, status: "active" });
			expect(historyRows.find((row) => row.entity_id === "EPIC0")).toMatchObject({ parent_id: "PROJ0", status: "active" });
		} finally {
			db2.close();
		}
	});

	it("marks the baseline migrations as applied without re-running them", async () => {
		const staged = stageFixture();

		const { db } = await ensureDatabase(staged, { tenant: "fixture" });
		db.close();

		const db2 = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const applied = db2.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: string }>;
			expect(applied).toEqual([
				{ id: "0000-baseline-v7" },
				{ id: "0004-backfill-tenant-bootstrap" },
				{ id: "0008-consolidate-legacy-tenants-backfill" },
				{ id: "0009-add-entity-project-id" },
				{ id: "0010-migrate-handoffs-to-entities" }
			]);
		} finally {
			db2.close();
		}
	});
});

describe("real-world multi-tenant migration (ISS177 regression fixture)", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let dbPath: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-real-world-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		mkdirSync(path.join(homeDirectory, ".agent-issues"), { recursive: true });
		dbPath = path.join(homeDirectory, ".agent-issues", "agent-issues.db");
		copyFileSync(REAL_WORLD_FIXTURE, dbPath);
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("consolidates every genuine legacy tenant into its own project, manufacturing no phantom projects", async () => {
		const before = new Database(dbPath, { readonly: true, fileMustExist: true });
			const entityCountBefore = REAL_WORLD_LEGACY_TENANT_IDS.reduce((sum, tenantId) => {
			const row = before.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?`).get(tenantId) as { count: number };
			return sum + row.count;
		}, 0);
			const handoffCountBefore = REAL_WORLD_LEGACY_TENANT_IDS.reduce((sum, tenantId) => {
				const row = before.prepare(`SELECT COUNT(*) AS count FROM handoffs WHERE tenant_id = ?`).get(tenantId) as { count: number };
				return sum + row.count;
			}, 0);
		before.close();

		const { db } = await ensureDatabase(undefined, {});
		try {
			const wellKnownTenantId = resolveWellKnownLocalTenantId();
			expect(db.tenantId).toBe(wellKnownTenantId);

			const projectMigrations = db
				.prepare(`SELECT legacy_tenant_id FROM project_migrations ORDER BY legacy_tenant_id`)
				.all() as Array<{ legacy_tenant_id: string }>;
			expect(projectMigrations.map((row) => row.legacy_tenant_id)).toEqual([...REAL_WORLD_LEGACY_TENANT_IDS].sort());

			// Exactly one freshly-minted project per real legacy tenant, plus the
			// well-known tenant's own PROJ0 sentinel - no ghost project should be
			// manufactured for a counter-only tenant with no real content (ISS177).
			const projectCount = (
				db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ? AND kind = 'project'`).get(wellKnownTenantId) as {
					count: number;
				}
			).count;
			expect(projectCount).toBe(REAL_WORLD_LEGACY_TENANT_IDS.length + 1);

			// Every real entity from every legacy tenant survives the fold-in,
			// remapped under the well-known tenant, plus one fresh project+epic
			// pair per legacy tenant and the well-known tenant's own pair.
			const entityCountAfter = (
				db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?`).get(wellKnownTenantId) as { count: number }
			).count;
			expect(entityCountAfter).toBe(entityCountBefore + handoffCountBefore + (REAL_WORLD_LEGACY_TENANT_IDS.length + 1) * 2);

			// No tenant id survives outside the well-known tenant - full
			// consolidation, no residue left behind.
			const remainingForeignTenants = db.prepare(`SELECT DISTINCT tenant_id FROM entities WHERE tenant_id != ?`).all(wellKnownTenantId);
			expect(remainingForeignTenants).toEqual([]);
		} finally {
			db.close();
		}
	});

});

function freshDatabasePath(): string {
	const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-fresh-"));
	tempDirs.push(tempDir);
	return path.join(tempDir, "fresh.db");
}

describe("fresh install schema parity", () => {
	it("records all baseline migrations so future forward migrations are tracked", async () => {
		const dbPath = freshDatabasePath();
		const { db } = await ensureDatabase(dbPath, { tenant: "fresh" });
		db.close();

		const db2 = new Database(dbPath, { readonly: true, fileMustExist: true });
		try {
			const applied = db2.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: string }>;
			expect(applied).toEqual([
				{ id: "0000-baseline-v7" },
				{ id: "0004-backfill-tenant-bootstrap" },
				{ id: "0008-consolidate-legacy-tenants-backfill" },
				{ id: "0009-add-entity-project-id" },
				{ id: "0010-migrate-handoffs-to-entities" }
			]);
		} finally {
			db2.close();
		}
	});
});

describe("legacy pre-tenant migration through the ADR43 runner", () => {
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

	it("moves legacy data into the tenant schema and records the baseline", async () => {
		const dbPath = freshDatabasePath();
		writePreTenantDatabase(dbPath);

		const { db } = await ensureDatabase(dbPath, { tenant: "legacy" });
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

			const applied = db2.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: string }>;
			expect(applied).toEqual([
				{ id: "0000-baseline-v7" },
				{ id: "0004-backfill-tenant-bootstrap" },
				{ id: "0008-consolidate-legacy-tenants-backfill" },
				{ id: "0009-add-entity-project-id" },
				{ id: "0010-migrate-handoffs-to-entities" }
			]);

			const legacyTables = db2
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'legacy_%'`)
				.all();
			expect(legacyTables).toEqual([]);
		} finally {
			db2.close();
		}
	});
});
