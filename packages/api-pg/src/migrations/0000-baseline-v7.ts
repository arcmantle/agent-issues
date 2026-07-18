import { sql } from "drizzle-orm";

import {
	createContextsTable,
	createContextsTenantScopeEntityIdIndex,
	createContextTermsTable,
	createContextTermsTenantContextKeyIndex,
	createCountersTable,
	createEntitiesTable,
	createHistoryEntriesTable,
	createHistoryEntriesVersionIndex,
	createMetadataTable,
	createRelationsTable,
	createRelationsTenantToIdIndex
} from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

/**
 * Recreates api's `schema_version 7`-equivalent baseline through the ADR43
 * runner instead of drizzle-kit's `migrate()`. Skips all DDL when `entities`
 * already exists in the active schema (baseline-adopt semantics for existing
 * installs); creates the full table set from scratch on a fresh install.
 * Issues each table/index through the same shared fragments
 * (`@agent-issues/core`, ISS174) core's own baseline uses.
 *
 * Originally bundled `history_entries` with its original, mistakenly-unique
 * index (mirroring api's literal first drizzle-kit migration,
 * `0000_careless_multiple_man.sql`), relaxed to non-unique by a separate
 * `0002-history-version-index-non-unique` migration shared with core.
 * Creates the index non-unique directly now instead: ADR43 was amended once
 * it was confirmed `agent-issues` has never shipped to a real installed
 * user (`npm view agent-issues` confirms zero published versions), so there
 * is no external ledger whose exact two-step replay needs preserving.
 */
export const baselineV7Migration: Migration = {
	id: "0000-baseline-v7",
	up: async (conn) => {
		const existing = await conn.all(
			sql`SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'entities'`
		);
		if (existing.length > 0) {
			return;
		}

		await createMetadataTable(conn);
		await createCountersTable(conn);
		await createEntitiesTable(conn);
		await createRelationsTable(conn);
		await createRelationsTenantToIdIndex(conn);
		await createContextsTable(conn);
		await createContextsTenantScopeEntityIdIndex(conn);
		await createContextTermsTable(conn);
		await createContextTermsTenantContextKeyIndex(conn);
		await createHistoryEntriesTable(conn);
		await createHistoryEntriesVersionIndex(conn);
	}
};
