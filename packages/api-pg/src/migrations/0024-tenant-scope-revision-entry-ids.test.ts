import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "./index.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("tenant-scoped revision entry ids (PostgreSQL 0024)", () => {
	let adminPool: Pool;

	beforeAll(() => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
	});

	it("allows a canonical revision id to exist in more than one tenant", async () => {
		const schemaName = `tenant_revision_ids_${randomUUID().replaceAll("-", "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, migrations);
			const values = ["shared-revision-id", "00000000-0000-0000-0000-000000000001", "entity", "36:00000000-0000-0000-0000-000000000002", 1, "system", 1, Buffer.alloc(0), Buffer.alloc(32), Buffer.alloc(32), "2026-01-01T00:00:00.000Z"];
			for (const tenantId of ["tenant-a", "tenant-b"]) {
				await schemaPool.query(
					`INSERT INTO revision_entries (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, created_at)
					 VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
					[values[0], tenantId, ...values.slice(1)]
				);
			}

			const rows = await schemaPool.query(`SELECT tenant_id, id FROM revision_entries ORDER BY tenant_id`);
			expect(rows.rows).toEqual([
				{ tenant_id: "tenant-a", id: "shared-revision-id" },
				{ tenant_id: "tenant-b", id: "shared-revision-id" }
			]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});
});