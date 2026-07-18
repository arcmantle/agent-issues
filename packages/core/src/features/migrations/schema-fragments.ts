import { sql } from "drizzle-orm";

import type { MigrationConn } from "./migration-engine.js";

/**
 * Shared DDL fragments for the `schema_version 7` domain tables (ISS174):
 * one function per table/index, each issuing exactly one statement through
 * `conn.run` so both packages' baseline migrations build identical schema
 * shape from the same literal SQL text instead of duplicating it per driver.
 * `IF NOT EXISTS` guards make every fragment safe to call against a database
 * that already has this shape (baseline-adopt semantics for existing
 * installs) as well as a fresh install.
 */

export async function createMetadataTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);
}

export async function createCountersTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS counters (
			tenant_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			next_value INTEGER NOT NULL,
			PRIMARY KEY (tenant_id, kind)
		)
	`);
}

export async function createEntitiesTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS entities (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			body_source TEXT NOT NULL DEFAULT 'authored',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id)
		)
	`);
}

export async function createRelationsTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS relations (
			tenant_id TEXT NOT NULL,
			from_id TEXT NOT NULL,
			to_id TEXT NOT NULL,
			type TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, from_id, to_id, type),
			FOREIGN KEY (tenant_id, from_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE,
			FOREIGN KEY (tenant_id, to_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)
	`);
}

export async function createRelationsTenantToIdIndex(conn: MigrationConn): Promise<void> {
	await conn.run(sql`CREATE INDEX IF NOT EXISTS relations_tenant_to_id_idx ON relations (tenant_id, to_id)`);
}

export async function createContextsTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS contexts (
			tenant_id TEXT NOT NULL,
			key TEXT NOT NULL,
			scope_entity_id TEXT,
			title TEXT NOT NULL,
			summary TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, key),
			FOREIGN KEY (tenant_id, scope_entity_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)
	`);
}

export async function createContextsTenantScopeEntityIdIndex(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE UNIQUE INDEX IF NOT EXISTS contexts_tenant_scope_entity_id_idx
		ON contexts (tenant_id, scope_entity_id) WHERE scope_entity_id IS NOT NULL
	`);
}

export async function createContextTermsTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS context_terms (
			tenant_id TEXT NOT NULL,
			context_key TEXT NOT NULL,
			term TEXT NOT NULL,
			definition TEXT NOT NULL,
			avoid_terms TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, context_key, term),
			FOREIGN KEY (tenant_id, context_key) REFERENCES contexts(tenant_id, key) ON DELETE CASCADE
		)
	`);
}

export async function createContextTermsTenantContextKeyIndex(conn: MigrationConn): Promise<void> {
	await conn.run(sql`CREATE INDEX IF NOT EXISTS context_terms_tenant_context_key_idx ON context_terms (tenant_id, context_key)`);
}

export async function createHistoryEntriesTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS history_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			author TEXT NOT NULL,
			title TEXT NOT NULL,
			body TEXT NOT NULL,
			body_source TEXT NOT NULL,
			status TEXT NOT NULL,
			parent_id TEXT,
			created_at TEXT NOT NULL
		)
	`);
}

export async function createHistoryEntriesVersionIndex(conn: MigrationConn): Promise<void> {
	await conn.run(sql`CREATE INDEX IF NOT EXISTS history_entries_tenant_entity_version_idx ON history_entries (tenant_id, entity_id, version)`);
}
