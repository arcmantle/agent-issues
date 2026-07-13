import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { StorageDriver } from "@agent-issues/core";
import { openSqliteStore } from "@agent-issues/api-local";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import request from "supertest";

import { createPgPool, migratePgDatabase } from "../db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "../db/test-tenant-cleanup.js";
import { createJsonRpcApp, LocalAuthProvider } from "@agent-issues/core";
import { PgStore } from "../pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// The gate always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced (Postgres superusers bypass RLS
// unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const LOCAL_AUTH_SECRET = "test-only-secret-never-used-in-production";

describe("JSON-RPC gate", () => {
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

	it("rejects a request with no Authorization header before it ever reaches PgStore", async () => {
		const response = await request(app())
			.post("/rpc")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Should not be created" } });

		expect(response.status).toBe(401);
	});

	it("rejects a request with an invalid bearer token", async () => {
		const response = await request(app())
			.post("/rpc")
			.set("authorization", "Bearer not-a-real-token")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Should not be created" } });

		expect(response.status).toBe(401);
	});

	it("creates an entity through the seam, scoped to the auth-seam-resolved tenant", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await request(app())
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Ship the gate" } });

		expect(response.status).toBe(200);
		expect(response.body.jsonrpc).toBe("2.0");
		expect(response.body.id).toBe(1);
		expect(response.body.result).toMatchObject({ kind: "initiative", title: "Ship the gate" });

		const store = new PgStore(appPool, tenantId);
		const details = await store.getEntityDetails(response.body.result.id);
		expect(details.entity.title).toBe("Ship the gate");
	});

	it("never lets a caller-supplied tenantId override the auth-seam-resolved one", async () => {
		const realTenantId = createTestTenantId();
		const spoofedTenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId: realTenantId });

		const response = await request(app())
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({
				jsonrpc: "2.0",
				id: 1,
				method: "createEntity",
				params: { kind: "initiative", title: "Attempted spoof", tenantId: spoofedTenantId }
			});

		expect(response.status).toBe(200);

		const realTenantStore = new PgStore(appPool, realTenantId);
		expect((await realTenantStore.listEntities("initiative")).map((entity) => entity.title)).toContain("Attempted spoof");

		const spoofedTenantStore = new PgStore(appPool, spoofedTenantId);
		expect((await spoofedTenantStore.listEntities("initiative")).map((entity) => entity.title)).not.toContain("Attempted spoof");
	});

	it("returns a JSON-RPC error response, not an HTTP failure, when the underlying method throws", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await request(app())
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "not-a-real-kind", title: "Bad kind" } });

		expect(response.status).toBe(200);
		expect(response.body.result).toBeUndefined();
		expect(response.body.error).toMatchObject({ code: expect.any(Number), message: expect.any(String) });
	});

	it("rejects an unknown JSON-RPC method", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await request(app())
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "notARealMethod", params: {} });

		expect(response.status).toBe(200);
		expect(response.body.error).toMatchObject({ code: -32601 });
	});

	it("rejects a malformed JSON-RPC envelope", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await request(app())
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ notJsonRpc: true });

		expect(response.status).toBe(400);
	});
});

/**
 * Proves the gate is generic over any `StorageDriver`, not hardcoded to
 * `PgStore` (ADR44's daemon work needs the exact same gate to front a
 * `SqliteStore` instead). `createStore` is called per authenticated
 * request with the resolved identity, mirroring how the Postgres-backed
 * `app()` helper above constructs `new PgStore(pool, identity.tenantId)`
 * inline today.
 */
describe("JSON-RPC gate is generic over StorageDriver", () => {
	let tempDir: string;
	let authProvider: LocalAuthProvider;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-json-rpc-app-sqlite-"));
		authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("dispatches createEntity through a SqliteStore-backed createStore factory", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const openedStores: StorageDriver[] = [];
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => {
				const { store } = await openSqliteStore(dbPath, { tenant: identity.tenantId });
				openedStores.push(store);
				return store;
			}
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Ship the daemon" } });

		expect(response.status).toBe(200);
		expect(response.body.result).toMatchObject({ kind: "initiative", title: "Ship the daemon" });

		for (const store of openedStores) {
			await store.close();
		}
	});

	it("forwards the client's project-identity header to createStore (ISS183)", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const createStore = vi.fn(async (identity: { tenantId: string }) => (await openSqliteStore(dbPath, { tenant: identity.tenantId })).store);
		const app = createJsonRpcApp({ authProvider, createStore });

		await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.set("x-agent-issues-project-identity", "repo-a")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Ship the daemon" } });

		expect(createStore).toHaveBeenCalledWith(expect.objectContaining({ tenantId }), "repo-a");
	});
});

/**
 * ADR45's build-content-hash version handshake: the daemon rejects a
 * request whose client-sent build-hash header doesn't match its own,
 * folded into the same gate layer as auth (before method dispatch), never
 * touching `createStore`/`StorageDriver` for a mismatched request. Omitted
 * entirely for the cloud gate (`versionHandshake` is optional), which has no
 * build-hash concept at all.
 */
describe("JSON-RPC gate version handshake (ISS188, ADR45)", () => {
	let tempDir: string;
	let authProvider: LocalAuthProvider;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-json-rpc-app-version-"));
		authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function tokenFor(tenantId: string): Promise<string> {
		return authProvider.issueToken({ userId: "user-1", tenantId });
	}

	it("rejects a request whose build-hash header does not match, never reaching createStore", async () => {
		const createStore = vi.fn(async (identity: { tenantId: string }) => {
			const { store } = await openSqliteStore(path.join(tempDir, "test.db"), { tenant: identity.tenantId });
			return store;
		});
		const app = createJsonRpcApp({ authProvider, createStore, versionHandshake: { buildHash: "hash-v2" } });

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v1")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Stale client" } });

		expect(response.status).toBe(409);
		expect(response.body).toMatchObject({ code: "daemon-version-mismatch", expectedBuildHash: "hash-v2", receivedBuildHash: "hash-v1" });
		expect(createStore).not.toHaveBeenCalled();
	});

	it("dispatches normally when the build-hash header matches", async () => {
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "test.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2" }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v2")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Fresh client" } });

		expect(response.status).toBe(200);
		expect(response.body.result).toMatchObject({ title: "Fresh client" });
	});

	it("calls onMismatch exactly once per mismatched request", async () => {
		const onMismatch = vi.fn();
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "test.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2", onMismatch }
		});

		await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v1")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Stale" } });

		expect(onMismatch).toHaveBeenCalledOnce();
		expect(onMismatch).toHaveBeenCalledWith({ reason: "build-hash", expectedBuildHash: "hash-v2", receivedBuildHash: "hash-v1" });
	});

	it("treats a missing build-hash header as a mismatch", async () => {
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "test.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2" }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "No header" } });

		expect(response.status).toBe(409);
		expect(response.body.receivedBuildHash).toBeUndefined();
	});
});

/**
 * The daemon-restart-on-different-db handshake: mirrors the build-hash
 * check above but keyed on the daemon's own resolved db path instead - a
 * client requesting a different `--db` than the one this daemon instance is
 * currently fronting is exactly as incompatible as a stale build, and
 * triggers the same drain-then-exit-and-respawn flow (never a silent
 * same-daemon-wrong-db routing bug).
 */
describe("JSON-RPC gate db-path handshake (ISS190)", () => {
	let tempDir: string;
	let authProvider: LocalAuthProvider;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-json-rpc-app-dbpath-"));
		authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function tokenFor(tenantId: string): Promise<string> {
		return authProvider.issueToken({ userId: "user-1", tenantId });
	}

	it("rejects a request whose db-path header does not match, never reaching createStore", async () => {
		const createStore = vi.fn(async (identity: { tenantId: string }) => {
			const { store } = await openSqliteStore(path.join(tempDir, "current.db"), { tenant: identity.tenantId });
			return store;
		});
		const app = createJsonRpcApp({
			authProvider,
			createStore,
			versionHandshake: { buildHash: "hash-v2", dbPath: path.join(tempDir, "current.db") }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v2")
			.set("x-agent-issues-db-path", path.join(tempDir, "other.db"))
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Wrong db" } });

		expect(response.status).toBe(409);
		expect(response.body).toMatchObject({
			code: "daemon-db-mismatch",
			expectedDbPath: path.join(tempDir, "current.db"),
			receivedDbPath: path.join(tempDir, "other.db")
		});
		expect(createStore).not.toHaveBeenCalled();
	});

	it("dispatches normally when the db-path header matches", async () => {
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "current.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2", dbPath: path.join(tempDir, "current.db") }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v2")
			.set("x-agent-issues-db-path", path.join(tempDir, "current.db"))
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Right db" } });

		expect(response.status).toBe(200);
		expect(response.body.result).toMatchObject({ title: "Right db" });
	});

	it("dispatches normally when the daemon has no dbPath configured (e.g. cloud gate never sets it)", async () => {
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "current.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2" }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v2")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "No dbPath configured" } });

		expect(response.status).toBe(200);
	});
});
