import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { enableRlsPoliciesMigration } from "./0001-enable-rls-policies.js";
import { addEntityProjectIdMigration } from "./0002-add-entity-project-id.js";
import { migrateHandoffsToEntitiesMigration } from "./0003-migrate-handoffs-to-entities.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("migrateHandoffsToEntitiesMigration (ISS205)", () => {
	let adminPool: Pool;

	beforeAll(() => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
	});

	it("converts legacy handoffs into timestamp-preserving graph entities, relations, and history", async () => {
		const schemaName = `handoff_graph_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, [baselineV7Migration, enableRlsPoliciesMigration, addEntityProjectIdMigration]);
			await schemaPool.query(`
				CREATE TABLE handoffs (
					tenant_id TEXT NOT NULL,
					id TEXT NOT NULL,
					entity_id TEXT NOT NULL,
					initiative_id TEXT,
					summary TEXT NOT NULL DEFAULT '',
					body TEXT NOT NULL,
					created_at TEXT NOT NULL,
					PRIMARY KEY (tenant_id, id)
				)
			`);
			await schemaPool.query(
				`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, project_id, created_at, updated_at)
				 VALUES ('tenant-a', 'INIT1', 'initiative', 'Migration', 'active', '', 'authored', 'PROJ1', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
			);
			await schemaPool.query(
				`INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
				 VALUES ('tenant-a', 'HO4', 'INIT1', 'INIT1', '', 'Continue here.', '2024-02-03T04:05:06.000Z')`
			);

			await runMigrations(schemaPool, [migrateHandoffsToEntitiesMigration]);

			const entities = await schemaPool.query(
				`SELECT id, kind, title, body, project_id, created_at, updated_at FROM entities WHERE tenant_id = 'tenant-a' AND id = 'HO4'`
			);
			expect(entities.rows).toEqual([
				{
					id: "HO4",
					kind: "handoff",
					title: "Handoff HO4",
					body: "Continue here.",
					project_id: "PROJ1",
					created_at: "2024-02-03T04:05:06.000Z",
					updated_at: "2024-02-03T04:05:06.000Z"
				}
			]);
			const relations = await schemaPool.query(
				`SELECT from_id, to_id, type, created_at FROM relations WHERE tenant_id = 'tenant-a' AND from_id = 'HO4'`
			);
			expect(relations.rows).toEqual([
				{ from_id: "HO4", to_id: "INIT1", type: "handsOff", created_at: "2024-02-03T04:05:06.000Z" }
			]);
			const history = await schemaPool.query(
				`SELECT entity_id, title, body, created_at FROM history_entries WHERE tenant_id = 'tenant-a' AND entity_id = 'HO4'`
			);
			expect(history.rows).toEqual([
				{ entity_id: "HO4", title: "Handoff HO4", body: "Continue here.", created_at: "2024-02-03T04:05:06.000Z" }
			]);
			const counters = await schemaPool.query(`SELECT next_value FROM counters WHERE tenant_id = 'tenant-a' AND kind = 'handoff'`);
			expect(counters.rows).toEqual([{ next_value: 5 }]);
			const handoffsTable = await schemaPool.query(
				`SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'handoffs'`
			);
			expect(handoffsTable.rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});
});