import type { Migration } from "../migration-engine.js";
import { createHistoryEntriesTable, createHistoryEntriesVersionIndex } from "./schema-fragments.js";

/**
 * Adds the `history_entries` table (ADR8's append-only history), ported from
 * drizzle-kit's `0001_history_entries.sql`. Uses a non-unique index directly
 * (rather than the original unique index later relaxed by
 * `0002_history_version_index_non_unique.sql`) since a hand-written module
 * can express the end state in one step; that later drizzle-kit file still
 * gets its own module for historical fidelity even though it becomes a
 * no-op once this module runs first on a fresh install.
 */
export const historyEntriesMigration: Migration = {
	id: "0001-history-entries",
	up: async (conn) => {
		await createHistoryEntriesTable(conn);
		await createHistoryEntriesVersionIndex(conn, { unique: false });
	}
};
