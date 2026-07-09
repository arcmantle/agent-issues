import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPgPool, migratePgDatabase, withTenantTransaction } from "./connection.js";

const CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("Postgres connection + migration bootstrap", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = createPgPool({ connectionString: CONNECTION_STRING });
		await migratePgDatabase(pool);
	});

	afterAll(async () => {
		await pool.end();
	});

	it("runs migrations and scopes a transaction to a tenant via SET LOCAL app.tenant_id", async () => {
		const tenantId = await withTenantTransaction(pool, "tenant-connection-test", async (client) => {
			const result = await client.query("SELECT current_setting('app.tenant_id', true) AS tenant_id");
			return result.rows[0]?.tenant_id as string;
		});

		expect(tenantId).toBe("tenant-connection-test");
	});
});
