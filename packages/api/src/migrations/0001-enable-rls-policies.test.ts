import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { createPgMigrationConn, runMigrations } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { enableRlsPoliciesMigration } from "./0001-enable-rls-policies.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("enableRlsPoliciesMigration", () => {
	let adminPool: Pool;

	beforeAll(() => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
	});

	it("enables row level security with a tenant_isolation policy on entities", async () => {
		const schemaName = `rls_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, [baselineV7Migration, enableRlsPoliciesMigration]);

			const { rows } = await schemaPool.query(
				`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'entities' AND relnamespace = $1::regnamespace`,
				[schemaName]
			);
			expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

			const { rows: policyRows } = await schemaPool.query(
				`SELECT policyname FROM pg_policies WHERE schemaname = $1 AND tablename = 'entities'`,
				[schemaName]
			);
			expect(policyRows).toEqual([{ policyname: "tenant_isolation" }]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("enables RLS with a tenant_isolation policy on every tenant-scoped table but not metadata", async () => {
		const schemaName = `rls_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, [baselineV7Migration, enableRlsPoliciesMigration]);

			const { rows } = await schemaPool.query(
				`SELECT tablename FROM pg_policies WHERE schemaname = $1 AND policyname = 'tenant_isolation' ORDER BY tablename`,
				[schemaName]
			);
			expect(rows.map((row) => row.tablename)).toEqual(
				["context_terms", "contexts", "counters", "entities", "handoffs", "history_entries", "relations"].sort()
			);

			const { rows: metadataPolicies } = await schemaPool.query(
				`SELECT policyname FROM pg_policies WHERE schemaname = $1 AND tablename = 'metadata'`,
				[schemaName]
			);
			expect(metadataPolicies).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("re-running the migration does not error or duplicate the policy", async () => {
		const schemaName = `rls_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, [baselineV7Migration]);

			// Calling `up` twice directly (bypassing the runner's ledger skip)
			// proves the migration body itself is safe to re-run, not just that
			// the ledger prevents a second call.
			const client = await schemaPool.connect();
			try {
				const conn = createPgMigrationConn(client);
				await enableRlsPoliciesMigration.up(conn);
				await enableRlsPoliciesMigration.up(conn);
			} finally {
				client.release();
			}

			const { rows } = await schemaPool.query(
				`SELECT COUNT(*) AS count FROM pg_policies WHERE schemaname = $1 AND tablename = 'entities' AND policyname = 'tenant_isolation'`,
				[schemaName]
			);
			expect(rows[0].count).toBe("1");
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});
});
