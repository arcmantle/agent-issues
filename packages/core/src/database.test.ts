import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineContextTerm } from "./context-store.js";
import {
	consolidateTenantIntoProject,
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
import { createEntity, createHandoff } from "./store.js";

const tempDirs: string[] = [];

async function openTestDatabase(dbPath: string, tenant: string, options?: { skipTenantConsolidation?: boolean }): Promise<DatabaseHandle> {
	return (await ensureDatabase(dbPath, { skipTenantConsolidation: options?.skipTenantConsolidation, tenant })).db;
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
		// an unrelated extra backup this test isn't about.
		(await ensureDatabase(dbPath, { tenant: resolveWellKnownLocalTenantId() })).db.close();

		// Simulate a tenant that predates the full-chain invariant (ISS34) and
		// appears only after the sweep already ran: schema exists and has real
		// data, but no PROJ0/EPIC0 yet.
		const bootstrapping = (await ensureDatabase(dbPath, { tenant: "legacy-tenant", skipTenantBootstrap: true })).db;
		const now = new Date().toISOString();
		bootstrapping.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('legacy-tenant', 'INIT1', 'initiative', 'Pre-existing initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		bootstrapping.close();

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
		// bootstrap checks existed.
		const bootstrapping = (await ensureDatabase(dbPath, { tenant: "left-behind-tenant", skipTenantBootstrap: true })).db;
		const now = new Date().toISOString();
		bootstrapping.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('left-behind-tenant', 'INIT1', 'initiative', 'Left behind initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		bootstrapping.close();

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

		const bootstrapping = (await ensureDatabase(dbPath, { tenant: "left-behind-tenant", skipTenantBootstrap: true })).db;
		const now = new Date().toISOString();
		bootstrapping.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('left-behind-tenant', 'INIT1', 'initiative', 'Left behind initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		bootstrapping.close();
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

describe("consolidateTenantIntoProject (ISS63)", () => {
	it("folds a legacy tenant's full data set into a freshly-minted project under the target tenant, remapping every id", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// "legacy-team" stands in for a pre-ISS63 per-folder tenant: it already
		// went through the ordinary full-chain bootstrap (its own PROJ0/EPIC0),
		// on top of which we seed a second initiative/issue chain plus a
		// glossary term, a shared "default" context, and a handoff - the full
		// set of tenant-scoped tables the migration must remap.
		const legacyDb = await openTestDatabase(dbPath, "legacy-team");
		const initiative = createEntity(legacyDb, { kind: "initiative", title: "Legacy initiative" });
		const issue = createEntity(legacyDb, { kind: "issue", parentId: initiative.id, title: "Legacy issue" });
		defineContextTerm(legacyDb, { definition: "Legacy glossary term.", scopeRef: initiative.id, term: "Legacy term" });
		defineContextTerm(legacyDb, { definition: "Legacy shared term.", term: "Legacy shared term" });
		createHandoff(legacyDb, { body: "Legacy handoff body.", entityId: initiative.id, summary: "Legacy handoff" });
		legacyDb.close();

		// skipTenantConsolidation keeps "legacy-team" available for the
		// explicit consolidateTenantIntoProject call below - the automatic
		// sweep now also runs on every open (ISS178), and would otherwise
		// fold "legacy-team" away on its own before this test gets a chance
		// to drive the consolidation explicitly.
		const targetDb = await openTestDatabase(dbPath, "well-known-tenant", { skipTenantConsolidation: true });
		try {
			// Seed the target tenant with its own pre-existing initiative first,
			// so its per-kind counters have already advanced past 1 - proving
			// the migrated legacy ids are freshly minted under THIS tenant's
			// counters rather than colliding with (or coincidentally matching)
			// the legacy tenant's own independent INIT1/ISS1 counters.
			createEntity(targetDb, { kind: "initiative", title: "Pre-existing target initiative" });
			const targetInitiative = createEntity(targetDb, { kind: "initiative", title: "Another pre-existing target initiative" });
			createEntity(targetDb, { kind: "issue", parentId: targetInitiative.id, title: "Pre-existing target issue" });

			const result = consolidateTenantIntoProject(targetDb, dbPath, "legacy-team");
			expect(result).toMatchObject({ consolidated: true, legacyTenantId: "legacy-team", projectTitle: "Legacy Team" });
			expect(result.projectId).toMatch(/^PROJ\d+$/);

			// The legacy tenant is left with nothing behind - every row moved.
			expect(listTenants(targetDb).map((tenant) => tenant.id)).toEqual(["well-known-tenant"]);

			const entities = targetDb
				.prepare(`SELECT id, kind, title FROM entities WHERE tenant_id = 'well-known-tenant' ORDER BY id`)
				.all() as Array<{ id: string; kind: string; title: string }>;
			const migratedInitiative = entities.find((entity) => entity.title === "Legacy initiative");
			const migratedIssue = entities.find((entity) => entity.title === "Legacy issue");
			const migratedProject = entities.find((entity) => entity.id === result.projectId);
			expect(migratedProject).toMatchObject({ kind: "project", title: "Legacy Team" });
			expect(migratedInitiative).toBeTruthy();
			expect(migratedIssue).toBeTruthy();
			// Freshly-minted ids, not the legacy tenant's own INIT1/ISS1 - proves
			// remapping actually happened rather than a verbatim copy.
			expect(migratedInitiative?.id).not.toBe(initiative.id);
			expect(migratedIssue?.id).not.toBe(issue.id);

			const migratedEpic = entities.find((entity) => entity.kind === "epic" && entity.id !== "EPIC0");
			expect(migratedEpic).toBeTruthy();

			const containsPairs = targetDb
				.prepare(`SELECT from_id, to_id FROM relations WHERE tenant_id = 'well-known-tenant' AND type = 'contains'`)
				.all() as Array<{ from_id: string; to_id: string }>;
			expect(containsPairs).toContainEqual({ from_id: result.projectId, to_id: migratedEpic!.id });
			expect(containsPairs).toContainEqual({ from_id: migratedEpic!.id, to_id: migratedInitiative!.id });

			// initiative -> issue is relation type "tracks" (ALLOWED_RELATIONS,
			// domain.ts), not "contains" - checked separately.
			const tracksPairs = targetDb
				.prepare(`SELECT from_id, to_id FROM relations WHERE tenant_id = 'well-known-tenant' AND type = 'tracks'`)
				.all() as Array<{ from_id: string; to_id: string }>;
			expect(tracksPairs).toContainEqual({ from_id: migratedInitiative!.id, to_id: migratedIssue!.id });

			const terms = targetDb
				.prepare(`SELECT context_key, term FROM context_terms WHERE tenant_id = 'well-known-tenant' ORDER BY term`)
				.all() as Array<{ context_key: string; term: string }>;
			expect(terms).toContainEqual({ context_key: migratedInitiative!.id, term: "Legacy term" });
			expect(terms).toContainEqual({ context_key: `default:${result.projectId}`, term: "Legacy shared term" });

			const handoffs = targetDb
				.prepare(`SELECT id, entity_id, summary FROM handoffs WHERE tenant_id = 'well-known-tenant'`)
				.all() as Array<{ id: string; entity_id: string; summary: string }>;
			expect(handoffs).toEqual([{ id: expect.stringMatching(/^HO\d+$/), entity_id: migratedInitiative!.id, summary: "Legacy handoff" }]);

			const projectMigrationRow = targetDb
				.prepare(`SELECT legacy_tenant_id AS legacyTenantId, project_id AS projectId FROM project_migrations WHERE tenant_id = 'well-known-tenant'`)
				.get();
			expect(projectMigrationRow).toEqual({ legacyTenantId: "legacy-team", projectId: result.projectId });
		} finally {
			targetDb.close();
		}
	});

	it("attaches an orphan initiative (no pre-existing epic) directly to the newly-minted project epic", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-orphan-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// Simulate a legacy tenant that predates ISS34's own PROJ0/EPIC0
		// sentinel entirely (confirmed to exist for real in production - see
		// ISS63): schema exists, but the only row is a bare, parentless
		// initiative with no 'contains' relation pointing at it.
		const legacyDb = (await ensureDatabase(dbPath, { tenant: "orphan-legacy", skipTenantBootstrap: true })).db;
		const now = new Date().toISOString();
		legacyDb.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('orphan-legacy', 'INIT1', 'initiative', 'Orphan initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		legacyDb.close();

		const targetDb = await openTestDatabase(dbPath, "well-known-tenant", { skipTenantConsolidation: true });
		try {
			const result = consolidateTenantIntoProject(targetDb, dbPath, "orphan-legacy");

			const migratedInitiative = targetDb
				.prepare(`SELECT id FROM entities WHERE tenant_id = 'well-known-tenant' AND title = 'Orphan initiative'`)
				.get() as { id: string };
			const migratedEpic = targetDb
				.prepare(`SELECT id FROM entities WHERE tenant_id = 'well-known-tenant' AND kind = 'epic' AND id != 'EPIC0'`)
				.get() as { id: string };

			expect(
				targetDb
					.prepare(
						`SELECT 1 FROM relations WHERE tenant_id = 'well-known-tenant' AND from_id = ? AND to_id = ? AND type = 'contains'`
					)
					.get(migratedEpic.id, migratedInitiative.id)
			).toBeTruthy();
			expect(result.consolidated).toBe(true);
		} finally {
			targetDb.close();
		}
	});

	it("keeps the migrated project's own history in sync with its renamed title when the legacy tenant already had ISS34's PROJ0/EPIC0 sentinel with its own seeded history", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-sentinel-history-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// A legacy tenant that already ran ISS34's own bootstrap (normal
		// `ensureDatabase`, not `skipTenantBootstrap`) has its own PROJ0/EPIC0
		// sentinel AND ensureHistorySeed's version-1 history for them, titled
		// generically "Default Project"/"Default Epic" - exactly the real
		// production shape this regression is about (confirmed for real:
		// `agent-issues-de3fbe614e21` and `eye-share-devops-net-9999b3e54780`
		// both had this shape).
		const legacyDb = (await ensureDatabase(dbPath, { tenant: "legacy-with-sentinel" })).db;
		createEntity(legacyDb, { kind: "initiative", title: "Legacy initiative under sentinel" });
		legacyDb.close();

		const targetDb = await openTestDatabase(dbPath, "well-known-tenant", { skipTenantConsolidation: true });
		try {
			const result = consolidateTenantIntoProject(targetDb, dbPath, "legacy-with-sentinel");

			const project = targetDb.prepare(`SELECT title FROM entities WHERE tenant_id = 'well-known-tenant' AND id = ?`).get(
				result.projectId
			) as { title: string };
			expect(project.title).toBe("Legacy With Sentinel");

			// The bug this regression guards: relocating the legacy PROJ0's own
			// stale "Default Project" history onto the new project id, with no
			// further history entry recording the migration's own rename, left
			// entities.title and the project's LATEST history version
			// disagreeing - invisible until `synchronize`'s history-is-truth
			// reconciliation (`applyResolvedFacts`) recomputed and overwrote the
			// correct entities.title right back to the stale "Default Project".
			const latestHistoryTitle = targetDb
				.prepare(
					`SELECT title FROM history_entries WHERE tenant_id = 'well-known-tenant' AND entity_id = ?
					 ORDER BY version DESC LIMIT 1`
				)
				.get(result.projectId) as { title: string };
			expect(latestHistoryTitle.title).toBe("Legacy With Sentinel");

			// The relocated stale version-1 entry itself must still be present
			// (no data loss) - just no longer the winning/latest version.
			const historyTitles = targetDb
				.prepare(`SELECT title FROM history_entries WHERE tenant_id = 'well-known-tenant' AND entity_id = ? ORDER BY version ASC`)
				.all(result.projectId) as Array<{ title: string }>;
			expect(historyTitles.map((entry) => entry.title)).toEqual(["Default Project", "Legacy With Sentinel"]);
		} finally {
			targetDb.close();
		}
	});

	it("is idempotent: a second call for the same legacy tenant is a no-op that returns the existing project id", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-idempotent-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const legacyDb = await openTestDatabase(dbPath, "legacy-team");
		createEntity(legacyDb, { kind: "initiative", title: "Legacy initiative" });
		legacyDb.close();

		const targetDb = await openTestDatabase(dbPath, "well-known-tenant", { skipTenantConsolidation: true });
		try {
			const first = consolidateTenantIntoProject(targetDb, dbPath, "legacy-team");
			expect(first.consolidated).toBe(true);

			const entityCountBefore = (
				targetDb.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = 'well-known-tenant'`).get() as {
					count: number;
				}
			).count;

			const second = consolidateTenantIntoProject(targetDb, dbPath, "legacy-team");
			expect(second).toEqual({ ...first, consolidated: false });

			const entityCountAfter = (
				targetDb.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = 'well-known-tenant'`).get() as {
					count: number;
				}
			).count;
			expect(entityCountAfter).toBe(entityCountBefore);
		} finally {
			targetDb.close();
		}
	});

	it("throws when asked to consolidate a tenant into itself", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-self-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const db = await openTestDatabase(dbPath, "solo-tenant");
		try {
			expect(() => consolidateTenantIntoProject(db, dbPath, "solo-tenant")).toThrow(
				"Cannot consolidate a tenant into itself: solo-tenant"
			);
		} finally {
			db.close();
		}
	});

	it("throws when the legacy tenant has no data to consolidate", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-missing-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const db = await openTestDatabase(dbPath, "well-known-tenant");
		try {
			expect(() => consolidateTenantIntoProject(db, dbPath, "never-existed")).toThrow(
				"Tenant not found or has no data to consolidate: never-existed"
			);
		} finally {
			db.close();
		}
	});
});

describe("automatic legacy-tenant sweep on default-tenant open (ISS63)", () => {
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
		// per-folder tenant model.
		const seeding = (await ensureDatabase(undefined, { tenant: legacyTenantId, currentWorkingDirectory: workspaceDirectory })).db;
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

	it("folds in every outstanding legacy tenant on open, not only the one matching the current workspace's cwd", async () => {
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
		// happen to be standing in right now.
		for (const [tenantId, workspace] of [
			[currentLegacyTenantId, currentWorkspace],
			[otherLegacyTenantIdA, otherWorkspaceA],
			[otherLegacyTenantIdB, otherWorkspaceB]
		] as const) {
			const seeding = (await ensureDatabase(undefined, { tenant: tenantId, currentWorkingDirectory: workspace })).db;
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
});
