import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "./index.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";
const renameMigrationIndex = migrations.findIndex((migration) => migration.id === "0022-rename-revision-entries");
const migrationsBeforeRename = migrations.slice(0, renameMigrationIndex);
const migrationsThroughRename = migrations.slice(0, renameMigrationIndex + 1);

describe("revision-entries rename (PostgreSQL 0022)", () => {
	let adminPool: Pool;

	beforeAll(() => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
	});

	it("renames revision_patch_entries to revision_entries preserving all rows", async () => {
		const schemaName = `rename_re_${randomUUID().replaceAll("-", "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName} -c timezone=UTC` });

		try {
			// Run all migrations up to (but not including) the rename.
			await runMigrations(schemaPool, migrationsBeforeRename);

			// Seed a test row
			const sourceHash = Buffer.alloc(32, 0x01);
			const targetHash = Buffer.alloc(32, 0x02);
			await schemaPool.query(
				`INSERT INTO revision_patch_entries
					(id, tenant_id, project_id, record_kind, record_key, revision, author,
					 patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
				VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
				[
					"row-1",
					"tenant-a",
					"00000000-0000-0000-0000-000000000001",
					"entity",
					"4:ISS1",
					1,
					"tester",
					1,
					Buffer.from([0x01, 0x02]),
					sourceHash,
					targetHash,
					null,
					"2026-01-01T00:00:00.000Z"
				]
			);

			const rowsBefore = await schemaPool.query(`SELECT * FROM revision_patch_entries ORDER BY id`);
			expect(rowsBefore.rows).toHaveLength(1);

			// Apply the rename while the legacy history table still exists.
			await runMigrations(schemaPool, migrationsThroughRename);

			// Old table must be absent
			const oldTable = await schemaPool.query(`SELECT to_regclass('revision_patch_entries') AS name`);
			expect(oldTable.rows).toEqual([{ name: null }]);

			// New table must be present
			const newTable = await schemaPool.query(`SELECT to_regclass('revision_entries') AS name`);
			expect(newTable.rows[0].name).not.toBeNull();

			// Row-for-row equality
			const rowsAfter = await schemaPool.query(`SELECT * FROM revision_entries ORDER BY id`);
			expect(rowsAfter.rows).toEqual(rowsBefore.rows);

			// New index names present
			const { rows: indexRows } = await schemaPool.query(
				`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'revision_entries' ORDER BY indexname`,
				[schemaName]
			);
			const indexNames = indexRows.map((row) => row.indexname as string);
			expect(indexNames).toContain("revision_entries_project_idx");
			expect(indexNames).toContain("revision_entries_chain_idx");

			// Old index names absent
			const { rows: oldIndexRows } = await schemaPool.query(
				`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE 'revision_patch_entries_%'`,
				[schemaName]
			);
			expect(oldIndexRows).toHaveLength(0);

			// RLS policy still present on the renamed table
			const { rows: policyRows } = await schemaPool.query(
				`SELECT tablename FROM pg_policies WHERE schemaname = $1 AND policyname = 'tenant_isolation' AND tablename = 'revision_entries'`,
				[schemaName]
			);
			expect(policyRows).toHaveLength(1);

			// Constraints carry new names
			const { rows: constraintRows } = await schemaPool.query(
				`SELECT conname FROM pg_constraint WHERE conrelid = ($1 || '.revision_entries')::regclass ORDER BY conname`,
				[schemaName]
			);
			const constraintNames = constraintRows.map((row) => row.conname as string);
			expect(constraintNames).toContain("revision_entries_pkey");
			expect(constraintNames).toContain("revision_entries_chain_idx");
			expect(constraintNames).toContain("revision_entries_source_hash_length");
			expect(constraintNames).toContain("revision_entries_target_hash_length");
			expect(constraintNames.every((n) => !n.startsWith("revision_patch_entries_"))).toBe(true);

			// Migration recorded in ledger
			const { rows: appliedRows } = await schemaPool.query(
				`SELECT id FROM schema_migrations WHERE id = '0022-rename-revision-entries'`
			);
			expect(appliedRows).toEqual([{ id: "0022-rename-revision-entries" }]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("migrates successfully when revision_patch_entries has no rows", async () => {
		const schemaName = `rename_re_empty_${randomUUID().replaceAll("-", "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName} -c timezone=UTC` });

		try {
			await runMigrations(schemaPool, migrationsBeforeRename);
			await runMigrations(schemaPool, migrationsThroughRename);

			const oldTable = await schemaPool.query(`SELECT to_regclass('revision_patch_entries') AS name`);
			expect(oldTable.rows).toEqual([{ name: null }]);

			const newTable = await schemaPool.query(`SELECT to_regclass('revision_entries') AS name`);
			expect(newTable.rows[0].name).not.toBeNull();
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("is idempotent when run twice", async () => {
		const schemaName = `rename_re_idempotent_${randomUUID().replaceAll("-", "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName} -c timezone=UTC` });

		try {
			await runMigrations(schemaPool, migrations);
			await runMigrations(schemaPool, migrations);

			const oldTable = await schemaPool.query(`SELECT to_regclass('revision_patch_entries') AS name`);
			expect(oldTable.rows).toEqual([{ name: null }]);
			const newTable = await schemaPool.query(`SELECT to_regclass('revision_entries') AS name`);
			expect(newTable.rows[0].name).not.toBeNull();
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});
});
