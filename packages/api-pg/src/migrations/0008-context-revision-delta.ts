import { sql } from "drizzle-orm";

import {
	addContextRevisionColumns,
	createContextDeltaEntriesIndex,
	createContextDeltaEntriesTable
} from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

/**
 * Adds `revision` and `content_hash` to the `contexts` table and creates the
 * `context_delta_entries` reverse-delta chain table (ADR55/ISS259). Mirrors
 * the SQLite counterpart (0015-context-revision-delta in api-local) and the
 * entity revision/delta migration pattern (0004) for context facts.
 * Enables Postgres RLS on the new table, mirroring 0004's pattern for
 * `entity_delta_entries`.
 */
export const contextRevisionDeltaMigration: Migration = {
	id: "0008-context-revision-delta",
	up: async (conn) => {
		await addContextRevisionColumns(conn);
		await createContextDeltaEntriesTable(conn);
		await createContextDeltaEntriesIndex(conn);
		await conn.run(sql`ALTER TABLE context_delta_entries ENABLE ROW LEVEL SECURITY`);
		await conn.run(sql`ALTER TABLE context_delta_entries FORCE ROW LEVEL SECURITY`);
		const policies = await conn.all(
			sql`SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'context_delta_entries' AND policyname = 'tenant_isolation'`
		);
		if (policies.length === 0) {
			await conn.run(sql`
				CREATE POLICY tenant_isolation ON context_delta_entries
				USING (tenant_id = current_setting('app.tenant_id', true))
				WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
			`);
		}
	}
};
