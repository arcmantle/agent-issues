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
	createRelationsTenantToIdIndex
} from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

/**
 * Recreates api's `schema_version 7`-equivalent baseline (its literal first
 * drizzle-kit migration, `0000_careless_multiple_man.sql`, which already
 * bundled `history_entries` alongside the core v7 tables) through the ADR43
 * runner instead of drizzle-kit's `migrate()`. Skips all DDL when `entities`
 * already exists in the active schema (baseline-adopt semantics for existing
 * installs); creates the full table set from scratch on a fresh install.
 * Issues each table/index through the same shared fragments
 * (`@agent-issues/core`, ISS174) core's own baseline uses, plus
 * `history_entries` (bundled here since api's original drizzle-kit baseline
 * bundled it too - a permanent, per-package historical fact) created with
 * its original mistakenly-unique index, later relaxed by
 * `0002-history-version-index-non-unique`.
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
		await createHandoffsTable(conn);
		await createHandoffsTenantInitiativeIdIndex(conn);
		await createHandoffsTenantEntityIdIndex(conn);
		await createHistoryEntriesTable(conn);
		await createHistoryEntriesVersionIndex(conn, { unique: true });
	}
};
