import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("baselineV7Migration", () => {
	let adminPool: Pool;

	beforeAll(() => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
	});

	it("creates the entities table matching the live schema_version 7 shape on a fresh install", async () => {
		const schemaName = `baseline_v7_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, [baselineV7Migration]);

			const { rows } = await schemaPool.query(
				`SELECT column_name, data_type, is_nullable, column_default
				 FROM information_schema.columns
				 WHERE table_schema = $1 AND table_name = 'entities'
				 ORDER BY ordinal_position`,
				[schemaName]
			);

			expect(rows).toEqual([
				{ column_name: "tenant_id", data_type: "text", is_nullable: "NO", column_default: null },
				{ column_name: "id", data_type: "text", is_nullable: "NO", column_default: null },
				{ column_name: "kind", data_type: "text", is_nullable: "NO", column_default: null },
				{ column_name: "title", data_type: "text", is_nullable: "NO", column_default: null },
				{ column_name: "status", data_type: "text", is_nullable: "NO", column_default: null },
				{ column_name: "body", data_type: "text", is_nullable: "NO", column_default: "''::text" },
				{ column_name: "body_source", data_type: "text", is_nullable: "NO", column_default: "'authored'::text" },
				{ column_name: "created_at", data_type: "text", is_nullable: "NO", column_default: null },
				{ column_name: "updated_at", data_type: "text", is_nullable: "NO", column_default: null }
			]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("creates the full v7 table set and named indexes on a fresh install", async () => {
		const schemaName = `baseline_v7_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, [baselineV7Migration]);

			const { rows: tableRows } = await schemaPool.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
				[schemaName]
			);
			expect(tableRows.map((row) => row.table_name)).toEqual(
				["context_terms", "contexts", "counters", "entities", "handoffs", "history_entries", "metadata", "relations", "schema_migrations"].sort()
			);

			const { rows: indexRows } = await schemaPool.query(
				`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname NOT LIKE '%_pkey' AND indexname NOT LIKE '%_pk' ORDER BY indexname`,
				[schemaName]
			);
			expect(indexRows.map((row) => row.indexname)).toEqual([
				"context_terms_tenant_context_key_idx",
				"contexts_tenant_scope_entity_id_idx",
				"handoffs_tenant_entity_id_idx",
				"handoffs_tenant_initiative_id_idx",
				"history_entries_tenant_entity_version_idx",
				"relations_tenant_to_id_idx"
			]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("skips DDL and leaves existing rows untouched when entities already exists", async () => {
		// Scoped to a synthetic tenant_id (rather than a global COUNT(*)) so this
		// assertion can't race with other test files concurrently inserting or
		// deleting their own tenants' rows in the same shared live table.
		const tenantId = `baseline-skip-${randomUUID()}`;
		await adminPool.query(
			`INSERT INTO entities (tenant_id, id, kind, title, status, created_at, updated_at)
			 VALUES ($1, 'entity-1', 'issue', 'Existing row', 'open', now()::text, now()::text)`,
			[tenantId]
		);

		try {
			const before = await adminPool.query(`SELECT * FROM entities WHERE tenant_id = $1`, [tenantId]);

			await runMigrations(adminPool, [baselineV7Migration]);

			const after = await adminPool.query(`SELECT * FROM entities WHERE tenant_id = $1`, [tenantId]);
			expect(after.rows).toEqual(before.rows);

			const applied = await adminPool.query(`SELECT id FROM schema_migrations WHERE id = $1`, [baselineV7Migration.id]);
			expect(applied.rows).toEqual([{ id: baselineV7Migration.id }]);
		} finally {
			await adminPool.query(`DELETE FROM entities WHERE tenant_id = $1`, [tenantId]);
			await adminPool.query(`DELETE FROM schema_migrations WHERE id = $1`, [baselineV7Migration.id]);
		}
	});
});
