import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import {
	addEntityRevisionColumns,
	createEntityDeltaEntriesTable,
	createEntityDeltaEntriesIndex,
	type Migration,
	type MigrationConn
} from "@agent-issues/core";

/**
 * Adds `revision` and `content_hash` to the `entities` table and creates the
 * `entity_delta_entries` reverse-delta chain table (ADR55/ISS257). Backfills
 * `content_hash` for every existing entity row so they immediately participate
 * in the stale-base validation on their next edit without requiring a special
 * "no-hash" bypass.
 */
export const entityRevisionDeltaMigration: Migration = {
	id: "0011-entity-revision-delta",
	up: async (conn) => {
		await addEntityRevisionColumns(conn);
		await createEntityDeltaEntriesTable(conn);
		await createEntityDeltaEntriesIndex(conn);
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
