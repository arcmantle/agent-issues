import {
	addContextRevisionColumns,
	createContextDeltaEntriesIndex,
	createContextDeltaEntriesTable,
	type Migration
} from "@agent-issues/core";

/**
 * Adds `revision` and `content_hash` to the `contexts` table and creates the
 * `context_delta_entries` reverse-delta chain table (ADR55/ISS259). Mirrors
 * the entity revision/delta migration pattern (0011) for context facts.
 */
export const contextRevisionDeltaMigration: Migration = {
	id: "0015-context-revision-delta",
	up: async (conn) => {
		await addContextRevisionColumns(conn);
		await createContextDeltaEntriesTable(conn);
		await createContextDeltaEntriesIndex(conn);
	}
};
