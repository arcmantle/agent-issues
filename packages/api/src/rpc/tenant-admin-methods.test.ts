import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import request from "supertest";

import { createPgPool, migratePgDatabase } from "../db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "../db/test-tenant-cleanup.js";
import { LocalAuthProvider } from "../auth/local-auth-provider.js";
import { PgStore } from "../pg-store.js";
import { createJsonRpcApp } from "./create-json-rpc-app.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const LOCAL_AUTH_SECRET = "test-only-secret-never-used-in-production";

/**
 * ISS52 mechanically extends the ISS49 tracer bullet's dispatcher to cover
 * the tenant-administration `StorageDriver` methods. Beyond proving each
 * method is reachable through the gate, this suite also proves ISS46's
 * `requireOwnTenant` guard is reachable and effective through the gate
 * itself (not just in a direct `PgStore` unit test) - a caller can never
 * delete or rename a tenant other than the auth-seam-resolved one.
 */
describe("JSON-RPC gate: tenant-administration methods", () => {
	let adminPool: Pool;
	let appPool: Pool;
	let authProvider: LocalAuthProvider;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
		authProvider = new LocalAuthProvider({ secret: LOCAL_AUTH_SECRET });
	});

	afterAll(async () => {
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	function app() {
		return createJsonRpcApp({ authProvider, createStore: (identity) => new PgStore(appPool, identity.tenantId) });
	}

	async function tenantAndToken() {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		return { tenantId, token };
	}

	async function call(token: string, method: string, params?: unknown) {
		const response = await request(app())
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method, params: params ?? {} });
		return response.body;
	}

	it("listTenants reports the auth-seam-resolved tenant's own summary", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		await store.createEntity({ kind: "initiative", title: "Payments" });

		const body = await call(token, "listTenants");
		expect(body.error).toBeUndefined();
		expect(body.result.map((tenant: { id: string }) => tenant.id)).toEqual([tenantId]);
	});

	it("deleteTenant removes the auth-seam-resolved tenant's own data", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		await store.createEntity({ kind: "initiative", title: "Payments" });

		const body = await call(token, "deleteTenant", { tenantId });
		expect(body.error).toBeUndefined();
		expect(body.result.removed).toBe(true);
		expect(await store.listTenants()).toEqual([]);
	});

	it("rejects a request attempting to delete a tenant other than the auth-seam-resolved one", async () => {
		const { token } = await tenantAndToken();
		const otherTenantId = createTestTenantId();

		const body = await call(token, "deleteTenant", { tenantId: otherTenantId });
		expect(body.error).toMatchObject({ code: expect.any(Number), message: expect.stringMatching(/own tenant/) });
	});

	it("renameTenant moves the auth-seam-resolved tenant's own data to the new id", async () => {
		const { tenantId: previousTenantId, token } = await tenantAndToken();
		const newTenantId = createTestTenantId();
		const store = new PgStore(appPool, previousTenantId);
		await store.createEntity({ kind: "initiative", title: "Payments" });

		const body = await call(token, "renameTenant", { previousTenantId, newTenantId });
		expect(body.error).toBeUndefined();
		expect(body.result.renamed).toBe(true);
		expect(body.result.newTenantId).toBe(newTenantId);

		const renamedStore = new PgStore(appPool, newTenantId);
		expect((await renamedStore.listTenants()).map((tenant) => tenant.id)).toEqual([newTenantId]);
	});

	it("rejects a request attempting to rename a tenant other than the auth-seam-resolved one", async () => {
		const { token } = await tenantAndToken();
		const otherTenantId = createTestTenantId();
		const newTenantId = createTestTenantId();

		const body = await call(token, "renameTenant", { previousTenantId: otherTenantId, newTenantId });
		expect(body.error).toMatchObject({ code: expect.any(Number), message: expect.stringMatching(/own tenant/) });
	});
});
