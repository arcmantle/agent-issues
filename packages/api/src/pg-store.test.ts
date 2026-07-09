import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./db/connection.js";
import { PgStore } from "./pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced in tests (Postgres superusers bypass
// RLS unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

describe("PgStore entity lifecycle", () => {
	let adminPool: Pool;
	let appPool: Pool;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
		await appPool.end();
	});

	it("creates a parent-less initiative under the auto-bootstrapped EPIC0 sentinel", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);

		const entity = await store.createEntity({ kind: "initiative", title: "Ship the Postgres gate" });

		expect(entity.id).toBe("INIT1");
		expect(entity.kind).toBe("initiative");
		expect(entity.title).toBe("Ship the Postgres gate");
		expect(entity.status).toBe("draft");

		const details = await store.getEntityDetails(entity.id);
		expect(details.incoming).toEqual([{ relationType: "contains", entity: expect.objectContaining({ id: "EPIC0" }) }]);

		const history = await store.listEntityHistory(entity.id);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			version: 1,
			author: "system",
			title: "Ship the Postgres gate",
			status: "draft",
			parentId: "EPIC0"
		});
	});

	it("lists entities of a kind and records an explicit author on the history entry", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);

		await store.createEntity({ kind: "initiative", title: "First", author: "alice" });
		await store.createEntity({ kind: "initiative", title: "Second" });

		const initiatives = await store.listEntities("initiative");
		expect(initiatives.map((entity) => entity.title)).toEqual(["First", "Second"]);

		const history = await store.listEntityHistory(initiatives[0]!.id);
		expect(history[0]?.author).toBe("alice");
	});

	it("keeps tenants isolated even for a query the app layer forgets to filter by tenant_id", async () => {
		const tenantA = `tenant-${randomUUID()}`;
		const tenantB = `tenant-${randomUUID()}`;
		const storeA = new PgStore(appPool, tenantA);
		const storeB = new PgStore(appPool, tenantB);

		await storeA.createEntity({ kind: "initiative", title: "Tenant A's secret initiative" });
		await storeB.createEntity({ kind: "initiative", title: "Tenant B's secret initiative" });

		// Deliberately a raw, tenant-unfiltered query - the same query shape an
		// app-layer bug could produce. RLS (ADR9, the 0001 migration) must be
		// the backstop that blocks cross-tenant rows even so.
		const client = await appPool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
			const result = await client.query("SELECT title FROM entities WHERE kind = 'initiative'");
			expect(result.rows.map((row: { title: string }) => row.title)).toEqual(["Tenant A's secret initiative"]);
			await client.query("COMMIT");
		} finally {
			client.release();
		}
	});
});
