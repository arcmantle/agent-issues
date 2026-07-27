import { HttpStore, LocalAuthProvider, type StorageDriver } from "@agent-issues/core";
import { runStorageDriverContractSuite } from "@agent-issues/core/storage-driver-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "./db/test-tenant-cleanup.js";
import { createApiServer, type ApiServerHandle } from "./index.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

/**
 * `HttpStore` is proven the same way `PgStore` is (ISS46): the shared
 * `runStorageDriverContractSuite` behavioral contract, run here against a
 * real running JSON-RPC gate (`createApiServer`) backed by real Postgres -
 * not a mocked HTTP layer. This is the tracer bullet ISS40's remaining
 * slices (backend selection, CLI seam, site server) build on.
 */
describe("HttpStore over a real JSON-RPC gate", () => {
	let adminPool: Pool;
	let appPool: Pool;
	let authProvider: LocalAuthProvider;
	let handle: ApiServerHandle;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
		authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
		handle = createApiServer({
			authMetadata: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" },
			authProvider,
			pool: appPool,
			port: 4492
		});
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
	});

	afterAll(async () => {
		handle.server.close();
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	async function openHttpTestStore(): Promise<StorageDriver> {
		const tenantId = createTestTenantId();
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });
		return new HttpStore({ baseUrl: handle.url, bearerToken, tenantId });
	}

	// Every identity-scoped store shares one tenant, so the contract can assert
	// that two identities stay separate inside it rather than trivially passing
	// because they were in different tenants all along.
	let contractTenantId: string | undefined;
	async function openHttpTestStoreForProject(projectIdentity: string): Promise<StorageDriver> {
		contractTenantId ??= createTestTenantId();
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId: contractTenantId });
		return new HttpStore({ baseUrl: handle.url, bearerToken, tenantId: contractTenantId, projectIdentity });
	}

	beforeEach(() => {
		contractTenantId = undefined;
	});

	runStorageDriverContractSuite({
		label: "HttpStore (JSON-RPC gate over Postgres)",
		openStore: openHttpTestStore,
		openStoreForProject: openHttpTestStoreForProject
	});

	// Tenant administration is deliberately excluded from the shared contract
	// (Postgres RLS makes it structurally per-backend, see
	// storage-driver-contract.ts) so it gets its own bespoke coverage here,
	// mirroring pg-store.test.ts's "tenant administration" describe block.
	describe("tenant administration", () => {
		it("reports its own tenant summary once it has rows", async () => {
			const store = await openHttpTestStore();
			try {
				expect(await store.listTenants()).toEqual([]);

				await store.createEntity({ kind: "initiative", title: "Payments" });

				const tenants = await store.listTenants();
				expect(tenants).toHaveLength(1);
				expect(tenants[0]?.id).toBe(store.tenantId);
			} finally {
				await store.close();
			}
		});

		it("rejects deleting a different tenant, surfacing the gate's error message", async () => {
			const store = await openHttpTestStore();
			const otherTenantId = createTestTenantId();
			try {
				await expect(store.deleteTenant(otherTenantId)).rejects.toThrow(/own tenant/);
			} finally {
				await store.close();
			}
		});

		it("renames its own tenant, moving its entities to the new id", async () => {
			const store = await openHttpTestStore();
			const newTenantId = createTestTenantId();
			try {
				const previousTenantId = store.tenantId;
				const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

				const renamed = await store.renameTenant(previousTenantId, newTenantId);
				expect(renamed.newTenantId).toBe(newTenantId);

				const renamedToken = await authProvider.issueToken({ userId: "user-1", tenantId: newTenantId });
				const renamedStore = new HttpStore({ baseUrl: handle.url, bearerToken: renamedToken, tenantId: newTenantId });
				try {
					const details = await renamedStore.getEntityDetails(initiative.id);
					expect(details.entity.title).toBe("Payments");
				} finally {
					await renamedStore.close();
				}
			} finally {
				await store.close();
			}
		});
	});

	it("rejects an unauthenticated request with a thrown error", async () => {
		const store = new HttpStore({ baseUrl: handle.url, bearerToken: "not-a-real-token", tenantId: createTestTenantId() });

		await expect(store.listEntities("initiative")).rejects.toThrow();
	});
});
