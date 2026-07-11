import type { Migration } from "../migration-engine.js";
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
	createMetadataTable,
	createRelationsTable,
	createRelationsTenantToIdIndex
} from "./schema-fragments.js";

/**
 * Recreates the live `schema_version 7` schema exactly (ADR13's
 * baseline-adopt guarantee, executed through the ADR43 runner instead of
 * drizzle-kit's `0000` migration). Every statement is guarded with
 * `IF NOT EXISTS` so this module is a no-op against a database that already
 * has this shape (existing installs) and builds the full schema from
 * scratch on a fresh install - no special-casing needed between the two.
 * Issues each table/index through a shared fragment (`./schema-fragments.js`,
 * ISS174) so the literal DDL text is authored once and reused by api's own
 * baseline.
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
	}
};
