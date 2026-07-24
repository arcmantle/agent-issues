import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "../db/connection.js";
import { createPgMigrationConn, runMigrations } from "../db/migration-runner.js";
import { PgStore } from "../pg-store.js";
import { contextRevisionDeltaMigration } from "./0008-context-revision-delta.js";
import { contextTermRevisionDeltaMigration } from "./0009-context-term-revision-delta.js";
import { historyEntriesToDeltasMigration } from "./0007-history-entries-to-deltas.js";
import { entityRestorationSourceMigration } from "./0010-entity-restoration-source.js";
import { contextRestorationSourceMigration } from "./0011-context-restoration-source.js";
import { contextRevisionBaselinesMigration } from "./0012-context-revision-baselines.js";
import { compactReverseFieldPatchesMigration } from "./0013-compact-reverse-field-patches.js";
import { revisionPatchLedgerMigration } from "./0014-revision-patch-ledger.js";
import { binaryRevisionPatchHashesMigration } from "./0015-binary-revision-patch-hashes.js";
import { contextTermStableIdsMigration } from "./0016-context-term-stable-ids.js";
import { deriveMigratedContextTermId, deriveMigratedEntityIdentity } from "@agent-issues/core";
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
				["context_terms", "contexts", "counters", "entities", "relations", "revision_entries", "schema_migrations"].sort()
			);

			const { rows: indexRows } = await schemaPool.query(
				`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname NOT LIKE '%_pkey' AND indexname NOT LIKE '%_pk' ORDER BY indexname`,
				[schemaName]
			);
			expect(indexRows.map((row) => row.indexname)).toEqual([
				"context_terms_tenant_context_key_idx",
				"context_terms_tenant_id_idx",
				"contexts_tenant_id_idx",
				"contexts_tenant_reference_idx",
				"contexts_tenant_scope_entity_id_idx",
				"entities_tenant_reference_idx",
				"relations_tenant_to_id_idx",
				"revision_entries_chain_idx",
				"revision_entries_project_idx"
			]);

			const { rows: policyRows } = await schemaPool.query(
				`SELECT tablename FROM pg_policies WHERE schemaname = $1 AND policyname = 'tenant_isolation' ORDER BY tablename`,
				[schemaName]
			);
			expect(policyRows.map((row) => row.tablename)).toEqual(
				["context_terms", "contexts", "counters", "entities", "relations", "revision_entries"].sort()
			);

			const { rows: columnRows } = await schemaPool.query(
				`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'revision_entries'`,
				[schemaName]
			);
			const columns = columnRows.map((row) => row.column_name as string);
			expect(columns).toEqual(expect.arrayContaining(["project_id", "record_kind", "record_key", "patch_format", "reverse_patch", "source_hash", "target_hash"]));
			expect(columnRows.find((row) => row.column_name === "source_hash")?.data_type).toBe("bytea");
			expect(columnRows.find((row) => row.column_name === "target_hash")?.data_type).toBe("bytea");
			const { rows: constraintRows } = await schemaPool.query(
				`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`,
				[`${schemaName}.revision_entries`]
			);
			expect(constraintRows.map((row) => row.definition).join(" ")).toContain("octet_length(source_hash) = 32");
			expect(constraintRows.map((row) => row.definition).join(" ")).toContain("octet_length(target_hash) = 32");

			const { rows: appliedRows } = await schemaPool.query(`SELECT id FROM schema_migrations ORDER BY applied_at`);
			expect(appliedRows).toEqual(migrations.map((migration) => ({ id: migration.id })));

			const { rows: identityColumns } = await schemaPool.query(
				`SELECT table_name, column_name, data_type FROM information_schema.columns
					WHERE table_schema = $1 AND table_name IN ('entities', 'relations', 'contexts', 'revision_entries')`,
				[schemaName]
			);
			const columnType = (tableName: string, columnName: string) => identityColumns.find((column) => column.table_name === tableName && column.column_name === columnName)?.data_type;
			expect(columnType("entities", "id")).toBe("uuid");
			expect(columnType("entities", "reference")).toBe("text");
			expect(columnType("relations", "from_id")).toBe("uuid");
			expect(columnType("contexts", "id")).toBe("uuid");
			expect(columnType("contexts", "reference")).toBe("text");
			expect(columnType("revision_entries", "project_id")).toBe("uuid");
			expect(identityColumns.some((column) => column.column_name === "stable_id" || column.column_name === "entity_stable_id")).toBe(false);
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
			const identity = deriveMigratedEntityIdentity("issue", "ISS1");
			await schemaPool.query(
				`INSERT INTO entities (tenant_id, id, reference, kind, title, status, created_at, updated_at)
				 VALUES ('tenant-a', $1::uuid, $2, 'issue', 'Existing row', 'todo', now()::text, now()::text)`,
				[identity.stableId, identity.reference]
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

	it("seeds one replay-safe revision baseline for every existing context and term", async () => {
		const schemaName = `chain_context_baselines_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
		const priorMigrations = migrations.slice(0, migrations.findIndex((migration) => migration.id === contextRevisionDeltaMigration.id));

		try {
			await runMigrations(schemaPool, priorMigrations);
			await schemaPool.query(`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
				VALUES ('tenant-a', 'default', NULL, 'Current title', 'Current summary.', '2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z')`);
			await schemaPool.query(`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
				VALUES ('tenant-a', 'default', 'Order', 'Current definition.', '["purchase"]', '2024-01-02T00:00:00.000Z', '2024-02-02T00:00:00.000Z')`);
			const contextsBefore = await schemaPool.query(`SELECT tenant_id, key, scope_entity_id, title, summary, created_at, updated_at FROM contexts`);
			const termsBefore = await schemaPool.query(`SELECT tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at FROM context_terms`);

			await runMigrations(schemaPool, [contextRevisionDeltaMigration, contextTermRevisionDeltaMigration, contextRestorationSourceMigration, contextRevisionBaselinesMigration]);
			const client = await schemaPool.connect();
			try {
				await contextRevisionBaselinesMigration.up(createPgMigrationConn(client));
			} finally {
				client.release();
			}
			await runMigrations(schemaPool, migrations.slice(migrations.findIndex((migration) => migration.id === compactReverseFieldPatchesMigration.id)));

			const contextsAfter = await schemaPool.query(`SELECT tenant_id, key, scope_entity_id, title, summary, created_at, updated_at FROM contexts`);
			const termsAfter = await schemaPool.query(`SELECT tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at FROM context_terms`);
			expect(contextsAfter.rows).toEqual(contextsBefore.rows);
			expect(termsAfter.rows).toEqual(termsBefore.rows);
			expect((await schemaPool.query(`SELECT id::text FROM context_terms`)).rows).toEqual([{ id: deriveMigratedContextTermId("default", "Order") }]);

			const contextBaselines = await schemaPool.query(`SELECT revision, author, patch_format, octet_length(source_hash) AS source_bytes, octet_length(target_hash) AS target_bytes, created_at FROM revision_entries WHERE record_kind = 'context'`);
			expect(contextBaselines.rows).toEqual([{ revision: 1, author: "system", patch_format: 1, source_bytes: 32, target_bytes: 32, created_at: "2024-02-01T00:00:00.000Z" }]);
			const termBaselines = await schemaPool.query(`SELECT revision, author, patch_format, octet_length(source_hash) AS source_bytes, octet_length(target_hash) AS target_bytes, created_at FROM revision_entries WHERE record_kind = 'context-term'`);
			expect(termBaselines.rows).toEqual([{ revision: 1, author: "system", patch_format: 1, source_bytes: 32, target_bytes: 32, created_at: "2024-02-02T00:00:00.000Z" }]);

			const store = new PgStore(schemaPool, "tenant-a");
			await expect(store.materializeContextRevision({ revision: 1 })).resolves.toMatchObject({ title: "Current title", summary: "Current summary.", author: "system", createdAt: "2024-02-01T00:00:00.000Z" });
			await expect(store.materializeContextTermRevision({ term: "Order", revision: 1 })).resolves.toMatchObject({ definition: "Current definition.", avoid: ["purchase"], tombstone: false, author: "system", createdAt: "2024-02-02T00:00:00.000Z" });
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("splices legacy snapshots before existing deltas without changing the live head", async () => {
		const schemaName = `chain_history_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		// Run all migrations except 0007 (history-entries-to-deltas) and 0008
		// (context-revision-delta) so we can insert pre-migration test data and
		// then prove only 0007 runs as the tested slice.
		const priorMigrations = migrations.slice(0, migrations.findIndex((m) => m.id === historyEntriesToDeltasMigration.id));

		try {
			await runMigrations(schemaPool, priorMigrations);
			await schemaPool.query(
				`INSERT INTO entities
					(tenant_id, id, kind, title, status, body, body_source, revision, content_hash, tombstone, project_id, created_at, updated_at)
				 VALUES
					('tenant-a', 'ISS1', 'issue', 'Live title', 'todo', 'live body', 'authored', 2, 'hash', TRUE, 'PROJ0', '2024-01-01T00:00:00.000Z', '2024-01-03T00:00:00.000Z')`
			);
			await schemaPool.query(
				`INSERT INTO history_entries
					(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
				 VALUES
					('history-v1', 'tenant-a', 'ISS1', 1, 'creator', 'First title', 'first body', 'authored', 'todo', NULL, '2024-01-01T00:00:00.000Z'),
					('history-v2', 'tenant-a', 'ISS1', 2, 'editor', 'Second title', 'second body', 'authored', 'todo', NULL, '2024-01-02T00:00:00.000Z')`
			);
			await schemaPool.query(
				`INSERT INTO entity_delta_entries
					(id, tenant_id, entity_id, revision, author, prior_title, prior_body, prior_body_source, prior_parent_changed, prior_tombstone, created_at)
				 VALUES
					('existing-delta', 'tenant-a', 'ISS1', 2, 'writer', 'Second title', 'second body', 'authored', FALSE, FALSE, '2024-01-03T00:00:00.000Z')`
			);

			await runMigrations(
				schemaPool,
				migrations.slice(migrations.findIndex((migration) => migration.id === historyEntriesToDeltasMigration.id))
			);

			const store = new PgStore(schemaPool, "tenant-a");
			const migratedIssueId = deriveMigratedEntityIdentity("issue", "ISS1").stableId;
			await expect(store.materializeEntityRevision({ entityId: "ISS1", revision: 1 })).rejects.toThrow("Entity not found: ISS1");
			await expect(store.materializeEntityRevision({ entityId: migratedIssueId, revision: 1 })).resolves.toMatchObject({
				headRevision: 3,
				title: "First title",
				body: "first body",
				author: "creator"
			});
			await expect(store.materializeEntityRevision({ entityId: migratedIssueId, revision: 2 })).resolves.toMatchObject({
				title: "Second title",
				body: "second body",
				author: "editor",
				tombstone: false
			});
			await expect(store.materializeEntityRevision({ entityId: migratedIssueId, revision: 3 })).resolves.toMatchObject({
				title: "Live title",
				body: "live body",
				author: "writer",
				tombstone: true
			});
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});
});
