import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { PgStore } from "../pg-store.js";
import { migrations } from "./index.js";
import { removeHistoryEntriesMigration } from "./0023-remove-history-entries.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";
const removeHistoryMigrationIndex = migrations.findIndex((migration) => migration.id === removeHistoryEntriesMigration.id);
const migrationsBeforeRemoveHistory = migrations.slice(0, removeHistoryMigrationIndex);

async function withSchema(run: (pool: Pool, schemaName: string) => Promise<void>): Promise<void> {
	const schemaName = `remove_history_${randomUUID().replaceAll("-", "_")}`;
	await adminPool.query(`CREATE SCHEMA ${schemaName}`);
	const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName} -c timezone=UTC` });
	try {
		await run(schemaPool, schemaName);
	} finally {
		await schemaPool.end();
		await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
	}
}

let adminPool: Pool;

beforeAll(() => {
	adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
});

afterAll(async () => {
	await adminPool.end();
});

describe("history snapshot removal (PostgreSQL 0023)", () => {
	it("removes the empty history table and its policy on a fresh schema", async () => {
		await withSchema(async (schemaPool, schemaName) => {
			await runMigrations(schemaPool, migrations);
			expect((await schemaPool.query("SELECT to_regclass('history_entries') AS name")).rows).toEqual([{ name: null }]);
			expect((await schemaPool.query("SELECT id FROM schema_migrations WHERE id = '0023-remove-history-entries'")).rows).toEqual([
				{ id: "0023-remove-history-entries" }
			]);
			expect((await schemaPool.query("SELECT tablename FROM pg_policies WHERE schemaname = $1 AND tablename = 'history_entries'", [schemaName])).rows).toEqual([]);
		});
	});

	it("retains history_entries transactionally when validation fails", async () => {
		await withSchema(async (schemaPool) => {
			await runMigrations(schemaPool, migrationsBeforeRemoveHistory);
			await schemaPool.query(`INSERT INTO history_entries
				(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
				VALUES ('orphan', 'tenant-a', '00000000-0000-0000-0000-000000000099', 1, 'system', 'Orphan', '', 'authored', 'todo', NULL, '2026-01-01T00:00:00.000Z')`);

			await expect(runMigrations(schemaPool, [removeHistoryEntriesMigration])).rejects.toThrow(/orphan history snapshots/);
			expect((await schemaPool.query("SELECT to_regclass('history_entries') AS name")).rows[0]?.name).not.toBeNull();
			expect((await schemaPool.query("SELECT id FROM schema_migrations WHERE id = '0023-remove-history-entries'")).rows).toEqual([]);
		});
	});

	it("recovers a missing revision-1 baseline before removing snapshots", async () => {
		await withSchema(async (schemaPool) => {
			await runMigrations(schemaPool, migrationsBeforeRemoveHistory);
			const tenantId = `baseline-${randomUUID()}`;
			const store = new PgStore(schemaPool, tenantId);
			const created = await store.createEntity({ kind: "issue", title: "Original", body: "Body", author: "alice" });
			await store.updateEntityStatus({ entityId: created.id, status: "in-progress", author: "bob" });
			const ledger = (await schemaPool.query(`SELECT id, revision, author, created_at
				FROM revision_entries WHERE tenant_id = $1 AND record_kind = 'entity' AND record_key = $2 ORDER BY revision`,
			[tenantId, `36:${created.id}`])).rows as Array<{ id: string; revision: number; author: string; created_at: string }>;
			for (const entry of ledger) {
				await schemaPool.query(`INSERT INTO history_entries
					(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
					VALUES ($1, $2, $3::uuid, $4, $5, 'Original', 'Body', 'authored', $6, NULL, $7)`,
				[entry.id, tenantId, created.id, entry.revision, entry.author, entry.revision === 1 ? "todo" : "in-progress", entry.created_at]);
			}
			await schemaPool.query("DELETE FROM revision_entries WHERE tenant_id = $1 AND record_kind = 'entity' AND revision = 1", [tenantId]);

			await runMigrations(schemaPool, [removeHistoryEntriesMigration]);

			expect((await schemaPool.query("SELECT to_regclass('history_entries') AS name")).rows).toEqual([{ name: null }]);
			expect((await schemaPool.query(`SELECT id, revision, author, created_at, octet_length(reverse_patch) AS patch_bytes
				FROM revision_entries WHERE tenant_id = $1 AND record_kind = 'entity' AND revision = 1`, [tenantId])).rows).toEqual([{
				author: "alice",
				created_at: ledger[0]!.created_at,
				id: ledger[0]!.id,
				patch_bytes: 0,
				revision: 1
			}]);
		});
	});
});
