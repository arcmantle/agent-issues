import type { Migration } from "../migration-engine.js";
import { createHistoryEntriesVersionIndex, dropHistoryEntriesVersionIndex } from "./schema-fragments.js";

/**
 * Relaxes `history_entries_tenant_entity_version_idx` from unique to
 * non-unique, ported from drizzle-kit's
 * `0002_history_version_index_non_unique.sql`. A no-op when
 * `0001-history-entries` already created the index as non-unique (fresh
 * core installs); rewrites the index for databases that still carry the
 * original unique constraint from before this decision - including api's,
 * whose own baseline recreates that original unique index verbatim (ISS174:
 * this migration object is imported directly by `@agent-issues/api` rather
 * than duplicated, since its content is identical for both packages).
 */
export const historyVersionIndexNonUniqueMigration: Migration = {
	id: "0002-history-version-index-non-unique",
	up: async (conn) => {
		await dropHistoryEntriesVersionIndex(conn);
		await createHistoryEntriesVersionIndex(conn, { unique: false });
	}
};
