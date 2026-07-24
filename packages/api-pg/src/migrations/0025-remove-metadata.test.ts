import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "./index.js";
import { removeMetadataMigration } from "./0025-remove-metadata.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";
const removeMetadataIndex = migrations.findIndex((migration) => migration.id === removeMetadataMigration.id);
const migrationsBeforeMetadataRemoval = migrations.slice(0, removeMetadataIndex);

let adminPool: Pool;

beforeAll(() => {
	adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
});

afterAll(async () => {
	await adminPool.end();
});

describe("metadata removal (PostgreSQL 0025)", () => {
	it("removes legacy database metadata", async () => {
		const schemaName = `remove_metadata_${randomUUID().replaceAll("-", "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
		try {
			await runMigrations(schemaPool, migrationsBeforeMetadataRemoval);
			await schemaPool.query("INSERT INTO metadata (key, value) VALUES ('schema_version', '7')");

			await runMigrations(schemaPool, [removeMetadataMigration]);

			expect((await schemaPool.query("SELECT to_regclass('metadata') AS name")).rows).toEqual([{ name: null }]);
			expect((await schemaPool.query("SELECT id FROM schema_migrations WHERE id = $1", [removeMetadataMigration.id])).rows).toEqual([
				{ id: removeMetadataMigration.id }
			]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});
});