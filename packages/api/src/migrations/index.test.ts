import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "./index.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("api migrations chain", () => {
	let adminPool: Pool;

	beforeAll(() => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
	});

	it("produces the full v7 table set, indexes, and RLS policies on a fresh install", async () => {
		const schemaName = `chain_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, migrations);

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

			const { rows: indexDefRows } = await schemaPool.query(
				`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'history_entries_tenant_entity_version_idx'`,
				[schemaName]
			);
			expect(indexDefRows[0].indexdef).not.toContain("UNIQUE");

			const { rows: policyRows } = await schemaPool.query(
				`SELECT tablename FROM pg_policies WHERE schemaname = $1 AND policyname = 'tenant_isolation' ORDER BY tablename`,
				[schemaName]
			);
			expect(policyRows.map((row) => row.tablename)).toEqual(
				["context_terms", "contexts", "counters", "entities", "handoffs", "history_entries", "relations"].sort()
			);

			const { rows: appliedRows } = await schemaPool.query(`SELECT id FROM schema_migrations ORDER BY applied_at`);
			expect(appliedRows).toEqual(migrations.map((migration) => ({ id: migration.id })));
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("carries every existing row through the full chain unchanged", async () => {
		// Uses its own isolated schema (rather than the shared live `public`
		// schema) so this assertion can't race with other test files running
		// concurrently against the same tables.
		const schemaName = `chain_unchanged_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, migrations);
			await schemaPool.query(
				`INSERT INTO entities (tenant_id, id, kind, title, status, created_at, updated_at)
				 VALUES ('tenant-a', 'entity-1', 'issue', 'Existing row', 'open', now()::text, now()::text)`
			);

			const before = await schemaPool.query(`SELECT * FROM entities`);

			await runMigrations(schemaPool, migrations);

			const after = await schemaPool.query(`SELECT * FROM entities`);
			expect(after.rows).toEqual(before.rows);

			const { rows: appliedRows } = await schemaPool.query(`SELECT id FROM schema_migrations ORDER BY applied_at`);
			expect(appliedRows).toEqual(migrations.map((migration) => ({ id: migration.id })));
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});
});
