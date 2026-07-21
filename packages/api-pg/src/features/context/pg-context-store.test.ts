import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";

import { createPgPool, migratePgDatabase, withTenantTransaction } from "../../db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "../../db/test-tenant-cleanup.js";
import { PgStore } from "../../pg-store.js";
import { contextDeltaEntries, contextTermDeltaEntries } from "../../schema.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced in tests (Postgres superusers bypass
// RLS unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

describe("context and glossary", () => {
	let adminPool: Pool;
	let appPool: Pool;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
	});

	afterAll(async () => {
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	it("upserts a context's title and summary, defaulting when not yet configured", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		const beforeUpsert = await store.getContextDetails({ scopeRef: initiative.id });
		expect(beforeUpsert.context.exists).toBe(false);
		expect(beforeUpsert.context.title).toBe("Payments Context");

		const updated = await store.upsertContext({ scopeRef: initiative.id, title: "Custom title", summary: "Custom summary" });
		expect(updated.context.exists).toBe(true);
		expect(updated.context.title).toBe("Custom title");
		expect(updated.context.summary).toBe("Custom summary");
		expect(updated.context.scopeKind).toBe("initiative");
		expect(updated.context.scopeEntityId).toBe(initiative.id);
	});

	it("stores ordered context reverse deltas with predecessor facts and attribution", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const created = await store.upsertContext({ title: "Initial", summary: "First", author: "alice" });
		await store.upsertContext({
			title: "Updated",
			summary: "Second",
			author: "bob",
			expectedRevision: created.context.revision,
			expectedContentHash: created.context.contentHash
		});

		const deltas = await withTenantTransaction(appPool, store.tenantId, (client) =>
			client.select().from(contextDeltaEntries)
				.where(and(eq(contextDeltaEntries.tenantId, store.tenantId), eq(contextDeltaEntries.contextKey, created.context.key)))
				.orderBy(contextDeltaEntries.revision)
		);
		expect(deltas).toEqual([
			expect.objectContaining({ revision: 1, author: "alice", priorTitle: "Initial", priorSummary: "First", createdAt: expect.any(String) }),
			expect.objectContaining({ revision: 2, author: "bob", priorTitle: "Initial", priorSummary: "First", createdAt: expect.any(String) })
		]);
	});

	it("defines a context term, auto-creating the context, and reports created vs. updated", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		const created = await store.defineContextTerm({
			scopeRef: initiative.id,
			term: "storage-driver seam",
			definition: "The engine-agnostic boundary the domain layer talks to."
		});
		expect(created.created).toBe(true);
		expect(created.context.exists).toBe(true);
		expect(created.term.term).toBe("storage-driver seam");

		const updated = await store.defineContextTerm({
			scopeRef: initiative.id,
			term: "storage-driver seam",
			definition: "Updated definition.",
			avoid: ["seam", "storage-driver seam", " duplicate ", "duplicate"],
			author: "bob",
			expectedRevision: created.term.revision,
			expectedContentHash: created.term.contentHash
		});
		expect(updated.created).toBe(false);
		expect(updated.term.definition).toBe("Updated definition.");
		expect(updated.term.avoid).toEqual(["seam", "duplicate"]);

		const deltas = await withTenantTransaction(appPool, store.tenantId, (client) =>
			client.select().from(contextTermDeltaEntries)
				.where(and(eq(contextTermDeltaEntries.tenantId, store.tenantId), eq(contextTermDeltaEntries.term, "storage-driver seam")))
				.orderBy(contextTermDeltaEntries.revision)
		);
		expect(deltas).toEqual([
			expect.objectContaining({ revision: 1, author: "system", priorDefinition: created.term.definition, priorTombstone: false }),
			expect.objectContaining({ revision: 2, author: "bob", priorDefinition: created.term.definition, priorTombstone: false })
		]);
	});

	it("rejects an empty term or definition", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		await expect(store.defineContextTerm({ scopeRef: initiative.id, term: "  ", definition: "x" })).rejects.toThrow(/term/i);
		await expect(store.defineContextTerm({ scopeRef: initiative.id, term: "Order", definition: "  " })).rejects.toThrow(/definition/i);
	});

	it("forgets a context term", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		const created = await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds." });

		const forgotten = await store.forgetContextTerm({
			scopeRef: initiative.id,
			term: "Settlement",
			author: "alice",
			expectedRevision: created.term.revision,
			expectedContentHash: created.term.contentHash
		});
		expect(forgotten.removed).toBe(true);

		const details = await store.getContextDetails({ scopeRef: initiative.id });
		expect(details.terms).toHaveLength(0);

		const forgottenAgain = await store.forgetContextTerm({
			scopeRef: initiative.id,
			term: "Settlement",
			expectedRevision: forgotten.currentRevision,
			expectedContentHash: forgotten.currentContentHash
		});
		expect(forgottenAgain.removed).toBe(false);

		const deltas = await withTenantTransaction(appPool, store.tenantId, (client) =>
			client.select().from(contextTermDeltaEntries)
				.where(and(eq(contextTermDeltaEntries.tenantId, store.tenantId), eq(contextTermDeltaEntries.term, "Settlement")))
				.orderBy(contextTermDeltaEntries.revision)
		);
		expect(deltas).toEqual([
			expect.objectContaining({ revision: 1, priorTombstone: false }),
			expect.objectContaining({ revision: 2, author: "alice", priorDefinition: "Captured funds.", priorTombstone: false })
		]);
	});

	it("resolves a non-initiative scopeRef to its owning initiative's context", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Ship it" });

		await store.defineContextTerm({ scopeRef: issue.id, term: "Settlement", definition: "Captured funds." });

		const details = await store.getContextDetails({ scopeRef: initiative.id });
		expect(details.terms.map((term) => term.term)).toEqual(["Settlement"]);
	});

	it("lists contexts with term counts for shared and each initiative", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		await store.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Canonical order." });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds." });

		const listed = await store.listContexts();
		const shared = listed.contexts.find((entry) => entry.context.scopeKind === "default");
		const scoped = listed.contexts.find((entry) => entry.context.scopeEntityId === initiative.id);

		expect(shared?.termCount).toBe(1);
		expect(scoped?.termCount).toBe(1);
	});

	it("builds a context directory with duplicate and conflicting-definition detection", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		await store.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Canonical order." });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Order", definition: "Payment-specific order." });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds.", avoid: ["queued run"] });

		const directory = await store.getContextDirectory();

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

	it("supports global-only and initiative-only directory search views", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		await store.defineContextTerm({ scopeRef: "default", term: "Administration", definition: "Shared admin surface." });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds." });

		const globalResult = await store.queryContextDirectory({ query: "admin", view: "global" });
		expect(globalResult.shared?.terms.map((term) => term.term)).toEqual(["Administration"]);
		expect(globalResult.initiatives).toEqual([]);
		expect(globalResult.terms.map((term) => term.term)).toEqual(["Administration"]);

		const initiativesResult = await store.queryContextDirectory({ query: "settle", view: "initiatives" });
		expect(initiativesResult.shared).toBeNull();
		expect(initiativesResult.initiatives.map((details) => details.context.scopeLabel)).toEqual(["Payments"]);
		expect(initiativesResult.terms.map((term) => term.term)).toEqual(["Settlement"]);
	});

	it("supports conflicts-only queries", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const payments = await store.createEntity({ kind: "initiative", title: "Payments" });
		const shipping = await store.createEntity({ kind: "initiative", title: "Shipping" });

		await store.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Canonical order." });
		await store.defineContextTerm({ scopeRef: payments.id, term: "Order", definition: "Payment order." });
		await store.defineContextTerm({ scopeRef: shipping.id, term: "Order", definition: "Shipping order." });
		await store.defineContextTerm({ scopeRef: payments.id, term: "Settlement", definition: "Captured funds." });

		const result = await store.queryContextDirectory({ conflictsOnly: true });

		expect(result.terms.map((term) => term.term)).toEqual(["Order"]);
		expect(result.duplicateTerms).toEqual(["Order"]);
		expect(result.terms[0]?.sources).toHaveLength(3);
	});

	it("exposes real context data in the database snapshot", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds." });

		const snapshot = await store.getDatabaseSnapshot();
		const initiativeContext = snapshot.contexts.initiatives.find((entry) => entry.context.scopeEntityId === initiative.id);

		expect(initiativeContext?.terms.map((term) => term.term)).toEqual(["Settlement"]);
	});

	it("keeps context data isolated per tenant", async () => {
		const tenantA = createTestTenantId();
		const tenantB = createTestTenantId();
		const storeA = new PgStore(appPool, tenantA);
		const storeB = new PgStore(appPool, tenantB);

		await storeA.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Tenant A's order." });

		const detailsForB = await storeB.getContextDetails();
		expect(detailsForB.terms).toHaveLength(0);

		const detailsForA = await storeA.getContextDetails();
		expect(detailsForA.terms.map((term) => term.term)).toEqual(["Order"]);
	});

	it("resolves the bare default scope to the tenant sentinel when no projectIdentity is set (no regression)", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		const details = await store.getContextDetails();
		expect(details.context.scopeKind).toBe("default");
		expect(details.context.scopeLabel).toBe("Shared");
	});

	it("resolves the bare default scope to the current project's own shared glossary when projectIdentity is set (ISS183)", async () => {
		const tenantId = createTestTenantId();
		const storeForRepoA = new PgStore(appPool, tenantId, "repo-a");
		const storeForRepoB = new PgStore(appPool, tenantId, "repo-b");

		await storeForRepoA.defineContextTerm({ term: "Order", definition: "Repo A's order." });
		await storeForRepoB.defineContextTerm({ term: "Order", definition: "Repo B's order." });

		const detailsForA = await storeForRepoA.getContextDetails();
		const detailsForB = await storeForRepoB.getContextDetails();

		expect(detailsForA.context.scopeLabel).toBe("repo-a");
		expect(detailsForA.terms.map((term) => term.definition)).toEqual(["Repo A's order."]);
		expect(detailsForB.context.scopeLabel).toBe("repo-b");
		expect(detailsForB.terms.map((term) => term.definition)).toEqual(["Repo B's order."]);
	});

	it("reuses the same project entity across calls for the same projectIdentity instead of minting a new one each time", async () => {
		const tenantId = createTestTenantId();
		const firstOpen = new PgStore(appPool, tenantId, "repo-a");
		const secondOpen = new PgStore(appPool, tenantId, "repo-a");

		const firstDetails = await firstOpen.getContextDetails();
		await secondOpen.defineContextTerm({ term: "Order", definition: "Repo A's order." });
		const secondDetails = await secondOpen.getContextDetails();

		expect(secondDetails.context.key).toBe(firstDetails.context.key);
	});
});
