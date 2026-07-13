import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineContextTerm } from "../context/context-store.js";
import {
	deleteTenant,
	ensureDatabase,
	listTenants,
	renameTenant,
	resolveLegacyWorkspaceTenantId,
	resolveTenantRootPath,
	resolveTenantSlug,
	resolveWellKnownLocalTenantId,
	type DatabaseHandle
} from "./database.js";
import { runMigrations } from "../migrations/migration-runner.js";
import { baselineV7Migration } from "../migrations/versions/0000-baseline-v7.js";
import { createEntity, createHandoff } from "./store.js";

const tempDirs: string[] = [];

async function openTestDatabase(dbPath: string, tenant: string, options?: { skipTenantConsolidation?: boolean }): Promise<DatabaseHandle> {
	return (await ensureDatabase(dbPath, { skipTenantConsolidation: options?.skipTenantConsolidation, tenant })).db;
}

/**
 * Creates just the schema (tables/columns) a fresh database needs, via a raw
 * better-sqlite3 connection - deliberately NOT `ensureDatabase`, whose
 * bootstrap/backfill/consolidation steps are all one-time and ledgered
 * globally per database file. Tests simulating a tenant "left behind" before
 * those ledgered steps ever ran need this schema-only connection so their
 * later `ensureDatabase` open is genuinely the first one to spend that
 * one-time run, observing it actually fix the raw data seeded here.
 */async function createSchemaOnlyDatabase(dbPath: string): Promise<Database.Database> {
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	await runMigrations(db, [baselineV7Migration]);
	return db;
}

function backupsDirectoryFor(dbPath: string): string {
	return path.join(path.dirname(dbPath), "backups");
}

function listBackupFiles(dbPath: string): string[] {
	const backupsDirectory = backupsDirectoryFor(dbPath);
	return existsSync(backupsDirectory) ? readdirSync(backupsDirectory) : [];
}

// The ADR43 migration runner's own generic pre-migration backup writes
// `<dbPath>.<timestamp>.bak` alongside the db file itself, a different
// convention from `ensureFullChainInvariant`'s `backups/` subdirectory
// (co-existing, pre-existing mechanism).
function listRunnerBackupFiles(dbPath: string): string[] {
	const directory = path.dirname(dbPath);
	const basename = path.basename(dbPath);
	return existsSync(directory) ? readdirSync(directory).filter((name) => name.startsWith(`${basename}.`) && name.endsWith(".bak")) : [];
}

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

describe("tenant resolution", () => {
	it("defaults to the well-known local tenant regardless of the workspace root path (ISS63)", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-"));
		tempDirs.push(tempDir);

		const workspaceRoot = path.join(tempDir, "agent-issues");
		const nestedDir = path.join(workspaceRoot, "site", "src");

		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - site\n");

		expect(resolveTenantRootPath(nestedDir)).toBe(workspaceRoot);
		expect(resolveTenantSlug({ currentWorkingDirectory: nestedDir })).toBe(resolveWellKnownLocalTenantId());
	});

	it("uses an explicit tenant when provided", async () => {
		expect(resolveTenantSlug({ tenant: " Payments Sandbox " })).toBe("payments-sandbox");
	});

	it("derives the legacy per-workspace tenant from the workspace root path (pre-ISS63 formula, kept for migration lookups)", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-"));
		tempDirs.push(tempDir);

		const workspaceRoot = path.join(tempDir, "agent-issues");
		const nestedDir = path.join(workspaceRoot, "site", "src");

		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - site\n");

		expect(resolveLegacyWorkspaceTenantId(nestedDir)).toBe(
			`agent-issues-${createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12)}`
		);
	});

	it("lists tenants with per-table counts and deletes one tenant cleanly", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenants-"));
		tempDirs.push(tempDir);

		const dbPath = path.join(tempDir, "test.db");
		// Both opens deliberately keep "alpha-team"/"beta-team" un-migrated
		// (skipTenantConsolidation) - the automatic sweep now runs on every
		// open (ISS178), and this test's whole point is exercising
		// listTenants/deleteTenant against two genuinely-separate,
		// still-unmerged tenants coexisting in one file.
		const alphaDb = await openTestDatabase(dbPath, "alpha-team", { skipTenantConsolidation: true });
		const betaDb = await openTestDatabase(dbPath, "beta-team", { skipTenantConsolidation: true });

		try {
			const alphaInitiative = createEntity(alphaDb, { kind: "initiative", title: "Alpha" });
			createEntity(alphaDb, { kind: "issue", parentId: alphaInitiative.id, title: "Alpha issue" });
			defineContextTerm(alphaDb, {
				definition: "Alpha glossary term.",
				scopeRef: alphaInitiative.id,
				term: "Alpha term"
			});
			createHandoff(alphaDb, { body: "Ready for handoff.", entityId: alphaInitiative.id, summary: "Alpha handoff" });

			createEntity(betaDb, { kind: "initiative", title: "Beta" });

			const listed = listTenants(alphaDb);
			expect(listed).toEqual([
				{
					counts: {
						contexts: 1,
						contextTerms: 1,
						entities: 4,
						handoffs: 1,
						historyEntries: 4,
						relations: 3
					},
					displayName: "Alpha Team",
					id: "alpha-team"
				},
				{
					counts: {
						contexts: 0,
						contextTerms: 0,
						entities: 3,
						handoffs: 0,
						historyEntries: 3,
						relations: 2
					},
					displayName: "Beta Team",
					id: "beta-team"
				}
			]);

			const removed = deleteTenant(alphaDb, "alpha-team");
			expect(removed).toMatchObject({
				counts: {
					contexts: 1,
					contextTerms: 1,
					entities: 4,
					handoffs: 1,
					historyEntries: 4,
					relations: 3
				},
				counters: 9,
				displayName: "Alpha Team",
				removed: true,
				tenantId: "alpha-team"
			});

			expect(listTenants(betaDb)).toEqual([
				{
					counts: {
						contexts: 0,
						contextTerms: 0,
						entities: 3,
						handoffs: 0,
						historyEntries: 3,
						relations: 2
					},
					displayName: "Beta Team",
					id: "beta-team"
				}
			]);
		} finally {
			alphaDb.close();
			betaDb.close();
		}
	});

	it("renames one tenant across all tenant-scoped tables", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-rename-"));
		tempDirs.push(tempDir);

		const dbPath = path.join(tempDir, "test.db");
		// Both opens deliberately keep "source-team"/"other-team" un-migrated
		// (skipTenantConsolidation) - see the identical note on
		// "lists tenants...".
		const sourceDb = await openTestDatabase(dbPath, "source-team", { skipTenantConsolidation: true });
		const otherDb = await openTestDatabase(dbPath, "other-team", { skipTenantConsolidation: true });

		try {
			const initiative = createEntity(sourceDb, { kind: "initiative", title: "Source initiative" });
			createEntity(sourceDb, { kind: "issue", parentId: initiative.id, title: "Source issue" });
			defineContextTerm(sourceDb, {
				definition: "Source glossary term.",
				scopeRef: initiative.id,
				term: "Source term"
			});
			createHandoff(sourceDb, { body: "Source handoff.", entityId: initiative.id, summary: "Source handoff" });

			createEntity(otherDb, { kind: "initiative", title: "Other initiative" });

			const renamed = renameTenant(sourceDb, "source-team", "renamed-team");
			expect(renamed).toEqual({
				counts: {
					contexts: 1,
					contextTerms: 1,
					entities: 4,
					handoffs: 1,
					historyEntries: 4,
					relations: 3
				},
				counters: 9,
				newDisplayName: "Renamed Team",
				newTenantId: "renamed-team",
				previousDisplayName: "Source Team",
				previousTenantId: "source-team",
				renamed: true
			});

			expect(listTenants(otherDb).map((tenant) => tenant.id)).toEqual(["other-team", "renamed-team"]);

			const sourceCounts = sourceDb.prepare(
				`SELECT
					(SELECT COUNT(*) FROM counters WHERE tenant_id = 'source-team') AS counters,
					(SELECT COUNT(*) FROM entities WHERE tenant_id = 'source-team') AS entities,
					(SELECT COUNT(*) FROM relations WHERE tenant_id = 'source-team') AS relations,
					(SELECT COUNT(*) FROM contexts WHERE tenant_id = 'source-team') AS contexts,
					(SELECT COUNT(*) FROM context_terms WHERE tenant_id = 'source-team') AS context_terms,
					(SELECT COUNT(*) FROM handoffs WHERE tenant_id = 'source-team') AS handoffs,
					(SELECT COUNT(*) FROM history_entries WHERE tenant_id = 'source-team') AS history_entries`
			).get() as {
				counters: number;
				entities: number;
				relations: number;
				contexts: number;
				context_terms: number;
				handoffs: number;
				history_entries: number;
			};
			expect(sourceCounts).toEqual({
				context_terms: 0,
				contexts: 0,
				counters: 0,
				entities: 0,
				handoffs: 0,
				history_entries: 0,
				relations: 0
			});

			expect(() => renameTenant(sourceDb, "other-team", "renamed-team")).toThrow("Target tenant already exists: renamed-team");
		} finally {
			sourceDb.close();
			otherDb.close();
		}
	});
});

describe("full-chain invariant backup", () => {
	it("backs up a pre-existing populated tenant exactly once, not again on a later open", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backup-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// Establish the ADR43 all-tenants sweep's ledger first (any ordinary
		// open does this) via the well-known tenant itself, so it's already
		// applied and a no-op by the time "legacy-tenant" appears below -
		// otherwise the sweep would fix this tenant before
		// ensureFullChainInvariant's own per-tenant backup guard ever got a
		// chance to see it missing PROJ0. Using the well-known tenant here
		// (rather than some other made-up name) also means this warm-up open
		// never lingers as a legacy-tenant candidate of its own - the
		// automatic consolidation sweep now runs on every open (ISS178), and
		// a throwaway non-well-known warm-up tenant would otherwise get
		// folded away the moment "legacy-tenant" is opened below, producing
		// an unrelated extra backup this test isn't about. This same open
		// also establishes the schema (tables) this test's raw insert below
		// needs to already exist.
		(await ensureDatabase(dbPath, { tenant: resolveWellKnownLocalTenantId() })).db.close();

		// Simulate a tenant that predates the full-chain invariant (ISS34) and
		// appears only after the sweep already ran: schema exists and has real
		// data, but no PROJ0/EPIC0 yet. Writing this through a raw
		// better-sqlite3 connection rather than `ensureDatabase` is what keeps
		// "legacy-tenant" itself un-bootstrapped going into the assertions
		// below - every ordinary `ensureDatabase` open now always bootstraps
		// whichever tenant it resolves as current (there is no opt-out).
		const now = new Date().toISOString();
		const rawDb = new Database(dbPath);
		rawDb.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('legacy-tenant', 'INIT1', 'initiative', 'Pre-existing initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		rawDb.close();

		expect(listBackupFiles(dbPath)).toEqual([]);

		const firstOpen = (await ensureDatabase(dbPath, { tenant: "legacy-tenant" })).db;
		firstOpen.close();
		expect(listBackupFiles(dbPath)).toHaveLength(1);

		const secondOpen = (await ensureDatabase(dbPath, { tenant: "legacy-tenant" })).db;
		secondOpen.close();
		expect(listBackupFiles(dbPath)).toHaveLength(1);
	});

	it("never backs up a brand-new tenant that has no pre-existing data", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backup-fresh-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const db = await openTestDatabase(dbPath, "fresh-tenant");
		db.close();

		expect(listBackupFiles(dbPath)).toEqual([]);
	});
});

describe("all-tenants bootstrap backfill sweep (ADR43)", () => {
	it("fixes a tenant left behind pre-invariant even though only a different tenant is opened", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-sweep-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// Simulate a tenant that predates the full-chain invariant (ISS34) and
		// tenant counters, left behind with no sentinels/counters/history -
		// exactly as if this tenant was never re-opened since before those
		// bootstrap checks existed. `createSchemaOnlyDatabase` establishes
		// just the schema this raw insert needs, WITHOUT running the ledgered,
		// one-time ADR43 bootstrap-backfill sweep this test is about - an
		// `ensureDatabase` warm-up open would spend that sweep's only chance
		// to run on an empty file before "left-behind-tenant" ever existed to
		// be fixed.
		const schemaDb = await createSchemaOnlyDatabase(dbPath);
		const now = new Date().toISOString();
		schemaDb.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('left-behind-tenant', 'INIT1', 'initiative', 'Left behind initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		schemaDb.close();

		// Open a completely different, currently-active tenant on the same
		// shared db file - "left-behind-tenant" is never the current tenant.
		// skipTenantConsolidation keeps this test isolated to the ADR43
		// bootstrap-backfill sweep alone: without it, the automatic
		// consolidation sweep (which now also runs on every open, ISS178)
		// would immediately fold "left-behind-tenant" into a project under
		// the well-known tenant in this same open, before the assertions
		// below get a chance to see its fixed-in-place sentinels/counters/
		// history still living under its own tenant_id.
		const opened = await ensureDatabase(dbPath, { skipTenantConsolidation: true, tenant: "active-tenant" });
		try {
			const project = opened.db
				.prepare(`SELECT id FROM entities WHERE tenant_id = 'left-behind-tenant' AND id = 'PROJ0'`)
				.get();
			const epic = opened.db.prepare(`SELECT id FROM entities WHERE tenant_id = 'left-behind-tenant' AND id = 'EPIC0'`).get();
			expect(project).toBeTruthy();
			expect(epic).toBeTruthy();

			const counterKinds = (
				opened.db
					.prepare(`SELECT kind FROM counters WHERE tenant_id = 'left-behind-tenant' ORDER BY kind`)
					.all() as Array<{ kind: string }>
			).map((row) => row.kind);
			expect(counterKinds.length).toBeGreaterThan(0);

			const history = opened.db
				.prepare(`SELECT entity_id FROM history_entries WHERE tenant_id = 'left-behind-tenant' AND entity_id = 'INIT1'`)
				.all();
			expect(history).toHaveLength(1);
		} finally {
			opened.db.close();
		}
	});

	it("still never backs up a brand-new database with no pre-existing data at all", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-sweep-fresh-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const db = await openTestDatabase(dbPath, "fresh-tenant");
		db.close();

		expect(listBackupFiles(dbPath)).toEqual([]);
		expect(listRunnerBackupFiles(dbPath)).toEqual([]);
	});

	it("backs up real pre-existing data left behind before fixing it, but never again once already fixed", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-sweep-backup-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// `createSchemaOnlyDatabase` establishes just the schema this raw
		// insert needs, WITHOUT running the ledgered, one-time ADR43
		// bootstrap-backfill sweep this test is about - an `ensureDatabase`
		// warm-up open would spend that sweep's only chance to run on an
		// empty file before "left-behind-tenant" ever existed to be fixed.
		const schemaDb = await createSchemaOnlyDatabase(dbPath);
		const now = new Date().toISOString();
		schemaDb.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('left-behind-tenant', 'INIT1', 'initiative', 'Left behind initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		schemaDb.close();
		expect(listRunnerBackupFiles(dbPath)).toEqual([]);

		const firstOpen = await ensureDatabase(dbPath, { tenant: "active-tenant" });
		firstOpen.db.close();
		// The runner backs up once per not-yet-applied migration it runs
		// (established by ISS168), so a sweep with several pending migrations
		// may produce more than one file - what matters is that at least one
		// backup exists before this real, pre-existing data gets rewritten.
		const backupsAfterFirstOpen = listRunnerBackupFiles(dbPath).length;
		expect(backupsAfterFirstOpen).toBeGreaterThan(0);

		const secondOpen = await ensureDatabase(dbPath, { tenant: "active-tenant" });
		secondOpen.db.close();
		// The sweep is fully applied and ledgered now, so re-opening never
		// backs up again.
		expect(listRunnerBackupFiles(dbPath)).toHaveLength(backupsAfterFirstOpen);
	});
});

describe("one-time legacy-tenant backfill migration on default-tenant open (ISS63/ISS181)", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auto-consolidate-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("folds a workspace's pre-existing legacy tenant into a project on the first default-tenant open, and never again", async () => {
		const workspaceDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auto-consolidate-workspace-"));
		tempDirs.push(workspaceDirectory);

		const legacyTenantId = resolveLegacyWorkspaceTenantId(workspaceDirectory);
		const wellKnownTenantId = resolveWellKnownLocalTenantId();

		// Seed the legacy tenant directly into the real (HOME-redirected)
		// default db path, simulating data left behind by the pre-ISS63
		// per-folder tenant model - `skipTenantConsolidation` keeps this
		// seeding open from burning the one-time backfill migration's only
		// run against itself (a real pre-existing legacy tenant was never
		// written through this modern bootstrap sequence at all).
		const seeding = (
			await ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory, skipTenantConsolidation: true, tenant: legacyTenantId })
		).db;
		createEntity(seeding, { kind: "initiative", title: "Pre-existing workspace initiative" });
		seeding.close();

		const firstOpen = await ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory });
		try {
			expect(firstOpen.db.tenantId).toBe(wellKnownTenantId);
			const migratedInitiative = firstOpen.db
				.prepare(`SELECT id FROM entities WHERE tenant_id = ? AND title = 'Pre-existing workspace initiative'`)
				.get(wellKnownTenantId);
			expect(migratedInitiative).toBeTruthy();
			expect(listTenants(firstOpen.db).map((tenant) => tenant.id)).toEqual([wellKnownTenantId]);
		} finally {
			firstOpen.db.close();
		}

		const entityCountAfterFirstOpen = await (async () => {
			const db = (await ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory })).db;
			try {
				return (db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?`).get(wellKnownTenantId) as {
					count: number;
				}).count;
			} finally {
				db.close();
			}
		})();

		const secondOpen = await ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory });
		try {
			const entityCountAfterSecondOpen = (
				secondOpen.db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?`).get(wellKnownTenantId) as {
					count: number;
				}
			).count;
			expect(entityCountAfterSecondOpen).toBe(entityCountAfterFirstOpen);
		} finally {
			secondOpen.db.close();
		}
	});

	it("folds in every outstanding legacy tenant on the first ordinary open, not only the one matching the current workspace's cwd", async () => {
		const currentWorkspace = mkdtempSync(path.join(tmpdir(), "agent-issues-auto-consolidate-current-"));
		const otherWorkspaceA = mkdtempSync(path.join(tmpdir(), "agent-issues-auto-consolidate-other-a-"));
		const otherWorkspaceB = mkdtempSync(path.join(tmpdir(), "agent-issues-auto-consolidate-other-b-"));
		tempDirs.push(currentWorkspace, otherWorkspaceA, otherWorkspaceB);

		const wellKnownTenantId = resolveWellKnownLocalTenantId();
		const currentLegacyTenantId = resolveLegacyWorkspaceTenantId(currentWorkspace);
		const otherLegacyTenantIdA = resolveLegacyWorkspaceTenantId(otherWorkspaceA);
		const otherLegacyTenantIdB = resolveLegacyWorkspaceTenantId(otherWorkspaceB);

		// Seed three independent legacy tenants into the same shared default
		// db - simulating a user who has opened three different folders with
		// the pre-ISS63 CLI over time, none of which is the folder they
		// happen to be standing in right now. `skipTenantConsolidation` on
		// every seeding open keeps the one-time backfill migration
		// unconsumed until the real "first ordinary open" below.
		for (const [tenantId, workspace] of [
			[currentLegacyTenantId, currentWorkspace],
			[otherLegacyTenantIdA, otherWorkspaceA],
			[otherLegacyTenantIdB, otherWorkspaceB]
		] as const) {
			const seeding = (
				await ensureDatabase(undefined, { currentWorkingDirectory: workspace, skipTenantConsolidation: true, tenant: tenantId })
			).db;
			createEntity(seeding, { kind: "initiative", title: `Initiative for ${tenantId}` });
			seeding.close();
		}

		// Open from currentWorkspace only - the other two tenants' folders
		// are never visited in this test.
		const opened = await ensureDatabase(undefined, { currentWorkingDirectory: currentWorkspace });
		try {
			expect(opened.db.tenantId).toBe(wellKnownTenantId);
			expect(listTenants(opened.db).map((tenant) => tenant.id)).toEqual([wellKnownTenantId]);

			const migratedTitles = opened.db
				.prepare(`SELECT title FROM entities WHERE tenant_id = ? AND kind = 'initiative' ORDER BY title`)
				.all(wellKnownTenantId) as Array<{ title: string }>;
			expect(migratedTitles.map((row) => row.title)).toEqual([
				`Initiative for ${currentLegacyTenantId}`,
				`Initiative for ${otherLegacyTenantIdA}`,
				`Initiative for ${otherLegacyTenantIdB}`
			]);
		} finally {
			opened.db.close();
		}
	});

	it("never sweeps a --tenant created AFTER the one-time backfill migration has already run (ISS181)", async () => {
		const workspaceDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auto-consolidate-workspace-"));
		tempDirs.push(workspaceDirectory);

		const wellKnownTenantId = resolveWellKnownLocalTenantId();

		// The very first ordinary open consumes the one-time backfill
		// migration's only run (nothing to fold in yet - a brand-new
		// install).
		const bootstrapOpen = await ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory });
		bootstrapOpen.db.close();

		// A brand-new, explicitly-named tenant created AFTER that point is a
		// real, durable tenant from here on - it must never be automatically
		// folded into the well-known tenant's projects by any LATER plain
		// open, unlike the pre-ISS181 sweep which re-checked on every open.
		const tenantOpen = (await ensureDatabase(undefined, { tenant: "durable-team", currentWorkingDirectory: workspaceDirectory })).db;
		createEntity(tenantOpen, { kind: "initiative", title: "Durable team's own initiative" });
		tenantOpen.close();

		const laterPlainOpen = await ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory });
		try {
			expect(listTenants(laterPlainOpen.db).map((tenant) => tenant.id).sort()).toEqual(["durable-team", wellKnownTenantId].sort());
			const stillPresent = laterPlainOpen.db
				.prepare(`SELECT title FROM entities WHERE tenant_id = 'durable-team' AND title = 'Durable team''s own initiative'`)
				.get();
			expect(stillPresent).toBeTruthy();
		} finally {
			laterPlainOpen.db.close();
		}
	});
});

