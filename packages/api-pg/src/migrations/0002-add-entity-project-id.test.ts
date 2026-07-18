import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { enableRlsPoliciesMigration } from "./0001-enable-rls-policies.js";
import { addEntityProjectIdMigration } from "./0002-add-entity-project-id.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("addEntityProjectIdMigration", () => {
	let adminPool: Pool;

	beforeAll(() => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
	});

	it("backfills project ownership for pre-existing records after RLS is enabled", async () => {
		const schemaName = `project_id_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, [baselineV7Migration, enableRlsPoliciesMigration]);
			await schemaPool.query(
				`INSERT INTO entities (tenant_id, id, kind, title, status, created_at, updated_at)
				 VALUES
				 ('tenant-a', 'PROJ1', 'project', 'Project', 'active', now()::text, now()::text),
				 ('tenant-a', 'EPIC1', 'epic', 'Epic', 'active', now()::text, now()::text),
				 ('tenant-a', 'INIT1', 'initiative', 'Initiative', 'draft', now()::text, now()::text),
				 ('tenant-a', 'ADR1', 'adr', 'Decision', 'draft', now()::text, now()::text)`
			);
			await schemaPool.query(
				`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
				 VALUES
				 ('tenant-a', 'PROJ1', 'EPIC1', 'contains', now()::text),
				 ('tenant-a', 'EPIC1', 'INIT1', 'contains', now()::text),
				 ('tenant-a', 'INIT1', 'ADR1', 'tracks', now()::text)`
			);

			await runMigrations(schemaPool, [addEntityProjectIdMigration]);

			const { rows } = await schemaPool.query(
				`SELECT id, project_id FROM entities WHERE tenant_id = 'tenant-a' ORDER BY id`
			);
			expect(rows).toEqual([
				{ id: "ADR1", project_id: "PROJ1" },
				{ id: "EPIC1", project_id: "PROJ1" },
				{ id: "INIT1", project_id: "PROJ1" },
				{ id: "PROJ1", project_id: "PROJ1" }
			]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});
});