import { migrateHistoryEntriesToDeltas, type Migration } from "@agent-issues/core";

/**
 * Converts pre-existing `history_entries` full-snapshots into
 * `entity_delta_entries` reverse-delta chains (ADR55/ISS265).
 *
 * For each entity whose entire version history still lives in `history_entries`
 * (i.e. it has not been edited since migration 0011 created the delta-chain
 * table), this migration:
 *   1. Inserts a delta entry at revision N whose prior-state fields hold the
 *      snapshot at version N-1, for every N ≥ 2.
 *   2. Advances `entities.revision` to MAX(history_entries.version) so the
 *      materializer (`materializeFromPatches`) sees the correct head.
 *
 * Entities that already have `entity_delta_entries` rows (written by ISS257/
 * ISS258 post-0011 edits) are left untouched; their pre-0011 snapshot log
 * remains queryable via `history_entries` as a sealed audit trail.
 */
export const historyEntriesToDeltasMigration: Migration = {
	id: "0014-history-entries-to-deltas",
	up: migrateHistoryEntriesToDeltas
};
