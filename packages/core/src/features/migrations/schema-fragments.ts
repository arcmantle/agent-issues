import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import {
	computeEntityContentHash,
	ENTITY_KINDS,
	ID_PREFIX,
	isAllowedRelation,
	isBodySource,
	isStructuralRelationType,
	isValidStatus,
	RESERVED_SYSTEM_AUTHOR,
	type BodySource,
	type EntityKind,
	type EntityRevisionPatch
} from "../entity-store/domain.js";
import { deriveMigratedEntityIdentity } from "../entity-store/canonical-reference.js";
import { materializeFromPatches } from "../entity-store/materialize-revision.js";
import { createReverseFieldPatch, ENTITY_REVERSE_PATCH_REGISTRY } from "../reverse-field-patch/reverse-field-patch.js";
import { encodeEntityRecordKey } from "../revision-patch-ledger/record-key.js";
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

type HistoryEntryMigRow = {
	tenant_id: string;
	entity_id: string;
	version: number;
	author: string;
	title: string;
	body: string;
	body_source: string | null;
	status: string;
	parent_id: string | null;
	created_at: string;
};

type EntityMigRow = {
	id: string;
	title: string;
	body: string;
	body_source: string | null;
	status: string;
	revision: number;
	created_at: string;
	tombstone: number | boolean | null;
};

type RevisionEntryMigRow = {
	id: string;
	revision: number;
	author: string;
	patch_format: number;
	reverse_patch: Uint8Array;
	source_hash: Uint8Array;
	target_hash: Uint8Array;
	restored_from_revision: number | null;
	created_at: string;
};

type RelationMigRow = {
	from_id: string;
	type: string;
};

type MissingEntityBaselineRow = HistoryEntryMigRow & {
	id: string;
	project_id: string;
};

type LegacyCounterRow = {
	tenant_id: string;
	kind: string;
	next_value: number;
};

type RecoverableOrphanRow = HistoryEntryMigRow & {
	id: string;
};

type RecoveryParentRow = {
	id: string;
	kind: string;
	project_id: string | null;
};

function decodeRevisionHash(hash: Uint8Array): string {
	return Buffer.from(hash).toString("hex");
}

export async function recoverDeletedLegacyEntityHistory(conn: MigrationConn): Promise<void> {
	const counters = await conn.all<LegacyCounterRow>(sql`SELECT tenant_id, kind, next_value FROM counters`);
	const candidates = new Map<string, Array<{ kind: EntityKind; legacyAlias: string; reference: string }>>();
	for (const counter of counters) {
		const kind = ENTITY_KINDS.find((candidate) => candidate === counter.kind);
		if (!kind) {
			continue;
		}
		for (let value = 0; value < counter.next_value; value += 1) {
			const legacyAlias = `${ID_PREFIX[kind]}${value}`;
			const identity = deriveMigratedEntityIdentity(kind, legacyAlias);
			const key = `${counter.tenant_id}\0${identity.stableId}`;
			const matches = candidates.get(key) ?? [];
			matches.push({ kind, legacyAlias, reference: identity.reference });
			candidates.set(key, matches);
		}
	}

	let madeProgress = true;
	while (madeProgress) {
		madeProgress = false;
		const orphans = await conn.all<RecoverableOrphanRow>(sql`
			SELECT history.id, history.tenant_id, history.entity_id, history.version,
			       history.author, history.title, history.body, history.body_source,
			       history.status, history.parent_id, history.created_at
			FROM history_entries AS history
			LEFT JOIN entities AS entity
				ON entity.tenant_id = history.tenant_id AND entity.id = history.entity_id
			WHERE entity.id IS NULL
			ORDER BY history.tenant_id, history.entity_id, history.version
		`);
		const grouped = Map.groupBy(orphans, (row) => `${row.tenant_id}\0${row.entity_id}`);
		for (const rows of grouped.values()) {
			if (rows.length !== 1 || rows[0]!.version !== 1) {
				continue;
			}
			const row = rows[0]!;
			const matches = candidates.get(`${row.tenant_id}\0${row.entity_id}`) ?? [];
			if (matches.length !== 1) {
				continue;
			}
			const match = matches[0]!;
			if (!isValidStatus(match.kind, row.status)) {
				continue;
			}

			let projectId: string;
			if (match.kind === "project") {
				if (row.parent_id !== null) {
					continue;
				}
				projectId = row.entity_id;
			} else {
				const parents = await conn.all<RecoveryParentRow>(sql`
					SELECT id, kind, project_id FROM entities
					WHERE tenant_id = ${row.tenant_id} AND id = ${row.parent_id}
				`);
				const parent = parents[0];
				if (!parent || !parent.project_id || !isAllowedRelation(parent.kind as EntityKind, match.kind, resolveStructuralRelation(parent.kind as EntityKind, match.kind))) {
					continue;
				}
				projectId = parent.project_id;
			}

			await restoreDeletedLegacyEntity(conn, row, match.kind, match.reference, projectId);
			madeProgress = true;
		}
	}
}

function resolveStructuralRelation(fromKind: EntityKind, toKind: EntityKind): string {
	const relation = ["contains", "owns", "records", "tracks", "creates", "decomposes"]
		.find((type) => isAllowedRelation(fromKind, toKind, type));
	return relation ?? "";
}

async function restoreDeletedLegacyEntity(
	conn: MigrationConn,
	row: RecoverableOrphanRow,
	kind: EntityKind,
	reference: string,
	projectId: string
): Promise<void> {
	const bodySource = isBodySource(row.body_source ?? "") ? row.body_source! : "authored";
	const predecessor = { title: row.title, body: row.body, bodySource, status: row.status, parentId: row.parent_id, tombstone: false };
	const successor = { ...predecessor, parentId: null, tombstone: true };
	const baseline = createReverseFieldPatch(predecessor, predecessor, ENTITY_REVERSE_PATCH_REGISTRY);
	const deletion = createReverseFieldPatch(successor, predecessor, ENTITY_REVERSE_PATCH_REGISTRY);
	const tombstone = conn.dialect === "sqlite" ? 1 : true;
	await conn.run(sql`INSERT INTO entities
		(tenant_id, id, reference, kind, title, status, body, body_source, revision,
		 content_hash, tombstone, project_id, created_at, updated_at)
		VALUES (${row.tenant_id}, ${row.entity_id}, ${reference}, ${kind}, ${row.title},
			${row.status}, ${row.body}, ${bodySource}, 2, ${computeEntityContentHash(row.title, row.body)},
			${tombstone}, ${projectId}, ${row.created_at}, ${row.created_at})`);
	await conn.run(sql`INSERT INTO revision_entries
		(id, tenant_id, project_id, record_kind, record_key, revision, author,
		 patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
		VALUES (${row.id}, ${row.tenant_id}, ${projectId}, 'entity', ${encodeEntityRecordKey(row.entity_id)}, 1,
			${row.author}, ${baseline.patchFormat}, ${Buffer.from(baseline.reversePatch)},
			${Buffer.from(baseline.sourceHash, "hex")}, ${Buffer.from(baseline.targetHash, "hex")}, NULL, ${row.created_at})`);
	await conn.run(sql`INSERT INTO revision_entries
		(id, tenant_id, project_id, record_kind, record_key, revision, author,
		 patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
		VALUES (${randomUUID()}, ${row.tenant_id}, ${projectId}, 'entity', ${encodeEntityRecordKey(row.entity_id)}, 2,
			${RESERVED_SYSTEM_AUTHOR}, ${deletion.patchFormat}, ${Buffer.from(deletion.reversePatch)},
			${Buffer.from(deletion.sourceHash, "hex")}, ${Buffer.from(deletion.targetHash, "hex")}, NULL, ${row.created_at})`);
}

/**
 * Restores revision-1 ledger entries omitted by older snapshot conversion.
 * Every inserted baseline is derived from one live entity's exact version-1
 * snapshot and retains that snapshot's stable id and attribution metadata.
 */
export async function seedMissingEntityRevisionBaselines(conn: MigrationConn): Promise<void> {
	const rows = await conn.all<MissingEntityBaselineRow>(sql`
		SELECT history.id, history.tenant_id, history.entity_id, history.version,
		       history.author, history.title, history.body, history.body_source,
		       history.status, history.parent_id, history.created_at, entity.project_id
		FROM history_entries AS history
		INNER JOIN entities AS entity
			ON entity.tenant_id = history.tenant_id AND entity.id = history.entity_id
		WHERE history.version = 1
	`);

	for (const row of rows) {
		const recordKey = encodeEntityRecordKey(row.entity_id);
		const existing = await conn.all<{ id: string }>(sql`
			SELECT id FROM revision_entries
			WHERE tenant_id = ${row.tenant_id}
			  AND record_kind = 'entity'
			  AND record_key = ${recordKey}
			  AND revision = 1
		`);
		if (existing.length > 0) {
			continue;
		}

		const state = {
			title: row.title,
			body: row.body,
			bodySource: isBodySource(row.body_source ?? "") ? row.body_source! : "authored",
			status: row.status,
			parentId: row.parent_id,
			tombstone: false
		};
		const baseline = createReverseFieldPatch(state, state, ENTITY_REVERSE_PATCH_REGISTRY);
		await conn.run(sql`INSERT INTO revision_entries
			(id, tenant_id, project_id, record_kind, record_key, revision, author,
			 patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
			VALUES (${row.id}, ${row.tenant_id}, ${row.project_id}, 'entity', ${recordKey}, 1,
				${row.author}, ${baseline.patchFormat}, ${Buffer.from(baseline.reversePatch)},
				${Buffer.from(baseline.sourceHash, "hex")}, ${Buffer.from(baseline.targetHash, "hex")},
				NULL, ${row.created_at})`);
	}
}

/**
 * Validates that every `history_entries` row is consistent with the
 * `revision_entries` reverse-delta chain before the history table is
 * dropped.  Aborts (throws) on:
 *   - orphan snapshots (entity_id absent from entities),
 *   - duplicate versions (same version for the same entity),
 *   - out-of-range versions (version > entity.revision),
 *   - gaps in the revision_entries chain for revisions 2..head,
 *   - divergent facts (title/body/bodySource/status/parentId mismatch
 *     between snapshot and materialized revision), and
 *   - author or timestamp disagreement between history_entries and
 *     revision_entries.
 *
 * Called inside the migration runner's transaction so any throw leaves
 * `history_entries` intact.
 */
export async function validateHistoryEntriesChain(conn: MigrationConn): Promise<void> {
	const [row] = await conn.all<{ c: number }>(sql`SELECT COUNT(*) AS c FROM history_entries`);
	if ((row?.c ?? 0) === 0) {
		return;
	}

	// 1. Orphan check
	const orphans = await conn.all<{ entity_id: string }>(sql`
		SELECT DISTINCT entity_id FROM history_entries
		WHERE entity_id NOT IN (
			SELECT id FROM entities WHERE tenant_id = history_entries.tenant_id
		)
	`);
	if (orphans.length > 0) {
		throw new Error(
			`Migration aborted: orphan history snapshots for ${orphans.length} entity id(s) missing from entities table`
		);
	}

	// 2. Duplicate version check
	const dups = await conn.all<{ entity_id: string }>(sql`
		SELECT entity_id FROM history_entries
		GROUP BY tenant_id, entity_id, version
		HAVING COUNT(*) > 1
	`);
	if (dups.length > 0) {
		throw new Error(`Migration aborted: duplicate history entry versions found for entity ${dups[0]!.entity_id}`);
	}

	// 3. Out-of-range version check
	const outOfRange = await conn.all<{ entity_id: string }>(sql`
		SELECT DISTINCT h.entity_id
		FROM history_entries h
		JOIN entities e ON e.tenant_id = h.tenant_id AND e.id = h.entity_id
		WHERE h.version < 1 OR h.version > e.revision
	`);
	if (outOfRange.length > 0) {
		throw new Error(
			`Migration aborted: history entries with version out of range [1..entity.revision] for entity ${outOfRange[0]!.entity_id}`
		);
	}

	// 4. Per-entity chain and fact validation
	const entityKeys = await conn.all<{ tenant_id: string; entity_id: string }>(sql`
		SELECT DISTINCT tenant_id, entity_id FROM history_entries ORDER BY tenant_id, entity_id
	`);

	for (const { tenant_id: tenantId, entity_id: entityId } of entityKeys) {
		const [entityRow] = await conn.all<EntityMigRow>(sql`
			SELECT id, title, body, body_source, status, revision, created_at, tombstone
			FROM entities
			WHERE tenant_id = ${tenantId} AND id = ${entityId}
		`);
		if (!entityRow) {
			continue; // already caught by orphan check
		}

		const headRevision = entityRow.revision ?? 1;

		// Candidate structural parents. A manually linked structural-type
		// annotation may coexist with the real revision parent, and relation
		// replay can change timestamps, so the newest patch hash decides.
		const parentRows = await conn.all<RelationMigRow>(sql`
			SELECT from_id, type FROM relations
			WHERE tenant_id = ${tenantId} AND to_id = ${entityId}
			ORDER BY from_id, type
		`);

		// Reverse-delta chain for this entity
		const recordKey = encodeEntityRecordKey(entityId);
		const deltaRows = await conn.all<RevisionEntryMigRow>(sql`
			SELECT id, revision, author, patch_format, reverse_patch, source_hash, target_hash,
			       restored_from_revision, created_at
			FROM revision_entries
			WHERE tenant_id = ${tenantId}
			  AND record_kind = 'entity'
			  AND record_key = ${recordKey}
			ORDER BY revision DESC
		`);

		// Chain completeness: every revision 1..headRevision needs an entry.
		const patchRevisions = new Set(deltaRows.map((d) => d.revision));
		for (let rev = 1; rev <= headRevision; rev++) {
			if (!patchRevisions.has(rev)) {
				throw new Error(
					`Migration aborted: gap in revision chain at revision ${rev} for entity ${entityId}`
				);
			}
		}

		const patches: EntityRevisionPatch[] = deltaRows.map((d) => ({
			revision: d.revision,
			author: d.author,
			createdAt: d.created_at,
			patchFormat: d.patch_format,
			reversePatch: d.reverse_patch,
			sourceHash: decodeRevisionHash(d.source_hash),
			targetHash: decodeRevisionHash(d.target_hash),
			...(d.restored_from_revision !== null && { restoredFromRevision: d.restored_from_revision })
		}));

		const tombstone =
			typeof entityRow.tombstone === "boolean"
				? entityRow.tombstone
				: entityRow.tombstone !== 0 && entityRow.tombstone !== null;
		const structuralParentIds = parentRows
			.filter((row) => isStructuralRelationType(row.type))
			.map((row) => row.from_id);
		const newestPatch = deltaRows.find((row) => row.revision === headRevision);
		const parentId = resolveRevisionHeadParentId(entityRow, tombstone, structuralParentIds, newestPatch);

		const head = {
			id: entityRow.id,
			title: entityRow.title,
			body: entityRow.body,
			bodySource: (isBodySource(entityRow.body_source ?? "") ? entityRow.body_source! : "authored") as BodySource,
			status: entityRow.status,
			parentId,
			revision: headRevision,
			createdAt: entityRow.created_at,
			tombstone
		};

		const historyRows = await conn.all<HistoryEntryMigRow>(sql`
			SELECT tenant_id, entity_id, version, author, title, body, body_source,
			       status, parent_id, created_at
			FROM history_entries
			WHERE tenant_id = ${tenantId} AND entity_id = ${entityId}
		`);

		for (const entry of historyRows) {
			let materialized: ReturnType<typeof materializeFromPatches>;
			try {
				materialized = materializeFromPatches(entityId, head, patches, entry.version);
			} catch (error) {
				throw new Error(
					`Migration aborted: cannot materialize version ${entry.version} for entity ${entityId} in tenant ${tenantId}`,
					{ cause: error }
				);
			}

			if (entry.title !== materialized.title) {
				throw new Error(
					`Migration aborted: divergent title at version ${entry.version} for entity ${entityId}`
				);
			}
			if (entry.body !== materialized.body) {
				throw new Error(
					`Migration aborted: divergent body at version ${entry.version} for entity ${entityId}`
				);
			}
			const entryBodySource = isBodySource(entry.body_source ?? "")
				? (entry.body_source as BodySource)
				: "authored";
			if (entryBodySource !== materialized.bodySource) {
				throw new Error(
					`Migration aborted: divergent bodySource at version ${entry.version} for entity ${entityId}`
				);
			}
			if (entry.status !== materialized.status) {
				throw new Error(
					`Migration aborted: divergent status at version ${entry.version} for entity ${entityId}`
				);
			}
			if (entry.parent_id !== materialized.parentId) {
				throw new Error(
					`Migration aborted: divergent parentId at version ${entry.version} for entity ${entityId}`
				);
			}

			const patch = deltaRows.find((d) => d.revision === entry.version);
			if (!patch) {
				// Gap already caught above, but guard for safety
				throw new Error(
					`Migration aborted: missing revision entry for version ${entry.version} for entity ${entityId}`
				);
			}
			if (entry.author !== patch.author) {
				throw new Error(
					`Migration aborted: author mismatch at version ${entry.version} for entity ${entityId}`
				);
			}
			if (entry.created_at !== patch.created_at) {
				throw new Error(
					`Migration aborted: timestamp mismatch at version ${entry.version} for entity ${entityId}`
				);
			}
		}
	}
}

function resolveRevisionHeadParentId(
	entity: EntityMigRow,
	tombstone: boolean,
	parentIds: string[],
	newestPatch: RevisionEntryMigRow | undefined
): string | null {
	if (!newestPatch) {
		return parentIds[0] ?? null;
	}
	const expectedHash = decodeRevisionHash(newestPatch.source_hash);
	const candidates = [...new Set<string | null>([null, ...parentIds])];
	const matches = candidates.filter((parentId) => {
		const state = {
			title: entity.title,
			body: entity.body,
			bodySource: isBodySource(entity.body_source ?? "") ? entity.body_source! : "authored",
			status: entity.status,
			parentId,
			tombstone
		};
		return createReverseFieldPatch(state, state, ENTITY_REVERSE_PATCH_REGISTRY).sourceHash === expectedHash;
	});
	if (matches.length !== 1) {
		throw new Error(`Migration aborted: cannot uniquely resolve revision head parent for entity ${entity.id}`);
	}
	return matches[0]!;
}
