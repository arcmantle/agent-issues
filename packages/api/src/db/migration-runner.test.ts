import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "./connection.js";
import type { Migration } from "./migration-runner.js";
import { runMigrations } from "./migration-runner.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("runMigrations (Postgres)", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await pool.end();
	});

	it("applies an unapplied migration once and records it in the ledger", async () => {
		const tableName = `widgets_${randomUUID().replace(/-/g, "_")}`;
		const migrationId = `test-${randomUUID()}`;
		let runCount = 0;
		const migrations: Migration[] = [
			{
				id: migrationId,
				up: async (conn) => {
					await conn.run(sql.raw(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`));
					runCount += 1;
				}
			}
		];

		try {
			await runMigrations(pool, migrations);
			await runMigrations(pool, migrations);

			expect(runCount).toBe(1);
			const { rows } = await pool.query(`SELECT id FROM schema_migrations WHERE id = $1`, [migrationId]);
			expect(rows).toEqual([{ id: migrationId }]);
		} finally {
			await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
			await pool.query(`DELETE FROM schema_migrations WHERE id = $1`, [migrationId]);
		}
	});

	it("rolls back a failing migration and leaves it unrecorded so it retries next run", async () => {
		const tableName = `gadgets_${randomUUID().replace(/-/g, "_")}`;
		const migrationId = `test-${randomUUID()}`;
		const migrations: Migration[] = [
			{
				id: migrationId,
				up: async (conn) => {
					await conn.run(sql.raw(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`));
					throw new Error("boom");
				}
			}
		];

		try {
			await expect(runMigrations(pool, migrations)).rejects.toThrow("boom");

			const { rows: tableRows } = await pool.query(
				`SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
				[tableName]
			);
			expect(tableRows).toEqual([]);

			const { rows: ledgerRows } = await pool.query(`SELECT id FROM schema_migrations WHERE id = $1`, [migrationId]);
			expect(ledgerRows).toEqual([]);
		} finally {
			await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
			await pool.query(`DELETE FROM schema_migrations WHERE id = $1`, [migrationId]);
		}
	});

	it("applies only the new migrations, in order, when the module list grows", async () => {
		const firstTable = `widgets_${randomUUID().replace(/-/g, "_")}`;
		const secondTable = `gizmos_${randomUUID().replace(/-/g, "_")}`;
		const firstId = `test-${randomUUID()}`;
		const secondId = `test-${randomUUID()}`;
		const applied: string[] = [];
		const firstBatch: Migration[] = [
			{
				id: firstId,
				up: async (conn) => {
					await conn.run(sql.raw(`CREATE TABLE ${firstTable} (id TEXT PRIMARY KEY)`));
					applied.push(firstId);
				}
			}
		];

		try {
			await runMigrations(pool, firstBatch);

			const secondBatch: Migration[] = [
				...firstBatch,
				{
					id: secondId,
					up: async (conn) => {
						await conn.run(sql.raw(`CREATE TABLE ${secondTable} (id TEXT PRIMARY KEY)`));
						applied.push(secondId);
					}
				}
			];

			await runMigrations(pool, secondBatch);

			expect(applied).toEqual([firstId, secondId]);
		} finally {
			await pool.query(`DROP TABLE IF EXISTS ${firstTable}`);
			await pool.query(`DROP TABLE IF EXISTS ${secondTable}`);
			await pool.query(`DELETE FROM schema_migrations WHERE id = ANY($1)`, [[firstId, secondId]]);
		}
	});
});
