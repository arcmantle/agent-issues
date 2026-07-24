import { sql } from "drizzle-orm";
import { recoverDeletedLegacyEntityHistory, seedMissingEntityRevisionBaselines, validateHistoryEntriesChain, type Migration } from "@agent-issues/core";

/**
 * Drops the `history_entries` full-snapshot table after validating that
 * every stored snapshot is reproducible from the `revision_entries`
 * reverse-delta chain.
 *
 * The validation runs inside the runner's transaction, so any inconsistency
 * aborts the migration and leaves `history_entries` intact.
 */
export const removeHistoryEntriesMigration: Migration = {
	id: "0029-remove-history-entries",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("remove-history-entries migration requires the SQLite dialect.");
		}

		// Guard: if the table is absent the migration has already run or was
		// never needed for this install — skip safely.
		const existing = await conn.all<{ name: string }>(
			sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_entries'`
		);
		if (existing.length === 0) {
			return;
		}

		// Validate every stored snapshot against the live revision chain
		// before touching the table.  Throws (and rolls back) on any
		// inconsistency.
		await recoverDeletedLegacyEntityHistory(conn);
		await seedMissingEntityRevisionBaselines(conn);
		await validateHistoryEntriesChain(conn);

		await conn.run(sql`DROP INDEX IF EXISTS history_entries_tenant_entity_version_idx`);
		await conn.run(sql`DROP TABLE history_entries`);
	}
};
