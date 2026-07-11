import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defineContextTerm, getContextDetails, getContextDirectory, queryContextDirectory } from "./context-store.js";
import { consolidateTenantIntoProject, ensureDatabase, resolveLegacyWorkspaceTenantId, type DatabaseHandle } from "./database.js";
import { createEntity } from "./store.js";

let tempDir: string | null = null;

async function openTestDatabase(): Promise<DatabaseHandle> {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-context-"));
	const { db } = await ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
	return db;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("context directory", () => {
	it("includes the shared glossary and initiative-scoped discovery with duplicate detection", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Order",
			definition: "Canonical order.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Payment-specific order.",
			scopeRef: initiative.id
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: initiative.id,
			avoid: ["queued run"]
		});

		const directory = getContextDirectory(db);

		expect(directory.shared.terms.map((term) => term.term)).toEqual(["Order"]);
		expect(directory.initiatives).toHaveLength(1);
		expect(directory.duplicateTerms).toEqual(["Order"]);

		const order = directory.terms.find((entry) => entry.term === "Order");
		expect(order?.hasDuplicates).toBe(true);
		expect(order?.hasSharedSource).toBe(true);
		expect(order?.hasConflictingDefinitions).toBe(true);
		expect(order?.sources.map((source) => source.scopeLabel)).toEqual(["Shared", "Payments"]);

		const settlement = directory.terms.find((entry) => entry.term === "Settlement");
		expect(settlement?.hasDuplicates).toBe(false);
		expect(settlement?.sources[0]?.avoid).toEqual(["queued run"]);
	});

	it("keeps scoped context reads precise for initiative lookups", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Semantic Review" });

		defineContextTerm(db, {
			term: "Review Snapshot",
			definition: "Stored review output for one target.",
			scopeRef: initiative.id
		});

		const details = getContextDetails(db, { scopeRef: initiative.id });

		expect(details.context.scopeKind).toBe("initiative");
		expect(details.context.scopeEntityId).toBe(initiative.id);
		expect(details.terms.map((term) => term.term)).toEqual(["Review Snapshot"]);
	});

	it("supports global-only search against shared context", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Administration",
			definition: "Shared admin surface.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: initiative.id
		});

		const result = queryContextDirectory(db, { query: "admin", view: "global" });

		expect(result.shared?.terms.map((term) => term.term)).toEqual(["Administration"]);
		expect(result.initiatives).toEqual([]);
		expect(result.terms.map((term) => term.term)).toEqual(["Administration"]);
	});

	it("supports initiative-only search without returning shared matches", async () => {
		const db = await openTestDatabase();
		const payments = createEntity(db, { kind: "initiative", title: "Payments" });
		const shipping = createEntity(db, { kind: "initiative", title: "Shipping" });

		defineContextTerm(db, {
			term: "Administration",
			definition: "Shared admin surface.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: payments.id
		});
		defineContextTerm(db, {
			term: "Shipment batch",
			definition: "Grouped dispatch.",
			scopeRef: shipping.id
		});

		const result = queryContextDirectory(db, { query: "settle", view: "initiatives" });

		expect(result.shared).toBeNull();
		expect(result.initiatives.map((details) => details.context.scopeLabel)).toEqual(["Payments"]);
		expect(result.terms.map((term) => term.term)).toEqual(["Settlement"]);
	});

	it("supports conflicts-only queries", async () => {
		const db = await openTestDatabase();
		const payments = createEntity(db, { kind: "initiative", title: "Payments" });
		const shipping = createEntity(db, { kind: "initiative", title: "Shipping" });

		defineContextTerm(db, {
			term: "Order",
			definition: "Canonical order.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Payment order.",
			scopeRef: payments.id
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Shipping order.",
			scopeRef: shipping.id
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: payments.id
		});

		const result = queryContextDirectory(db, { conflictsOnly: true });

		expect(result.terms.map((term) => term.term)).toEqual(["Order"]);
		expect(result.duplicateTerms).toEqual(["Order"]);
		expect(result.terms[0]?.sources).toHaveLength(3);
	});

	it("avoids substring-only false positives during search", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Asset Inspector",
			definition: "Shows preview affordances for the selected asset.",
			scopeRef: initiative.id
		});
		defineContextTerm(db, {
			term: "Review Snapshot",
			definition: "Captured review result.",
			scopeRef: initiative.id
		});

		const result = queryContextDirectory(db, { query: "review", view: "initiatives" });

		expect(result.terms.map((term) => term.term)).toEqual(["Review Snapshot"]);
	});
});

describe("project-aware default context (ISS166)", () => {
	it("resolves bare context scope to the current workspace's own project once the tenant holds many projects", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-context-"));
		const dbPath = path.join(tempDir, "test.db");
		const workspaceA = mkdtempSync(path.join(tmpdir(), "agent-issues-workspace-a-"));

		try {
			// Seed a legacy per-folder tenant (pre-ISS63) with its own data,
			// keyed by workspaceA's deterministic legacy tenant id.
			const legacyTenantId = resolveLegacyWorkspaceTenantId(workspaceA);
			const { db: legacyDb } = await ensureDatabase(dbPath, { tenant: legacyTenantId });
			defineContextTerm(legacyDb, {
				term: "Widget",
				definition: "Workspace A's own widget.",
				scopeRef: "default"
			});
			legacyDb.close();

			// Fold workspaceA's legacy tenant into a `project` under the shared
			// "test" tenant (ISS63), the same way `consolidateAllLegacyTenants`
			// would on the next default-tenant open. skipTenantConsolidation
			// keeps the legacy tenant available for this explicit call - the
			// automatic sweep now also runs on every open (ISS178) and would
			// otherwise fold it into the (different) well-known tenant first.
			const { db: sharedDb } = await ensureDatabase(dbPath, { skipTenantConsolidation: true, tenant: "test" });
			const { projectId, projectTitle } = await consolidateTenantIntoProject(sharedDb, dbPath, legacyTenantId);
			sharedDb.close();

			// Re-opening as if standing in workspaceA should resolve the bare
			// (no --scope) context straight to that project's own migrated
			// `default:<projectId>` row, not the tenant-wide literal "default".
			const { db: dbFromWorkspaceA } = await ensureDatabase(dbPath, { tenant: "test", currentWorkingDirectory: workspaceA });
			const details = getContextDetails(dbFromWorkspaceA, {});

			expect(details.context.key).toBe(`default:${projectId}`);
			expect(details.context.scopeLabel).toBe(projectTitle);
			expect(details.terms.map((term) => term.term)).toEqual(["Widget"]);
			dbFromWorkspaceA.close();

			// Standing anywhere else in this tenant (never consolidated) still
			// resolves the tenant's own sentinel default - no regression for the
			// common single-project case.
			const { db: dbElsewhere } = await ensureDatabase(dbPath, { tenant: "test" });
			const elsewhereDetails = getContextDetails(dbElsewhere, {});
			expect(elsewhereDetails.context.key).toBe("default");
			expect(elsewhereDetails.context.scopeLabel).toBe("Shared");
			dbElsewhere.close();
		} finally {
			rmSync(workspaceA, { force: true, recursive: true });
		}
	});

	it("resolves a project entity id passed as --scope to that project's own default context", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-context-"));
		const dbPath = path.join(tempDir, "test.db");
		const workspaceB = mkdtempSync(path.join(tmpdir(), "agent-issues-workspace-b-"));

		try {
			const legacyTenantId = resolveLegacyWorkspaceTenantId(workspaceB);
			const { db: legacyDb } = await ensureDatabase(dbPath, { tenant: legacyTenantId });
			legacyDb.close();

			const { db: sharedDb } = await ensureDatabase(dbPath, { skipTenantConsolidation: true, tenant: "test" });
			const { projectId, projectTitle } = await consolidateTenantIntoProject(sharedDb, dbPath, legacyTenantId);

			const details = getContextDetails(sharedDb, { scopeRef: projectId });

			expect(details.context.key).toBe(`default:${projectId}`);
			expect(details.context.scopeLabel).toBe(projectTitle);
			sharedDb.close();
		} finally {
			rmSync(workspaceB, { force: true, recursive: true });
		}
	});
});