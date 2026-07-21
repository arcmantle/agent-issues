import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import {
	addEntityRevisionColumns,
	createEntityDeltaEntriesTable,
	createEntityDeltaEntriesIndex,
	type MigrationConn
} from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

/**
 * Adds `revision` and `content_hash` to the `entities` table and creates the
 * `entity_delta_entries` reverse-delta chain table (ADR55/ISS257). Backfills
 * `content_hash` for every existing entity row so they immediately participate
 * in stale-base validation on their next edit.
 */
export const entityRevisionDeltaMigration: Migration = {
	id: "0004-entity-revision-delta",
	up: async (conn) => {
		await addEntityRevisionColumns(conn);
		await createEntityDeltaEntriesTable(conn);
		await createEntityDeltaEntriesIndex(conn);
		await conn.run(sql`ALTER TABLE entity_delta_entries ENABLE ROW LEVEL SECURITY`);
		await conn.run(sql`ALTER TABLE entity_delta_entries FORCE ROW LEVEL SECURITY`);
		const policies = await conn.all(sql`SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'entity_delta_entries' AND policyname = 'tenant_isolation'`);
		if (policies.length === 0) {
			await conn.run(sql`
				CREATE POLICY tenant_isolation ON entity_delta_entries
				USING (tenant_id = current_setting('app.tenant_id', true))
				WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
			`);
		}
		await backfillContentHashes(conn);
	}
};

async function backfillContentHashes(conn: MigrationConn): Promise<void> {
	const rows = await conn.all<{ tenant_id: string; id: string; title: string; body: string }>(
		sql`SELECT tenant_id, id, title, body FROM entities WHERE content_hash = ''`
	);
	for (const row of rows) {
		const hash = createHash("sha256").update(`${row.title}\n\n${row.body}`).digest("hex");
		await conn.run(
			sql`UPDATE entities SET content_hash = ${hash} WHERE tenant_id = ${row.tenant_id} AND id = ${row.id}`
		);
	}
}
