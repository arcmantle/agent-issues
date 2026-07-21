import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import { RESERVED_SYSTEM_AUTHOR } from "../entity-store/domain.js";
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

/**
 * Adds `revision` and `content_hash` to the `entities` table (ADR55/ISS257).
 * Guards against re-running on a schema that already has these columns:
 * SQLite uses PRAGMA table_info; Postgres uses information_schema.columns.
 */
export async function addEntityRevisionColumns(conn: MigrationConn): Promise<void> {
	if (conn.dialect === "sqlite") {
		const cols = await conn.all<{ name: string }>(sql`PRAGMA table_info(entities)`);
		if (!cols.some((c) => c.name === "revision")) {
			await conn.run(sql`ALTER TABLE entities ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
		}

		if (!cols.some((c) => c.name === "content_hash")) {
			await conn.run(sql`ALTER TABLE entities ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
		}
	} else {
		const cols = await conn.all<{ column_name: string }>(
			sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entities'`
		);
		if (!cols.some((c) => c.column_name === "revision")) {
			await conn.run(sql`ALTER TABLE entities ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
		}

		if (!cols.some((c) => c.column_name === "content_hash")) {
			await conn.run(sql`ALTER TABLE entities ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
		}
	}
}

/**
 * Creates the `entity_delta_entries` append-only table (ADR55/ISS257).
 * Each row is the reverse patch for one title/body edit: it records the
 * predecessor title/body so ISS261's history materializer can walk back
 * from the current head one step at a time.
 *
 * The UNIQUE constraint on (tenant_id, entity_id, revision) enforces the
 * linear chain invariant: one delta per revision per entity, no branches.
 */
export async function createEntityDeltaEntriesTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS entity_delta_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			author TEXT NOT NULL,
			prior_title TEXT NOT NULL,
			prior_body TEXT NOT NULL,
			prior_body_source TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE (tenant_id, entity_id, revision)
		)
	`);
}

export async function createEntityDeltaEntriesIndex(conn: MigrationConn): Promise<void> {
	await conn.run(sql`CREATE INDEX IF NOT EXISTS entity_delta_entries_tenant_entity_revision_idx ON entity_delta_entries (tenant_id, entity_id, revision)`);
}

export async function addEntityLifecycleDeltaColumns(conn: MigrationConn): Promise<void> {
	if (conn.dialect === "sqlite") {
		const entityColumns = await conn.all<{ name: string }>(sql`PRAGMA table_info(entities)`);
		if (!entityColumns.some((column) => column.name === "tombstone")) {
			await conn.run(sql`ALTER TABLE entities ADD COLUMN tombstone INTEGER NOT NULL DEFAULT 0`);
		}

		const deltaColumns = await conn.all<{ name: string }>(sql`PRAGMA table_info(entity_delta_entries)`);
		if (!deltaColumns.some((column) => column.name === "prior_status")) {
			await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN prior_status TEXT`);
		}
		if (!deltaColumns.some((column) => column.name === "prior_parent_id")) {
			await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN prior_parent_id TEXT`);
		}
		if (!deltaColumns.some((column) => column.name === "prior_tombstone")) {
			await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN prior_tombstone INTEGER`);
		}
		return;
	}

	await conn.run(sql`ALTER TABLE entities ADD COLUMN IF NOT EXISTS tombstone BOOLEAN NOT NULL DEFAULT FALSE`);
	await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN IF NOT EXISTS prior_status TEXT`);
	await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN IF NOT EXISTS prior_parent_id TEXT`);
	await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN IF NOT EXISTS prior_tombstone BOOLEAN`);
}

export async function addEntityParentDeltaMarker(conn: MigrationConn): Promise<void> {
	if (conn.dialect === "sqlite") {
		const deltaColumns = await conn.all<{ name: string }>(sql`PRAGMA table_info(entity_delta_entries)`);
		if (!deltaColumns.some((column) => column.name === "prior_parent_changed")) {
			await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN prior_parent_changed INTEGER NOT NULL DEFAULT 0`);
		}
		return;
	}

	await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN IF NOT EXISTS prior_parent_changed BOOLEAN NOT NULL DEFAULT FALSE`);
}

export async function addEntityRestorationSourceColumn(conn: MigrationConn): Promise<void> {
	if (conn.dialect === "sqlite") {
		const deltaColumns = await conn.all<{ name: string }>(sql`PRAGMA table_info(entity_delta_entries)`);
		if (!deltaColumns.some((column) => column.name === "restored_from_revision")) {
			await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN restored_from_revision INTEGER`);
		}
		return;
	}

	await conn.run(sql`ALTER TABLE entity_delta_entries ADD COLUMN IF NOT EXISTS restored_from_revision INTEGER`);
}

export async function addContextRestorationSourceColumns(conn: MigrationConn): Promise<void> {
	if (conn.dialect === "sqlite") {
		for (const tableName of ["context_delta_entries", "context_term_delta_entries"] as const) {
			const deltaColumns = await conn.all<{ name: string }>(sql.raw(`PRAGMA table_info(${tableName})`));
			if (!deltaColumns.some((column) => column.name === "restored_from_revision")) {
				await conn.run(sql.raw(`ALTER TABLE ${tableName} ADD COLUMN restored_from_revision INTEGER`));
			}
		}
		return;
	}

	await conn.run(sql`ALTER TABLE context_delta_entries ADD COLUMN IF NOT EXISTS restored_from_revision INTEGER`);
	await conn.run(sql`ALTER TABLE context_term_delta_entries ADD COLUMN IF NOT EXISTS restored_from_revision INTEGER`);
}

/**
 * Adds `revision` and `content_hash` to the `contexts` table (ADR55/ISS259).
 * Guards against re-running on a schema that already has these columns.
 */
export async function addContextRevisionColumns(conn: MigrationConn): Promise<void> {
	if (conn.dialect === "sqlite") {
		const cols = await conn.all<{ name: string }>(sql`PRAGMA table_info(contexts)`);
		if (!cols.some((c) => c.name === "revision")) {
			await conn.run(sql`ALTER TABLE contexts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
		}

		if (!cols.some((c) => c.name === "content_hash")) {
			await conn.run(sql`ALTER TABLE contexts ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
		}
	} else {
		const cols = await conn.all<{ column_name: string }>(
			sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'contexts'`
		);
		if (!cols.some((c) => c.column_name === "revision")) {
			await conn.run(sql`ALTER TABLE contexts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
		}

		if (!cols.some((c) => c.column_name === "content_hash")) {
			await conn.run(sql`ALTER TABLE contexts ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
		}
	}
}

/**
 * Creates the `context_delta_entries` append-only reverse-delta chain table
 * (ADR55/ISS259). Each row is the reverse patch for one title/summary edit:
 * it records the predecessor title/summary so a future history materializer
 * can walk back from the current head one step at a time.
 *
 * The UNIQUE constraint on (tenant_id, context_key, revision) enforces the
 * linear chain invariant: one delta per revision per context, no branches.
 */
export async function createContextDeltaEntriesTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS context_delta_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			context_key TEXT NOT NULL,
			revision INTEGER NOT NULL,
			author TEXT NOT NULL,
			prior_title TEXT NOT NULL,
			prior_summary TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE (tenant_id, context_key, revision)
		)
	`);
}

export async function createContextDeltaEntriesIndex(conn: MigrationConn): Promise<void> {
	await conn.run(sql`CREATE INDEX IF NOT EXISTS context_delta_entries_tenant_key_revision_idx ON context_delta_entries (tenant_id, context_key, revision)`);
}

export async function addContextTermRevisionColumns(conn: MigrationConn): Promise<void> {
	if (conn.dialect === "sqlite") {
		const columns = await conn.all<{ name: string }>(sql`PRAGMA table_info(context_terms)`);
		if (!columns.some((column) => column.name === "revision")) {
			await conn.run(sql`ALTER TABLE context_terms ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
		}
		if (!columns.some((column) => column.name === "content_hash")) {
			await conn.run(sql`ALTER TABLE context_terms ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
		}
		if (!columns.some((column) => column.name === "tombstone")) {
			await conn.run(sql`ALTER TABLE context_terms ADD COLUMN tombstone INTEGER NOT NULL DEFAULT 0`);
		}
		return;
	}

	await conn.run(sql`ALTER TABLE context_terms ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1`);
	await conn.run(sql`ALTER TABLE context_terms ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT ''`);
	await conn.run(sql`ALTER TABLE context_terms ADD COLUMN IF NOT EXISTS tombstone BOOLEAN NOT NULL DEFAULT FALSE`);
}

export async function createContextTermDeltaEntriesTable(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		CREATE TABLE IF NOT EXISTS context_term_delta_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			context_key TEXT NOT NULL,
			term TEXT NOT NULL,
			revision INTEGER NOT NULL,
			author TEXT NOT NULL,
			prior_definition TEXT NOT NULL,
			prior_avoid_terms TEXT NOT NULL,
			prior_tombstone BOOLEAN NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE (tenant_id, context_key, term, revision)
		)
	`);
}

export async function createContextTermDeltaEntriesIndex(conn: MigrationConn): Promise<void> {
	await conn.run(sql`CREATE INDEX IF NOT EXISTS context_term_delta_entries_tenant_term_revision_idx ON context_term_delta_entries (tenant_id, context_key, term, revision)`);
}

export async function seedContextRevisionBaselines(conn: MigrationConn): Promise<void> {
	const contexts = await conn.all<{ tenant_id: string; key: string; title: string; summary: string; updated_at: string }>(
		sql`SELECT tenant_id, key, title, summary, updated_at FROM contexts`
	);
	for (const context of contexts) {
		const contentHash = createHash("sha256").update(`${context.title}\n\n${context.summary}`).digest("hex");
		await conn.run(sql`UPDATE contexts SET revision = 1, content_hash = ${contentHash}
			WHERE tenant_id = ${context.tenant_id} AND key = ${context.key} AND content_hash = ''`);
		await conn.run(sql`INSERT INTO context_delta_entries (id, tenant_id, context_key, revision, author, prior_title, prior_summary, created_at)
			SELECT ${randomUUID()}, ${context.tenant_id}, ${context.key}, 1, ${RESERVED_SYSTEM_AUTHOR}, ${context.title}, ${context.summary}, ${context.updated_at}
			WHERE NOT EXISTS (SELECT 1 FROM context_delta_entries WHERE tenant_id = ${context.tenant_id} AND context_key = ${context.key} AND revision = 1)`);
	}

	await conn.run(sql`UPDATE context_term_delta_entries
		SET created_at = (
			SELECT context_terms.updated_at
			FROM context_terms
			WHERE context_terms.tenant_id = context_term_delta_entries.tenant_id
			  AND context_terms.context_key = context_term_delta_entries.context_key
			  AND context_terms.term = context_term_delta_entries.term
		)
		WHERE revision = 1 AND author = ${RESERVED_SYSTEM_AUTHOR}
		  AND EXISTS (
			SELECT 1 FROM context_terms
			WHERE context_terms.tenant_id = context_term_delta_entries.tenant_id
			  AND context_terms.context_key = context_term_delta_entries.context_key
			  AND context_terms.term = context_term_delta_entries.term
			  AND context_terms.revision = 1
		  )`);
}

/**
 * Converts pre-existing `history_entries` full-snapshots into
 * `entity_delta_entries` reverse-delta chains (ADR55/ISS265).
 *
 * Snapshot revisions are inserted before any deltas already written by the new
 * model. Existing delta revisions and the materialized head move forward by
 * `snapshot count - 1`, preserving both chains without changing live facts.
 * Version 1 becomes a baseline patch so its stable id and attribution survive.
 *
 * `prior_tombstone` is always NULL because history_entries predates tombstone
 * support; existing tombstone-aware deltas written by ISS258 are unaffected.
 */
export async function migrateHistoryEntriesToDeltas(conn: MigrationConn): Promise<void> {
	await conn.run(sql`
		UPDATE entity_delta_entries
		SET revision = -revision
		WHERE EXISTS (
			SELECT 1 FROM history_entries AS h
			WHERE h.tenant_id = entity_delta_entries.tenant_id
			  AND h.entity_id = entity_delta_entries.entity_id
		)
		  AND NOT EXISTS (
			SELECT 1
			FROM entity_delta_entries AS migrated_delta
			INNER JOIN history_entries AS migrated_history ON migrated_history.id = migrated_delta.id
			WHERE migrated_delta.tenant_id = entity_delta_entries.tenant_id
			  AND migrated_delta.entity_id = entity_delta_entries.entity_id
		)
	`);

	await conn.run(sql`
		UPDATE entity_delta_entries
		SET revision = -revision + (
			SELECT COUNT(*) - 1 FROM history_entries AS h
			WHERE h.tenant_id = entity_delta_entries.tenant_id
			  AND h.entity_id = entity_delta_entries.entity_id
		)
		WHERE revision < 0
	`);

	if (conn.dialect === "sqlite") {
		await conn.run(sql`
			WITH ordered_history AS (
				SELECT *,
					ROW_NUMBER() OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS chain_revision,
					LAG(title) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_title,
					LAG(body) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_body,
					LAG(body_source) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_body_source,
					LAG(status) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_status,
					LAG(parent_id) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_parent_id
				FROM history_entries
			)
			INSERT INTO entity_delta_entries
				(id, tenant_id, entity_id, revision, author,
				 prior_title, prior_body, prior_body_source,
				 prior_status, prior_parent_id, prior_parent_changed,
				 prior_tombstone, created_at)
			SELECT
				id,
				tenant_id,
				entity_id,
				chain_revision,
				author,
				COALESCE(prior_title, title),
				COALESCE(prior_body, body),
				COALESCE(prior_body_source, body_source),
				COALESCE(prior_status, status),
				prior_parent_id,
				CASE
					WHEN chain_revision = 1 THEN 0
					WHEN prior_parent_id IS parent_id THEN 0
					ELSE 1
				END,
				NULL,
				created_at
			FROM ordered_history
			WHERE TRUE
			ON CONFLICT (tenant_id, entity_id, revision) DO NOTHING
		`);
	} else {
		await conn.run(sql`
			WITH ordered_history AS (
				SELECT *,
					ROW_NUMBER() OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS chain_revision,
					LAG(title) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_title,
					LAG(body) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_body,
					LAG(body_source) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_body_source,
					LAG(status) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_status,
					LAG(parent_id) OVER (PARTITION BY tenant_id, entity_id ORDER BY version, created_at, id) AS prior_parent_id
				FROM history_entries
			)
			INSERT INTO entity_delta_entries
				(id, tenant_id, entity_id, revision, author,
				 prior_title, prior_body, prior_body_source,
				 prior_status, prior_parent_id, prior_parent_changed,
				 prior_tombstone, created_at)
			SELECT
				id,
				tenant_id,
				entity_id,
				chain_revision,
				author,
				COALESCE(prior_title, title),
				COALESCE(prior_body, body),
				COALESCE(prior_body_source, body_source),
				COALESCE(prior_status, status),
				prior_parent_id,
				CASE WHEN chain_revision = 1 THEN FALSE ELSE prior_parent_id IS DISTINCT FROM parent_id END,
				NULL,
				created_at
			FROM ordered_history
			WHERE TRUE
			ON CONFLICT (tenant_id, entity_id, revision) DO NOTHING
		`);
	}

	await conn.run(sql`
		UPDATE entities
		SET revision = (
			SELECT MAX(delta.revision)
			FROM entity_delta_entries AS delta
			WHERE delta.tenant_id = entities.tenant_id
			  AND delta.entity_id = entities.id
		)
		WHERE EXISTS (
			SELECT 1 FROM history_entries AS h
			WHERE h.tenant_id = entities.tenant_id
			  AND h.entity_id = entities.id
		  )
		  AND revision <> (
			SELECT MAX(delta.revision)
			FROM entity_delta_entries AS delta
			WHERE delta.tenant_id = entities.tenant_id
			  AND delta.entity_id = entities.id
		  )
	`);
}
