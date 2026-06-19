import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defineContextTerm } from "./context-store.js";
import { deleteTenant, ensureDatabase, listTenants, renameTenant, resolveTenantRootPath, resolveTenantSlug, type DatabaseHandle } from "./database.js";
import { createEntity, createHandoff } from "./store.js";

const tempDirs: string[] = [];

function openTestDatabase(dbPath: string, tenant: string): DatabaseHandle {
	return ensureDatabase(dbPath, { tenant }).db;
}

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

describe("tenant resolution", () => {
	it("derives the tenant from the workspace root path", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-"));
		tempDirs.push(tempDir);

		const workspaceRoot = path.join(tempDir, "agent-issues");
		const nestedDir = path.join(workspaceRoot, "site", "src");

		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - site\n");

		expect(resolveTenantRootPath(nestedDir)).toBe(workspaceRoot);
		expect(resolveTenantSlug({ currentWorkingDirectory: nestedDir })).toBe(
			`agent-issues-${createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12)}`
		);
	});

	it("uses an explicit tenant when provided", () => {
		expect(resolveTenantSlug({ tenant: " Payments Sandbox " })).toBe("payments-sandbox");
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
						entities: 2,
						handoffs: 1,
						relations: 1
					},
					displayName: "Alpha Team",
					id: "alpha-team"
				},
				{
					counts: {
						contexts: 0,
						contextTerms: 0,
						entities: 1,
						handoffs: 0,
						relations: 0
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
					entities: 2,
					handoffs: 1,
					relations: 1
				},
				counters: 6,
				displayName: "Alpha Team",
				removed: true,
				tenantId: "alpha-team"
			});

			expect(listTenants(betaDb)).toEqual([
				{
					counts: {
						contexts: 0,
						contextTerms: 0,
						entities: 1,
						handoffs: 0,
						relations: 0
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
					entities: 2,
					handoffs: 1,
					relations: 1
				},
				counters: 6,
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
					(SELECT COUNT(*) FROM handoffs WHERE tenant_id = 'source-team') AS handoffs`
			).get() as { counters: number; entities: number; relations: number; contexts: number; context_terms: number; handoffs: number };
			expect(sourceCounts).toEqual({ counters: 0, entities: 0, relations: 0, contexts: 0, context_terms: 0, handoffs: 0 });

			expect(() => renameTenant(sourceDb, "other-team", "renamed-team")).toThrow("Target tenant already exists: renamed-team");
		} finally {
			sourceDb.close();
			otherDb.close();
		}
	});
});