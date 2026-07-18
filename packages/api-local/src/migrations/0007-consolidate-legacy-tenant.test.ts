import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { migrations as coreMigrations } from "./index.js";
import { buildConsolidateLegacyTenantMigration } from "./0007-consolidate-legacy-tenant.js";
import { migrateHandoffsToEntitiesMigration } from "./0010-migrate-handoffs-to-entities.js";

const dbs: Database.Database[] = [];

afterEach(() => {
	for (const db of dbs.splice(0)) {
		db.close();
	}
});

// Only the schema-establishing migrations (0000-0003), not the bootstrap
// backfills (0004-0006) - this migration's own contract is independent of
// those, and running them too would manufacture PROJ0/EPIC0 sentinels/
// counters/history for every seeded tenant before the test gets to assert
// on this migration's own effects.
const schemaMigrations = coreMigrations.slice(0, 3);

async function freshDatabase(): Promise<Database.Database> {
	const db = new Database(":memory:");
	dbs.push(db);
	await runMigrations(db, schemaMigrations);
	return db;
}

function seedEntity(
	db: Database.Database,
	tenantId: string,
	id: string,
	kind: string,
	title: string,
	options?: { body?: string; bodySource?: string; status?: string }
): void {
	db.prepare(
		`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
	).run(tenantId, id, kind, title, options?.status ?? "active", options?.body ?? "", options?.bodySource ?? "authored");
}

function seedRelation(db: Database.Database, tenantId: string, fromId: string, toId: string, type: string): void {
	db.prepare(`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES (?, ?, ?, ?, '2024-01-01T00:00:00.000Z')`).run(
		tenantId,
		fromId,
		toId,
		type
	);
}

function seedCounters(db: Database.Database, tenantId: string, advancedKinds: Record<string, number> = {}): void {
	const kinds = ["project", "epic", "version", "initiative", "prd", "userStory", "adr", "issue", "handoff"];
	for (const kind of kinds) {
		db.prepare(`INSERT INTO counters (tenant_id, kind, next_value) VALUES (?, ?, ?)`).run(tenantId, kind, advancedKinds[kind] ?? 1);
	}
}

describe("buildConsolidateLegacyTenantMigration (ISS180)", () => {
	it("folds a legacy tenant's full data set into a freshly-minted project under the target tenant, remapping every id", async () => {
		const db = await freshDatabase();
		seedCounters(db, "well-known-tenant", { epic: 3, initiative: 3, issue: 3, project: 2 });
		seedEntity(db, "legacy-team", "INIT1", "initiative", "Legacy initiative");
		seedEntity(db, "legacy-team", "ISS1", "issue", "Legacy issue");
		seedRelation(db, "legacy-team", "INIT1", "ISS1", "tracks");
		db.exec(`
			CREATE TABLE handoffs (
				tenant_id TEXT NOT NULL,
				id TEXT NOT NULL,
				entity_id TEXT NOT NULL,
				initiative_id TEXT,
				summary TEXT NOT NULL DEFAULT '',
				body TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (tenant_id, id)
			)
		`);
		db.prepare(
			`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
			 VALUES ('legacy-team', 'INIT1', 'INIT1', '', '', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
			 VALUES ('legacy-team', 'INIT1', 'Legacy term', 'Legacy glossary term.', '', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
			 VALUES ('legacy-team', 'default', NULL, '', '', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
			 VALUES ('legacy-team', 'default', 'Legacy shared term', 'Legacy shared term.', '', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
			 VALUES ('legacy-team', 'HO1', 'INIT1', 'INIT1', 'Legacy handoff', 'Legacy handoff body.', '2024-01-01T00:00:00.000Z')`
		).run();

		const migration = buildConsolidateLegacyTenantMigration({
			legacyTenantId: "legacy-team",
			projectTitle: "Legacy Team",
			targetTenantId: "well-known-tenant"
		});
		await runMigrations(db, [migration]);
		await runMigrations(db, [migrateHandoffsToEntitiesMigration]);

		const remainingLegacyRows = db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = 'legacy-team'`).get() as {
			count: number;
		};
		expect(remainingLegacyRows.count).toBe(0);

		const entities = db.prepare(`SELECT id, kind, title FROM entities WHERE tenant_id = 'well-known-tenant' ORDER BY id`).all() as Array<{
			id: string;
			kind: string;
			title: string;
		}>;
		const migratedInitiative = entities.find((entity) => entity.title === "Legacy initiative");
		const migratedIssue = entities.find((entity) => entity.title === "Legacy issue");
		const migratedProject = entities.find((entity) => entity.kind === "project");
		expect(migratedProject).toMatchObject({ title: "Legacy Team" });
		// Freshly minted under the target tenant's own already-advanced
		// counters (project counter started at 2), not the legacy tenant's own
		// INIT1/ISS1 ids - proves remapping actually happened.
		expect(migratedProject?.id).toBe("PROJ2");
		expect(migratedInitiative?.id).not.toBe("INIT1");
		expect(migratedIssue?.id).not.toBe("ISS1");

		const migratedEpic = entities.find((entity) => entity.kind === "epic");
		expect(migratedEpic).toBeTruthy();

		const containsPairs = db
			.prepare(`SELECT from_id, to_id FROM relations WHERE tenant_id = 'well-known-tenant' AND type = 'contains'`)
			.all() as Array<{ from_id: string; to_id: string }>;
		expect(containsPairs).toContainEqual({ from_id: migratedProject!.id, to_id: migratedEpic!.id });
		expect(containsPairs).toContainEqual({ from_id: migratedEpic!.id, to_id: migratedInitiative!.id });

		const tracksPairs = db
			.prepare(`SELECT from_id, to_id FROM relations WHERE tenant_id = 'well-known-tenant' AND type = 'tracks'`)
			.all() as Array<{ from_id: string; to_id: string }>;
		expect(tracksPairs).toContainEqual({ from_id: migratedInitiative!.id, to_id: migratedIssue!.id });

		const terms = db
			.prepare(`SELECT context_key, term FROM context_terms WHERE tenant_id = 'well-known-tenant' ORDER BY term`)
			.all() as Array<{ context_key: string; term: string }>;
		expect(terms).toContainEqual({ context_key: migratedInitiative!.id, term: "Legacy term" });
		expect(terms).toContainEqual({ context_key: `default:${migratedProject!.id}`, term: "Legacy shared term" });

		const handoff = db
			.prepare(`SELECT id, kind, title, body FROM entities WHERE tenant_id = 'well-known-tenant' AND kind = 'handoff'`)
			.get() as { id: string; kind: string; title: string; body: string };
		expect(handoff).toMatchObject({ id: expect.stringMatching(/^HO\d+$/), kind: "handoff", title: "Legacy handoff", body: "Legacy handoff body." });
		expect(
			db
				.prepare(`SELECT from_id, to_id, type FROM relations WHERE tenant_id = 'well-known-tenant' AND from_id = ?`)
				.get(handoff.id)
		).toEqual({ from_id: handoff.id, to_id: migratedInitiative!.id, type: "handsOff" });
		expect(
			db.prepare(`SELECT title, body FROM history_entries WHERE tenant_id = 'well-known-tenant' AND entity_id = ?`).get(handoff.id)
		).toEqual({ title: "Legacy handoff", body: "Legacy handoff body." });
		expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'`).get()).toBeUndefined();

		const projectMigrationRow = db
			.prepare(`SELECT legacy_tenant_id AS legacyTenantId, project_id AS projectId FROM project_migrations WHERE tenant_id = 'well-known-tenant'`)
			.get();
		expect(projectMigrationRow).toEqual({ legacyTenantId: "legacy-team", projectId: migratedProject!.id });
	});

	it("attaches an orphan initiative (no pre-existing epic) directly to the newly-minted project epic", async () => {
		const db = await freshDatabase();
		seedCounters(db, "well-known-tenant");
		// Predates ISS34's own PROJ0/EPIC0 sentinel entirely: schema exists,
		// but the only row is a bare, parentless initiative with no 'contains'
		// relation pointing at it.
		seedEntity(db, "orphan-legacy", "INIT1", "initiative", "Orphan initiative");

		const migration = buildConsolidateLegacyTenantMigration({
			legacyTenantId: "orphan-legacy",
			projectTitle: "Orphan Legacy",
			targetTenantId: "well-known-tenant"
		});
		await runMigrations(db, [migration]);

		const migratedInitiative = db
			.prepare(`SELECT id FROM entities WHERE tenant_id = 'well-known-tenant' AND title = 'Orphan initiative'`)
			.get() as { id: string };
		const migratedEpic = db.prepare(`SELECT id FROM entities WHERE tenant_id = 'well-known-tenant' AND kind = 'epic'`).get() as {
			id: string;
		};

		expect(
			db
				.prepare(`SELECT 1 FROM relations WHERE tenant_id = 'well-known-tenant' AND from_id = ? AND to_id = ? AND type = 'contains'`)
				.get(migratedEpic.id, migratedInitiative.id)
		).toBeTruthy();
	});

	it("keeps the migrated project's own history in sync with its renamed title when the legacy tenant already had its own PROJ0/EPIC0 sentinel with seeded history", async () => {
		const db = await freshDatabase();
		seedCounters(db, "well-known-tenant");
		seedCounters(db, "legacy-with-sentinel");
		seedEntity(db, "legacy-with-sentinel", "PROJ0", "project", "Default Project", { bodySource: "generated" });
		seedEntity(db, "legacy-with-sentinel", "EPIC0", "epic", "Default Epic", { bodySource: "generated" });
		seedRelation(db, "legacy-with-sentinel", "PROJ0", "EPIC0", "contains");
		seedEntity(db, "legacy-with-sentinel", "INIT1", "initiative", "Legacy initiative under sentinel");
		seedRelation(db, "legacy-with-sentinel", "EPIC0", "INIT1", "contains");
		// The legacy tenant's own version-1 history for its PROJ0/EPIC0
		// sentinel, generically titled - exactly the real production shape
		// this regression (fixed in commit fb45060) is about.
		db.prepare(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			 VALUES ('h-proj0', 'legacy-with-sentinel', 'PROJ0', 1, 'system', 'Default Project', '', 'generated', 'active', NULL, '2024-01-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			 VALUES ('h-epic0', 'legacy-with-sentinel', 'EPIC0', 1, 'system', 'Default Epic', '', 'generated', 'active', 'PROJ0', '2024-01-01T00:00:00.000Z')`
		).run();

		const migration = buildConsolidateLegacyTenantMigration({
			legacyTenantId: "legacy-with-sentinel",
			projectTitle: "Legacy With Sentinel",
			targetTenantId: "well-known-tenant"
		});
		await runMigrations(db, [migration]);

		const projectMigrationRow = db
			.prepare(`SELECT project_id AS projectId FROM project_migrations WHERE tenant_id = 'well-known-tenant'`)
			.get() as { projectId: string };
		const project = db.prepare(`SELECT title FROM entities WHERE tenant_id = 'well-known-tenant' AND id = ?`).get(
			projectMigrationRow.projectId
		) as { title: string };
		expect(project.title).toBe("Legacy With Sentinel");

		// The bug this regression guards: relocating the legacy PROJ0's own
		// stale "Default Project" history onto the new project id, with no
		// further history entry recording the migration's own rename, left
		// entities.title and the project's LATEST history version
		// disagreeing.
		const latestHistoryTitle = db
			.prepare(`SELECT title FROM history_entries WHERE tenant_id = 'well-known-tenant' AND entity_id = ? ORDER BY version DESC LIMIT 1`)
			.get(projectMigrationRow.projectId) as { title: string };
		expect(latestHistoryTitle.title).toBe("Legacy With Sentinel");

		// The relocated stale version-1 entry itself must still be present
		// (no data loss) - just no longer the winning/latest version.
		const historyTitles = db
			.prepare(`SELECT title FROM history_entries WHERE tenant_id = 'well-known-tenant' AND entity_id = ? ORDER BY version ASC`)
			.all(projectMigrationRow.projectId) as Array<{ title: string }>;
		expect(historyTitles.map((entry) => entry.title)).toEqual(["Default Project", "Legacy With Sentinel"]);
	});

	it("is ledger-idempotent: re-running the exact same migration list a second time is a no-op", async () => {
		const db = await freshDatabase();
		seedCounters(db, "well-known-tenant");
		seedEntity(db, "legacy-team", "INIT1", "initiative", "Legacy initiative");

		const migration = buildConsolidateLegacyTenantMigration({
			legacyTenantId: "legacy-team",
			projectTitle: "Legacy Team",
			targetTenantId: "well-known-tenant"
		});
		await runMigrations(db, [migration]);

		const entityCountBefore = (
			db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = 'well-known-tenant'`).get() as { count: number }
		).count;

		// A second run against the same ledger (schema_migrations already has
		// this exact migration id recorded) must be a pure no-op - no second
		// project, no re-processing of a tenant that no longer has any rows
		// left to find.
		await runMigrations(db, [migration]);

		const entityCountAfter = (
			db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = 'well-known-tenant'`).get() as { count: number }
		).count;
		expect(entityCountAfter).toBe(entityCountBefore);
	});
});
