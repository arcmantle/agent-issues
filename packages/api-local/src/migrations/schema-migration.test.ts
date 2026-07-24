import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveMigratedEntityIdentity } from "@agent-issues/core";
import { ensureDatabase, resolveWellKnownLocalTenantId } from "../db/database.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_FIXTURE = path.join(here, "__fixtures__", "schema-v7.db");
const DOMAIN_TABLES = ["counters", "entities", "relations", "contexts", "context_terms"] as const;

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
		const migratedSchema = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const columns = migratedSchema.prepare(`PRAGMA table_info(revision_entries)`).all() as Array<{ name: string }>;
			expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
				"project_id", "record_kind", "record_key", "patch_format",
				"reverse_patch", "source_hash", "target_hash"
			]));
			expect(columns.some((column) => column.name.startsWith("prior_"))).toBe(false);
			const legacyTables = migratedSchema.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
				AND name IN ('entity_delta_entries', 'context_delta_entries', 'context_term_delta_entries')`).all();
			expect(legacyTables).toEqual([]);
			expect(migratedSchema.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get()).toBeUndefined();
		} finally {
			migratedSchema.close();
		}

		const after = snapshotTables(staged);

		expect(after.context_terms).toEqual(
			expect.arrayContaining((before.context_terms as Record<string, unknown>[]).map((row) => expect.objectContaining(row)))
		);
		expect(after.context_terms).toHaveLength(before.context_terms.length);
		expect(after.context_terms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ revision: 1, tombstone: 0, content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
			])
		);
		const migrated = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const contextBaselines = migrated.prepare(`SELECT delta.revision, delta.author, delta.patch_format, length(delta.reverse_patch) AS patch_bytes, lower(hex(delta.source_hash)) AS source_hash, lower(hex(delta.target_hash)) AS target_hash, delta.created_at
				FROM revision_entries AS delta
				JOIN contexts AS head ON head.tenant_id = delta.tenant_id AND delta.record_kind = 'context'
					AND delta.record_key = CAST(length(CAST(head.id AS BLOB)) AS TEXT) || ':' || head.id
				WHERE delta.created_at = head.updated_at
				ORDER BY delta.record_key`).all();
			expect(contextBaselines).toHaveLength(before.contexts.length);
			expect(contextBaselines).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 1, author: "system", patch_format: 1, source_hash: expect.stringMatching(/^[0-9a-f]{64}$/), target_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })]));

			const termBaselines = migrated.prepare(`SELECT delta.revision, delta.author, delta.patch_format, length(delta.reverse_patch) AS patch_bytes, lower(hex(delta.source_hash)) AS source_hash, lower(hex(delta.target_hash)) AS target_hash, delta.created_at
				FROM revision_entries AS delta
				JOIN context_terms AS head ON head.tenant_id = delta.tenant_id AND delta.record_kind = 'context-term'
					AND delta.record_key = CAST(length(CAST(head.id AS BLOB)) AS TEXT) || ':' || head.id
				WHERE delta.created_at = head.updated_at
				ORDER BY delta.record_key`).all();
			expect(termBaselines).toHaveLength(before.context_terms.length);
			expect(termBaselines).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 1, author: "system", patch_format: 1, source_hash: expect.stringMatching(/^[0-9a-f]{64}$/), target_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })]));
		} finally {
			migrated.close();
		}

		for (const row of before.contexts as Array<{ tenant_id: string; key: string; title: string; summary: string; scope_entity_id: string | null }>) {
			expect(after.contexts).toEqual(expect.arrayContaining([expect.objectContaining({
				tenant_id: row.tenant_id,
				key: row.key,
				title: row.title,
				summary: row.summary,
				scope_entity_id: row.scope_entity_id ? deriveMigratedEntityIdentity("initiative", row.scope_entity_id).stableId : null
			})]));
		}
		expect(after.contexts).toHaveLength((before.contexts as unknown[]).length);
		expect(after.contexts).toEqual(
			expect.arrayContaining([expect.objectContaining({ revision: 1, content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })])
		);

		const migratedRecords = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			for (const row of before.entities as Array<{ tenant_id: string; id: string; kind: Parameters<typeof deriveMigratedEntityIdentity>[0]; title: string; status: string }>) {
				const identity = deriveMigratedEntityIdentity(row.kind, row.id);
				expect(migratedRecords.prepare(`SELECT id, reference, title, status FROM entities WHERE tenant_id = ? AND id = ?`).get(row.tenant_id, identity.stableId)).toEqual({ id: identity.stableId, reference: identity.reference, title: row.title, status: row.status });
			}
		} finally {
			migratedRecords.close();
		}
		expect(after.entities).toHaveLength(before.entities.length + 2 + handoffs.length);
		expect(after.relations).toHaveLength(before.relations.length + 2 + handoffs.length);

		// counters gains one row per newly-recognized entity kind (project, epic,
		// version - ISS38) that this pre-existing tenant didn't have before.
		expect(after.counters).toEqual(expect.arrayContaining(before.counters));
		expect(after.counters).toHaveLength(before.counters.length + 3);

		const projectId = deriveMigratedEntityIdentity("project", "PROJ0").stableId;
		const epicId = deriveMigratedEntityIdentity("epic", "EPIC0").stableId;
		const initiativeId = deriveMigratedEntityIdentity("initiative", "INIT1").stableId;
		expect(after.entities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tenant_id: "fixture", id: projectId, kind: "project" }),
				expect.objectContaining({ tenant_id: "fixture", id: epicId, kind: "epic" })
			])
		);
		expect(after.relations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tenant_id: "fixture", from_id: projectId, to_id: epicId, type: "contains" }),
				expect.objectContaining({ tenant_id: "fixture", from_id: epicId, to_id: initiativeId, type: "contains" })
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
		const handoffId = deriveMigratedEntityIdentity("handoff", handoffs[0]!.id).stableId;
		expect(after.entities).toContainEqual(expect.objectContaining({ id: handoffId, kind: "handoff", title: handoffs[0]!.summary, body: handoffs[0]!.body }));
		expect(after.relations).toContainEqual(expect.objectContaining({ from_id: handoffId, to_id: initiativeId, type: "handsOff" }));
	});

	it("backfills a revision-1 ledger entry for every pre-existing record and the new sentinels", async () => {
		const staged = stageFixture();
		const before = snapshotTables(staged);

		const { db } = await ensureDatabase(staged, { tenant: "fixture" });
		db.close();

		const db2 = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const historyRows = db2
				.prepare(`SELECT record_key, revision, author FROM revision_entries WHERE tenant_id = 'fixture' AND record_kind = 'entity' ORDER BY record_key`)
				.all() as Array<{ record_key: string; revision: number; author: string }>;

			const currentIds = db2.prepare(`SELECT id FROM entities WHERE tenant_id = 'fixture' ORDER BY id`).all() as Array<{ id: string }>;
			const seededIds = historyRows.map((row) => row.record_key.slice(row.record_key.indexOf(":") + 1));
			expect(seededIds.sort()).toEqual(currentIds.map((row) => row.id).sort());
			expect(historyRows.every((row) => row.revision === 1)).toBe(true);
			expect(historyRows.every((row) => row.author === "system")).toBe(true);
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
				{ id: "0010-migrate-handoffs-to-entities" },
				{ id: "0011-entity-revision-delta" },
				{ id: "0012-entity-lifecycle-delta" },
				{ id: "0013-entity-parent-delta-marker" },
                                { id: "0014-history-entries-to-deltas" },
				{ id: "0015-context-revision-delta" },
				{ id: "0016-context-term-revision-delta" },
				{ id: "0017-entity-restoration-source" },
				{ id: "0018-context-restoration-source" },
				{ id: "0019-context-revision-baselines" },
				{ id: "0020-compact-reverse-field-patches" },
				{ id: "0021-revision-patch-ledger" },
				{ id: "0022-binary-revision-patch-hashes" },
				{ id: "0023-context-term-stable-ids" },
				{ id: "0024-entity-stable-identities" },
				{ id: "0025-correct-stable-identity-storage" },
				{ id: "0026-remove-entity-aliases" },
				{ id: "0027-remove-drizzle-ledger" },
				{ id: "0028-rename-revision-entries" },
				{ id: "0029-remove-history-entries" },
				{ id: "0030-remove-project-migration-ledgers" },
				{ id: "0031-remove-metadata" }
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

		const { db } = await ensureDatabase(undefined, { projectIdentity: "agent-issues" });
		try {
			const wellKnownTenantId = resolveWellKnownLocalTenantId();
			expect(db.tenantId).toBe(wellKnownTenantId);

			expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project_migrations', '__drizzle_migrations')`).all()).toEqual([]);
			const migratedProjectTitles = db
				.prepare(`SELECT title FROM entities WHERE tenant_id = ? AND kind = 'project' AND title != 'Default Project' ORDER BY title`)
				.all(wellKnownTenantId) as Array<{ title: string }>;
			expect(migratedProjectTitles.map((row) => row.title)).toEqual([
				"Agent Issues",
				"Content Hub",
				"Eye Share Devops Net",
				"Weave"
			]);

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
				{ id: "0010-migrate-handoffs-to-entities" },
				{ id: "0011-entity-revision-delta" },
				{ id: "0012-entity-lifecycle-delta" },
				{ id: "0013-entity-parent-delta-marker" },
                                { id: "0014-history-entries-to-deltas" },
				{ id: "0015-context-revision-delta" },
				{ id: "0016-context-term-revision-delta" },
				{ id: "0017-entity-restoration-source" },
				{ id: "0018-context-restoration-source" },
				{ id: "0019-context-revision-baselines" },
				{ id: "0020-compact-reverse-field-patches" },
				{ id: "0021-revision-patch-ledger" },
				{ id: "0022-binary-revision-patch-hashes" },
				{ id: "0023-context-term-stable-ids" },
				{ id: "0024-entity-stable-identities" },
				{ id: "0025-correct-stable-identity-storage" },
				{ id: "0026-remove-entity-aliases" },
				{ id: "0027-remove-drizzle-ledger" },
				{ id: "0028-rename-revision-entries" },
				{ id: "0029-remove-history-entries" },
				{ id: "0030-remove-project-migration-ledgers" },
				{ id: "0031-remove-metadata" }
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
			const entities = db2.prepare(`SELECT tenant_id, id, reference, kind, body, body_source FROM entities ORDER BY id`).all();
			expect(entities).toEqual([
				{ tenant_id: "legacy", id: deriveMigratedEntityIdentity("epic", "EPIC0").stableId, reference: deriveMigratedEntityIdentity("epic", "EPIC0").reference, kind: "epic", body: "", body_source: "generated" },
				{ tenant_id: "legacy", id: deriveMigratedEntityIdentity("initiative", "INIT1").stableId, reference: deriveMigratedEntityIdentity("initiative", "INIT1").reference, kind: "initiative", body: "", body_source: "authored" },
				{ tenant_id: "legacy", id: deriveMigratedEntityIdentity("project", "PROJ0").stableId, reference: deriveMigratedEntityIdentity("project", "PROJ0").reference, kind: "project", body: "", body_source: "generated" },
				{ tenant_id: "legacy", id: deriveMigratedEntityIdentity("issue", "ISS1").stableId, reference: deriveMigratedEntityIdentity("issue", "ISS1").reference, kind: "issue", body: "", body_source: "authored" }
			]);

			const relations = db2.prepare(`SELECT tenant_id, from_id, to_id, type FROM relations ORDER BY from_id, to_id`).all();
			expect(relations).toEqual([
				{ tenant_id: "legacy", from_id: deriveMigratedEntityIdentity("epic", "EPIC0").stableId, to_id: deriveMigratedEntityIdentity("initiative", "INIT1").stableId, type: "contains" },
				{ tenant_id: "legacy", from_id: deriveMigratedEntityIdentity("initiative", "INIT1").stableId, to_id: deriveMigratedEntityIdentity("issue", "ISS1").stableId, type: "tracks" },
				{ tenant_id: "legacy", from_id: deriveMigratedEntityIdentity("project", "PROJ0").stableId, to_id: deriveMigratedEntityIdentity("epic", "EPIC0").stableId, type: "contains" }
			]);

			const terms = db2.prepare(`SELECT tenant_id, context_key, term FROM context_terms`).all();
			expect(terms).toEqual([{ tenant_id: "legacy", context_key: "INIT1", term: "Widget" }]);

			const applied = db2.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: string }>;
			expect(applied).toEqual([
				{ id: "0000-baseline-v7" },
				{ id: "0004-backfill-tenant-bootstrap" },
				{ id: "0008-consolidate-legacy-tenants-backfill" },
				{ id: "0009-add-entity-project-id" },
				{ id: "0010-migrate-handoffs-to-entities" },
				{ id: "0011-entity-revision-delta" },
				{ id: "0012-entity-lifecycle-delta" },
				{ id: "0013-entity-parent-delta-marker" },
                                { id: "0014-history-entries-to-deltas" },
				{ id: "0015-context-revision-delta" },
				{ id: "0016-context-term-revision-delta" },
				{ id: "0017-entity-restoration-source" },
				{ id: "0018-context-restoration-source" },
				{ id: "0019-context-revision-baselines" },
				{ id: "0020-compact-reverse-field-patches" },
				{ id: "0021-revision-patch-ledger" },
				{ id: "0022-binary-revision-patch-hashes" },
				{ id: "0023-context-term-stable-ids" },
				{ id: "0024-entity-stable-identities" },
				{ id: "0025-correct-stable-identity-storage" },
				{ id: "0026-remove-entity-aliases" },
				{ id: "0027-remove-drizzle-ledger" },
				{ id: "0028-rename-revision-entries" },
				{ id: "0029-remove-history-entries" },
				{ id: "0030-remove-project-migration-ledgers" },
				{ id: "0031-remove-metadata" }
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
