import { randomUUID } from "node:crypto";

import type { StorageDriver } from "@agent-issues/core";
import { runStorageDriverContractSuite } from "@agent-issues/core/storage-driver-contract";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "./db/test-tenant-cleanup.js";
import { PgStore } from "./pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced (Postgres superusers bypass RLS
// unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const schemaName = `storage_contract_${randomUUID().replace(/-/g, "_")}`;
const schemaOptions = `-c search_path=${schemaName}`;
let adminPool: Pool;

beforeAll(async () => {
	adminPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: schemaOptions });
	const databasePool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	try {
		await databasePool.query(`CREATE SCHEMA ${schemaName}`);
		await migratePgDatabase(adminPool);
		await databasePool.query(`GRANT USAGE ON SCHEMA ${schemaName} TO agent_issues_app`);
		await databasePool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaName} TO agent_issues_app`);
	} finally {
		await databasePool.end();
	}
});

afterAll(async () => {
	try {
		await cleanupTestTenants(adminPool);
	} finally {
		await adminPool.end();
		const databasePool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		try {
			await databasePool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		} finally {
			await databasePool.end();
		}
	}
});

// Every store in this suite gets its own dedicated pool (rather than the
// single shared `appPool` `pg-store.test.ts` uses) because `PgStore.close()`
// ends the whole pool it was given, and the shared contract's lifecycle
// test deliberately calls `close()` and expects only that one store's
// connection to be gone. Each contract test closes its own store (and thus
// its own pool) in a `finally`, so no extra teardown is needed here.
async function openPgTestStore(): Promise<StorageDriver> {
	const pool = new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions });
	return new PgStore(pool, createTestTenantId());
}

// Shares one tenant across the identities a single contract test opens, so
// the separation it asserts is genuinely project-level and not tenant-level.
let contractTenantId: string | undefined;
async function openPgTestStoreForProject(projectIdentity: string): Promise<StorageDriver> {
	contractTenantId ??= createTestTenantId();
	const pool = new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions });
	return new PgStore(pool, contractTenantId, projectIdentity);
}

beforeEach(() => {
	contractTenantId = undefined;
});

runStorageDriverContractSuite({
	label: "PgStore (Postgres)",
	openStore: openPgTestStore,
	openStoreForProject: openPgTestStoreForProject
});
