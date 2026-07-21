import { migrateHistoryEntriesToDeltas } from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

/**
 * Converts pre-existing `history_entries` full-snapshots into
 * `entity_delta_entries` reverse-delta chains (ADR55/ISS265).
 *
 * Delegates to the shared `migrateHistoryEntriesToDeltas` fragment which
 * handles the Postgres dialect (boolean prior_parent_changed, IS DISTINCT FROM
 * parent equality check, ON CONFLICT DO NOTHING).  See the SQLite counterpart
 * (0014-history-entries-to-deltas in api-local) for full narrative.
 */
export const historyEntriesToDeltasMigration: Migration = {
	id: "0007-history-entries-to-deltas",
	up: migrateHistoryEntriesToDeltas
};
