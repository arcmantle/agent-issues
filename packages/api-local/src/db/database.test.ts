import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { defineContextTerm } from "../features/context/context-store.js";
import {
	deleteTenant,
	ensureDatabase,
	listTenants,
	renameTenant,
	resolveLegacyWorkspaceTenantId,
	resolveTenantRootPath,
	resolveTenantSlug,
	resolveWellKnownLocalTenantId
} from "./database.js";
import type { SqliteExecutor } from "./sqlite-executor.js";
import { createEntity } from "../features/entity-store/store.js";


const tempDirs: string[] = [];

async function openTestDatabase(dbPath: string, tenant: string): Promise<SqliteExecutor> {
	return (await ensureDatabase(dbPath, { tenant })).executor;
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
	it("opens a database without legacy history or project migration ledgers", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-history-removal-"));
		tempDirs.push(tempDir);

		const { db } = await ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
		try {
			expect(
				db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('history_entries', 'project_migrations', '__drizzle_migrations')").all()
			).toEqual([]);
		} finally {
			db.close();
		}
	});

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

	it("resolves a canonical project reference passed as projectIdentity", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-identity-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const seeded = await ensureDatabase(dbPath, { tenant: "test" });
		const project = createEntity(seeded.executor, { kind: "project", title: "Project A" });
		seeded.db.close();

		const selected = await ensureDatabase(dbPath, { tenant: "test", projectIdentity: project.reference });
		try {
			expect(selected.db.currentProjectId).toBe(project.id);
		} finally {
			selected.db.close();
		}
	});

	it("resolves a normalized exact project title and rejects ambiguous matches", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-title-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const seeded = await ensureDatabase(dbPath, { tenant: "test" });
		const project = createEntity(seeded.executor, { kind: "project", title: "Project A" });
		seeded.db.close();

		const selected = await ensureDatabase(dbPath, { tenant: "test", projectIdentity: "project-a" });
		expect(selected.db.currentProjectId).toBe(project.id);
		createEntity(selected.executor, { kind: "project", title: "project_a" });
		selected.db.close();

		await expect(ensureDatabase(dbPath, { tenant: "test", projectIdentity: "project-a" })).rejects.toThrow(/ambiguous project identity/i);
	});

	it("ignores tombstoned projects when resolving an explicit identity", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-tombstone-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const seeded = await ensureDatabase(dbPath, { tenant: "test" });
		const project = createEntity(seeded.executor, { kind: "project", title: "Project A" });
		const duplicate = createEntity(seeded.executor, { kind: "project", title: "project_a" });
		seeded.db.prepare("UPDATE entities SET tombstone = 1 WHERE id = ?").run(duplicate.id);
		seeded.db.close();

		const selected = await ensureDatabase(dbPath, { tenant: "test", projectIdentity: "project-a" });
		try {
			expect(selected.db.currentProjectId).toBe(project.id);
		} finally {
			selected.db.close();
		}
	});

	it("requires a resolvable identity when multiple live projects exist", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-required-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const soleProject = await ensureDatabase(dbPath, { tenant: "test" });
		const soleProjectId = soleProject.db.currentProjectId;
		soleProject.db.close();

		const reopened = await ensureDatabase(dbPath, { tenant: "test" });
		expect(reopened.db.currentProjectId).toBe(soleProjectId);
		createEntity(reopened.executor, { kind: "project", title: "Project B" });
		reopened.db.close();

		await expect(ensureDatabase(dbPath, { tenant: "test" })).rejects.toThrow(/project identity is required/i);
		await expect(ensureDatabase(dbPath, { tenant: "test", projectIdentity: "missing" })).rejects.toThrow(/cannot resolve project identity/i);
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
		const alphaDb = await openTestDatabase(dbPath, "alpha-team");
		const betaDb = await openTestDatabase(dbPath, "beta-team");

		try {
			const alphaInitiative = createEntity(alphaDb, { kind: "initiative", title: "Alpha" });
			createEntity(alphaDb, { kind: "issue", parentId: alphaInitiative.id, title: "Alpha issue" });
			defineContextTerm(alphaDb, {
				definition: "Alpha glossary term.",
				scopeRef: alphaInitiative.id,
				term: "Alpha term"
			});
			createEntity(alphaDb, { kind: "handoff", title: "Alpha handoff", body: "Ready for handoff.", links: [{ relationType: "handsOff", targetId: alphaInitiative.id }] });

			createEntity(betaDb, { kind: "initiative", title: "Beta" });

			const listed = listTenants(alphaDb.db);
			expect(listed).toEqual([
				{
					counts: {
						contexts: 1,
						contextTerms: 1,
						entities: 5,
						historyEntries: 5,
						relations: 4
					},
					displayName: "Alpha Team",
					id: "alpha-team"
				},
				{
					counts: {
						contexts: 0,
						contextTerms: 0,
						entities: 3,
						historyEntries: 3,
						relations: 2
					},
					displayName: "Beta Team",
					id: "beta-team"
				}
			]);

			const removed = deleteTenant(alphaDb.db, "alpha-team");
			expect(removed).toMatchObject({
				counts: {
					contexts: 1,
					contextTerms: 1,
					entities: 5,
					historyEntries: 5,
					relations: 4
				},
				counters: 9,
				displayName: "Alpha Team",
				removed: true,
				tenantId: "alpha-team"
			});

			expect(listTenants(betaDb.db)).toEqual([
				{
					counts: {
						contexts: 0,
						contextTerms: 0,
						entities: 3,
						historyEntries: 3,
						relations: 2
					},
					displayName: "Beta Team",
					id: "beta-team"
				}
			]);
		} finally {
			alphaDb.db.close();
			betaDb.db.close();
		}
	});

	it("renames one tenant across all tenant-scoped tables", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-rename-"));
		tempDirs.push(tempDir);

		const dbPath = path.join(tempDir, "test.db");
		const sourceDb = await openTestDatabase(dbPath, "source-team");
		const otherDb = await openTestDatabase(dbPath, "other-team");

		try {
			const initiative = createEntity(sourceDb, { kind: "initiative", title: "Source initiative" });
			createEntity(sourceDb, { kind: "issue", parentId: initiative.id, title: "Source issue" });
			defineContextTerm(sourceDb, {
				definition: "Source glossary term.",
				scopeRef: initiative.id,
				term: "Source term"
			});
			createEntity(sourceDb, { kind: "handoff", title: "Source handoff", body: "Source handoff.", links: [{ relationType: "handsOff", targetId: initiative.id }] });

			createEntity(otherDb, { kind: "initiative", title: "Other initiative" });

			const renamed = renameTenant(sourceDb.db, "source-team", "renamed-team");
			expect(renamed).toEqual({
				counts: {
					contexts: 1,
					contextTerms: 1,
					entities: 5,
					historyEntries: 5,
					relations: 4
				},
				counters: 9,
				newDisplayName: "Renamed Team",
				newTenantId: "renamed-team",
				previousDisplayName: "Source Team",
				previousTenantId: "source-team",
				renamed: true
			});

			expect(listTenants(otherDb.db).map((tenant) => tenant.id)).toEqual(["other-team", "renamed-team"]);

			const sourceCounts = sourceDb.db.prepare(
				`SELECT
					(SELECT COUNT(*) FROM counters WHERE tenant_id = 'source-team') AS counters,
					(SELECT COUNT(*) FROM entities WHERE tenant_id = 'source-team') AS entities,
					(SELECT COUNT(*) FROM relations WHERE tenant_id = 'source-team') AS relations,
					(SELECT COUNT(*) FROM contexts WHERE tenant_id = 'source-team') AS contexts,
					(SELECT COUNT(*) FROM context_terms WHERE tenant_id = 'source-team') AS context_terms,
					(SELECT COUNT(*) FROM revision_entries WHERE tenant_id = 'source-team') AS revision_entries`
			).get() as {
				counters: number;
				entities: number;
				relations: number;
				contexts: number;
				context_terms: number;
				revision_entries: number;
			};
			expect(sourceCounts).toEqual({
				context_terms: 0,
				contexts: 0,
				counters: 0,
				entities: 0,
				revision_entries: 0,
				relations: 0
			});

			expect(() => renameTenant(sourceDb.db, "other-team", "renamed-team")).toThrow("Target tenant already exists: renamed-team");
		} finally {
			sourceDb.db.close();
			otherDb.db.close();
		}
	});
});

describe("full-chain invariant backup", () => {
	it("backs up a pre-existing populated tenant exactly once, not again on a later open", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backup-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// Record the one-time consolidation migration before adding a later
		// tenant. This isolates the full-chain backup contract from the
		// unrelated historical consolidation migration.
		(await ensureDatabase(dbPath, { tenant: resolveWellKnownLocalTenantId() })).db.close();

		// Simulate a later tenant with pre-existing data but no full chain.
		// Raw insertion is deliberate: every ordinary open bootstraps its
		// current tenant before this test can observe the backup behavior.
		const now = new Date().toISOString();
		const rawDb = new Database(dbPath);
		rawDb.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('late-tenant', 'INIT1', 'initiative', 'Pre-existing initiative', 'active', '', 'authored', ?, ?)`
		).run(now, now);
		rawDb.close();

		expect(listBackupFiles(dbPath)).toEqual([]);

		const firstOpen = (await ensureDatabase(dbPath, { tenant: "late-tenant" })).db;
		firstOpen.close();
		expect(listBackupFiles(dbPath)).toHaveLength(1);

		const secondOpen = (await ensureDatabase(dbPath, { tenant: "late-tenant" })).db;
		secondOpen.close();
		expect(listBackupFiles(dbPath)).toHaveLength(1);
	});

	it("never backs up a brand-new tenant that has no pre-existing data", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backup-fresh-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const db = await openTestDatabase(dbPath, "fresh-tenant");
		db.db.close();

		expect(listBackupFiles(dbPath)).toEqual([]);
	});
});
