import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./connection.js";
import { cleanupTestTenants, createTestTenantId } from "./test-tenant-cleanup.js";
import { PgStore } from "../pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced in tests (Postgres superusers bypass
// RLS unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

// RLS (ADR9) makes every PgStore instance's own tenant the only one it can
// ever see or touch, so - unlike SqliteStore's single-file, cross-tenant
// admin view - these methods only ever report on or act on `this.tenantId`.
describe("tenant administration", () => {
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

	it("reports no tenants until the tenant has rows, then its own summary", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		expect(await store.listTenants()).toEqual([]);

		await store.createEntity({ kind: "initiative", title: "Payments" });

		const tenants = await store.listTenants();
		expect(tenants).toHaveLength(1);
		expect(tenants[0]?.id).toBe(tenantId);
		expect(tenants[0]?.counts.entities).toBeGreaterThan(0);
	});

	it("never lists a sibling tenant's summary", async () => {
		const tenantA = createTestTenantId();
		const tenantB = createTestTenantId();
		const storeA = new PgStore(appPool, tenantA);
		const storeB = new PgStore(appPool, tenantB);

		await storeA.createEntity({ kind: "initiative", title: "Tenant A's initiative" });
		await storeB.createEntity({ kind: "initiative", title: "Tenant B's initiative" });

		expect((await storeA.listTenants()).map((tenant) => tenant.id)).toEqual([tenantA]);
		expect((await storeB.listTenants()).map((tenant) => tenant.id)).toEqual([tenantB]);
	});

	it("deletes the tenant's own data and reports what was removed", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Order", definition: "Canonical order." });
		await store.createHandoff({ entityId: initiative.id, body: "Handoff body." });

		const result = await store.deleteTenant(tenantId);

		expect(result.removed).toBe(true);
		expect(result.counts.entities).toBeGreaterThan(0);
		expect(result.counts.contextTerms).toBe(1);
		expect(result.counts.handoffs).toBe(1);
		expect(await store.listTenants()).toEqual([]);
		await expect(store.getEntityDetails(initiative.id)).rejects.toThrow();
	});

	it("rejects deleting a different tenant", async () => {
		const tenantId = createTestTenantId();
		const otherTenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		await expect(store.deleteTenant(otherTenantId)).rejects.toThrow(/own tenant/);
	});

	it("renames the tenant, moving entities, contexts, and handoffs to the new id", async () => {
		const previousTenantId = createTestTenantId();
		const newTenantId = createTestTenantId();
		const store = new PgStore(appPool, previousTenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Order", definition: "Canonical order." });
		await store.createHandoff({ entityId: initiative.id, body: "Handoff body." });

		const result = await store.renameTenant(previousTenantId, newTenantId);

		expect(result.renamed).toBe(true);
		expect(result.newTenantId).toBe(newTenantId);
		expect(result.previousTenantId).toBe(previousTenantId);

		const renamedStore = new PgStore(appPool, newTenantId);
		const details = await renamedStore.getEntityDetails(initiative.id);
		expect(details.entity.title).toBe("Payments");
		const context = await renamedStore.getContextDetails({ scopeRef: initiative.id });
		expect(context.terms.map((term) => term.term)).toEqual(["Order"]);
		const handoffs = await renamedStore.listHandoffs({ entityId: initiative.id });
		expect(handoffs).toHaveLength(1);

		expect(await store.listTenants()).toEqual([]);
	});

	it("returns renamed:false without changing anything when the tenant has no rows", async () => {
		const previousTenantId = createTestTenantId();
		const newTenantId = createTestTenantId();
		const store = new PgStore(appPool, previousTenantId);

		const result = await store.renameTenant(previousTenantId, newTenantId);

		expect(result.renamed).toBe(false);
		expect(await new PgStore(appPool, newTenantId).listTenants()).toEqual([]);
	});

	it("rejects renaming a different tenant", async () => {
		const tenantId = createTestTenantId();
		const otherTenantId = createTestTenantId();
		const newTenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		await expect(store.renameTenant(otherTenantId, newTenantId)).rejects.toThrow(/own tenant/);
	});

	it("rejects renaming a tenant onto itself", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		await expect(store.renameTenant(tenantId, tenantId)).rejects.toThrow(/same/);
	});

	it("rejects renaming onto a tenant that already has rows", async () => {
		const previousTenantId = createTestTenantId();
		const newTenantId = createTestTenantId();
		const store = new PgStore(appPool, previousTenantId);
		await store.createEntity({ kind: "initiative", title: "Payments" });
		const targetStore = new PgStore(appPool, newTenantId);
		await targetStore.createEntity({ kind: "initiative", title: "Already here" });

		await expect(store.renameTenant(previousTenantId, newTenantId)).rejects.toThrow(/already exists/);
	});
});
