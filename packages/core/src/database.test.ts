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

function openTestDatabase(dbPath: string, tenant: string): DatabaseHandle {
	return ensureDatabase(dbPath, { tenant }).db;
}

function backupsDirectoryFor(dbPath: string): string {
	return path.join(path.dirname(dbPath), "backups");
}

function listBackupFiles(dbPath: string): string[] {
	const backupsDirectory = backupsDirectoryFor(dbPath);
	return existsSync(backupsDirectory) ? readdirSync(backupsDirectory) : [];
}

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

describe("tenant resolution", () => {
	it("defaults to the well-known local tenant regardless of the workspace root path (ISS63)", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-"));
		tempDirs.push(tempDir);

		const workspaceRoot = path.join(tempDir, "agent-issues");
		const nestedDir = path.join(workspaceRoot, "site", "src");

		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - site\n");

		expect(resolveTenantRootPath(nestedDir)).toBe(workspaceRoot);
		expect(resolveTenantSlug({ currentWorkingDirectory: nestedDir })).toBe(resolveWellKnownLocalTenantId());
	});

	it("uses an explicit tenant when provided", () => {
		expect(resolveTenantSlug({ tenant: " Payments Sandbox " })).toBe("payments-sandbox");
	});

	it("derives the legacy per-workspace tenant from the workspace root path (pre-ISS63 formula, kept for migration lookups)", () => {
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

	it("lists tenants with per-table counts and deletes one tenant cleanly", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenants-"));
		tempDirs.push(tempDir);

		const dbPath = path.join(tempDir, "test.db");
		const alphaDb = openTestDatabase(dbPath, "alpha-team");
		const betaDb = openTestDatabase(dbPath, "beta-team");

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

	it("renames one tenant across all tenant-scoped tables", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-rename-"));
		tempDirs.push(tempDir);

		const dbPath = path.join(tempDir, "test.db");
		const sourceDb = openTestDatabase(dbPath, "source-team");
		const otherDb = openTestDatabase(dbPath, "other-team");

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
	it("backs up a pre-existing populated tenant exactly once, not again on a later open", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backup-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// Simulate a tenant that predates the full-chain invariant (ISS34): schema
		// exists and has real data, but no PROJ0/EPIC0 yet.
		const bootstrapping = ensureDatabase(dbPath, { tenant: "legacy-tenant", skipTenantBootstrap: true }).db;
		const now = new Date().toISOString();
		bootstrapping.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('legacy-tenant', 'INIT1', 'initiative', 'Pre-existing initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		bootstrapping.close();

		expect(listBackupFiles(dbPath)).toEqual([]);

		const firstOpen = ensureDatabase(dbPath, { tenant: "legacy-tenant" }).db;
		firstOpen.close();
		expect(listBackupFiles(dbPath)).toHaveLength(1);

		const secondOpen = ensureDatabase(dbPath, { tenant: "legacy-tenant" }).db;
		secondOpen.close();
		expect(listBackupFiles(dbPath)).toHaveLength(1);
	});

	it("never backs up a brand-new tenant that has no pre-existing data", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backup-fresh-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const db = openTestDatabase(dbPath, "fresh-tenant");
		db.close();

		expect(listBackupFiles(dbPath)).toEqual([]);
	});
});

describe("consolidateTenantIntoProject (ISS63)", () => {
	it("folds a legacy tenant's full data set into a freshly-minted project under the target tenant, remapping every id", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// "legacy-team" stands in for a pre-ISS63 per-folder tenant: it already
		// went through the ordinary full-chain bootstrap (its own PROJ0/EPIC0),
		// on top of which we seed a second initiative/issue chain plus a
		// glossary term, a shared "default" context, and a handoff - the full
		// set of tenant-scoped tables the migration must remap.
		const legacyDb = openTestDatabase(dbPath, "legacy-team");
		const initiative = createEntity(legacyDb, { kind: "initiative", title: "Legacy initiative" });
		const issue = createEntity(legacyDb, { kind: "issue", parentId: initiative.id, title: "Legacy issue" });
		defineContextTerm(legacyDb, { definition: "Legacy glossary term.", scopeRef: initiative.id, term: "Legacy term" });
		defineContextTerm(legacyDb, { definition: "Legacy shared term.", term: "Legacy shared term" });
		createHandoff(legacyDb, { body: "Legacy handoff body.", entityId: initiative.id, summary: "Legacy handoff" });
		legacyDb.close();

		const targetDb = openTestDatabase(dbPath, "well-known-tenant");
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

	it("attaches an orphan initiative (no pre-existing epic) directly to the newly-minted project epic", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-orphan-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// Simulate a legacy tenant that predates ISS34's own PROJ0/EPIC0
		// sentinel entirely (confirmed to exist for real in production - see
		// ISS63): schema exists, but the only row is a bare, parentless
		// initiative with no 'contains' relation pointing at it.
		const legacyDb = ensureDatabase(dbPath, { tenant: "orphan-legacy", skipTenantBootstrap: true }).db;
		const now = new Date().toISOString();
		legacyDb.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('orphan-legacy', 'INIT1', 'initiative', 'Orphan initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		legacyDb.close();

		const targetDb = openTestDatabase(dbPath, "well-known-tenant");
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

	it("is idempotent: a second call for the same legacy tenant is a no-op that returns the existing project id", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-idempotent-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const legacyDb = openTestDatabase(dbPath, "legacy-team");
		createEntity(legacyDb, { kind: "initiative", title: "Legacy initiative" });
		legacyDb.close();

		const targetDb = openTestDatabase(dbPath, "well-known-tenant");
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

	it("throws when asked to consolidate a tenant into itself", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-self-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const db = openTestDatabase(dbPath, "solo-tenant");
		try {
			expect(() => consolidateTenantIntoProject(db, dbPath, "solo-tenant")).toThrow(
				"Cannot consolidate a tenant into itself: solo-tenant"
			);
		} finally {
			db.close();
		}
	});

	it("throws when the legacy tenant has no data to consolidate", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-consolidate-missing-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const db = openTestDatabase(dbPath, "well-known-tenant");
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

	it("folds a workspace's pre-existing legacy tenant into a project on the first default-tenant open, and never again", () => {
		const workspaceDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auto-consolidate-workspace-"));
		tempDirs.push(workspaceDirectory);

		const legacyTenantId = resolveLegacyWorkspaceTenantId(workspaceDirectory);
		const wellKnownTenantId = resolveWellKnownLocalTenantId();

		// Seed the legacy tenant directly into the real (HOME-redirected)
		// default db path, simulating data left behind by the pre-ISS63
		// per-folder tenant model.
		const seeding = ensureDatabase(undefined, { tenant: legacyTenantId, currentWorkingDirectory: workspaceDirectory }).db;
		createEntity(seeding, { kind: "initiative", title: "Pre-existing workspace initiative" });
		seeding.close();

		const firstOpen = ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory });
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

		const entityCountAfterFirstOpen = (() => {
			const db = ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory }).db;
			try {
				return (db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?`).get(wellKnownTenantId) as {
					count: number;
				}).count;
			} finally {
				db.close();
			}
		})();

		const secondOpen = ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory });
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

	it("folds in every outstanding legacy tenant on open, not only the one matching the current workspace's cwd", () => {
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
			const seeding = ensureDatabase(undefined, { tenant: tenantId, currentWorkingDirectory: workspace }).db;
			createEntity(seeding, { kind: "initiative", title: `Initiative for ${tenantId}` });
			seeding.close();
		}

		// Open from currentWorkspace only - the other two tenants' folders
		// are never visited in this test.
		const opened = ensureDatabase(undefined, { currentWorkingDirectory: currentWorkspace });
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
