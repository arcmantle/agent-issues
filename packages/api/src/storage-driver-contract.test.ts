import type { StorageDriver } from "@agent-issues/core";
import { runStorageDriverContractSuite } from "@agent-issues/core/storage-driver-contract";
import { afterAll } from "vitest";

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

let migrationsApplied: Promise<void> | null = null;

// Migrations only need to run once per test run; every other `openStore`
// call reuses the already-migrated database.
function ensureMigrated(): Promise<void> {
	migrationsApplied ??= (async () => {
		const adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		try {
			await migratePgDatabase(adminPool);
		} finally {
			await adminPool.end();
		}
	})();

	return migrationsApplied;
}

afterAll(async () => {
	const adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	try {
		await cleanupTestTenants(adminPool);
	} finally {
		await adminPool.end();
	}
});

// Every store in this suite gets its own dedicated pool (rather than the
// single shared `appPool` `pg-store.test.ts` uses) because `PgStore.close()`
// ends the whole pool it was given, and the shared contract's lifecycle
// test deliberately calls `close()` and expects only that one store's
// connection to be gone. Each contract test closes its own store (and thus
// its own pool) in a `finally`, so no extra teardown is needed here.
async function openPgTestStore(): Promise<StorageDriver> {
	await ensureMigrated();
	const pool = createPgPool({ connectionString: APP_CONNECTION_STRING });
	return new PgStore(pool, createTestTenantId());
}

runStorageDriverContractSuite({ label: "PgStore (Postgres)", openStore: openPgTestStore });
