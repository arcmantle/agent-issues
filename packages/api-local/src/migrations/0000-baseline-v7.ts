import { sql } from "drizzle-orm";

import {
	createContextsTable,
	createContextsTenantScopeEntityIdIndex,
	createContextTermsTable,
	createContextTermsTenantContextKeyIndex,
	createCountersTable,
	createEntitiesTable,
	createHandoffsTable,
	createHandoffsTenantEntityIdIndex,
	createHandoffsTenantInitiativeIdIndex,
	createHistoryEntriesTable,
	createHistoryEntriesVersionIndex,
	createMetadataTable,
	createRelationsTable,
	createRelationsTenantToIdIndex,
	type Migration
} from "@agent-issues/core";

/**
 * Recreates the full core schema in one step through the ADR43 runner:
 * the v7 baseline tables (metadata/counters/entities/relations/contexts/
 * context_terms/handoffs), `history_entries` (ADR8's append-only history),
 * and `project_migrations` (ISS63's tenant-to-project consolidation
 * ledger). Every statement is `IF NOT EXISTS`-guarded, so this module is a
 * no-op against a database that already has this shape (existing installs)
 * and builds the full schema from scratch on a fresh install.
 *
 * Originally split across four modules mirroring four separate
 * drizzle-kit-generated `.sql` files (`0000-baseline-v7`,
 * `0001-history-entries`, `0002-history-version-index-non-unique`,
 * `0003-project-migrations`) plus a fifth module purely to relax an index
 * an early drizzle-kit file got wrong. Collapsed into this single module
 * once ADR43 was amended: `agent-issues` has never shipped to a real
 * installed user (`npm view agent-issues` confirms zero published
 * versions), so there is no external ledger whose per-file granularity
 * needs preserving, and the drizzle-kit files these modules mirrored no
 * longer exist as literal artifacts anyway. Issues each table/index
 * through a shared fragment (`./schema-fragments.js`, ISS174) so the
 * literal DDL text is authored once and reused by api's own baseline.
 */
export const baselineV7Migration: Migration = {
	id: "0000-baseline-v7",
	up: async (conn) => {
		await createMetadataTable(conn);
		await createCountersTable(conn);
		await createEntitiesTable(conn);
		await createRelationsTable(conn);
		await createRelationsTenantToIdIndex(conn);
		await createContextsTable(conn);
		await createContextsTenantScopeEntityIdIndex(conn);
		await createContextTermsTable(conn);
		await createContextTermsTenantContextKeyIndex(conn);
		await createHandoffsTable(conn);
		await createHandoffsTenantInitiativeIdIndex(conn);
		await createHandoffsTenantEntityIdIndex(conn);
		await createHistoryEntriesTable(conn);
		await createHistoryEntriesVersionIndex(conn);
		await conn.run(sql`
			CREATE TABLE IF NOT EXISTS project_migrations (
				tenant_id TEXT NOT NULL,
				legacy_tenant_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (tenant_id, legacy_tenant_id)
			)
		`);
	}
};
