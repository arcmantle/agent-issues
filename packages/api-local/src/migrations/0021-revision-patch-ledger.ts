import {
	encodeContextRecordKey,
	encodeEntityRecordKey,
	type Migration,
	type MigrationConn,
	type RevisionPatchRecordKind
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

type LegacyPatchEntry = {
	id: string;
	tenant_id: string;
	revision: number;
	author: string;
	patch_format: number;
	reverse_patch: Uint8Array;
	source_hash: string;
	target_hash: string;
	restored_from_revision: number | null;
	created_at: string;
};

type ScopedPatchEntry = LegacyPatchEntry & {
	projectId: string | null;
	recordKind: RevisionPatchRecordKind;
	recordKey: string;
};

function encodeLegacyContextTermRecordKey(contextKey: string, term: string): string {
	return `${Buffer.byteLength(contextKey, "utf8")}:${contextKey}${Buffer.byteLength(term, "utf8")}:${term}`;
}

function resolveContextProjectId(contextKey: string, scopedProjectId: string | null): string | null {
	if (scopedProjectId) {
		return scopedProjectId;
	}
	if (contextKey === "default") {
		return "PROJ0";
	}
	const prefix = "default:";
	return contextKey.startsWith(prefix) && contextKey.length > prefix.length
		? contextKey.slice(prefix.length)
		: null;
}

async function createLedger(conn: MigrationConn): Promise<void> {
	await conn.run(sql`CREATE TABLE revision_patch_entries (
		id TEXT PRIMARY KEY NOT NULL,
		tenant_id TEXT NOT NULL,
		project_id TEXT NOT NULL,
		record_kind TEXT NOT NULL CHECK (record_kind IN ('entity', 'context', 'context-term')),
		record_key TEXT NOT NULL,
		revision INTEGER NOT NULL CHECK (revision > 0),
		author TEXT NOT NULL,
		patch_format INTEGER NOT NULL CHECK (patch_format > 0),
		reverse_patch BLOB NOT NULL,
		source_hash TEXT NOT NULL,
		target_hash TEXT NOT NULL,
		restored_from_revision INTEGER,
		created_at TEXT NOT NULL,
		UNIQUE (tenant_id, project_id, record_kind, record_key, revision)
	)`);
}

async function readLegacyEntries(conn: MigrationConn): Promise<ScopedPatchEntry[]> {
	const entityRows = await conn.all<LegacyPatchEntry & { entity_id: string; project_id: string | null }>(sql`
		SELECT delta.*, head.project_id
		FROM entity_delta_entries AS delta
		LEFT JOIN entities AS head
			ON head.tenant_id = delta.tenant_id AND head.id = delta.entity_id
	`);
	const contextRows = await conn.all<LegacyPatchEntry & { context_key: string; project_id: string | null }>(sql`
		SELECT delta.*, scope.project_id
		FROM context_delta_entries AS delta
		LEFT JOIN contexts AS head
			ON head.tenant_id = delta.tenant_id AND head.key = delta.context_key
		LEFT JOIN entities AS scope
			ON scope.tenant_id = head.tenant_id AND scope.id = head.scope_entity_id
	`);
	const termRows = await conn.all<LegacyPatchEntry & { context_key: string; term: string; project_id: string | null }>(sql`
		SELECT delta.*, scope.project_id
		FROM context_term_delta_entries AS delta
		LEFT JOIN contexts AS head
			ON head.tenant_id = delta.tenant_id AND head.key = delta.context_key
		LEFT JOIN entities AS scope
			ON scope.tenant_id = head.tenant_id AND scope.id = head.scope_entity_id
	`);
	return [
		...entityRows.map((row) => ({ ...row, projectId: row.project_id, recordKind: "entity" as const, recordKey: encodeEntityRecordKey(row.entity_id) })),
		...contextRows.map((row) => ({ ...row, projectId: resolveContextProjectId(row.context_key, row.project_id), recordKind: "context" as const, recordKey: encodeContextRecordKey(row.context_key) })),
		...termRows.map((row) => ({ ...row, projectId: resolveContextProjectId(row.context_key, row.project_id), recordKind: "context-term" as const, recordKey: encodeLegacyContextTermRecordKey(row.context_key, row.term) }))
	];
}

async function copyEntries(conn: MigrationConn, entries: ScopedPatchEntry[]): Promise<void> {
	for (const entry of entries) {
		if (entry.projectId === null) {
			throw new Error(`Cannot assign revision patch ${entry.id} to a project.`);
		}
		await conn.run(sql`INSERT INTO revision_patch_entries
			(id, tenant_id, project_id, record_kind, record_key, revision, author,
			 patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
			VALUES (${entry.id}, ${entry.tenant_id}, ${entry.projectId}, ${entry.recordKind},
				${entry.recordKey}, ${entry.revision}, ${entry.author}, ${entry.patch_format},
				${entry.reverse_patch}, ${entry.source_hash}, ${entry.target_hash},
				${entry.restored_from_revision}, ${entry.created_at})`);
	}
	const migrated = await conn.all<{ count: number }>(sql`SELECT count(*) AS count FROM revision_patch_entries`);
	if (migrated[0]?.count !== entries.length) {
		throw new Error("Revision patch ledger migration did not preserve every legacy entry.");
	}
}

async function contractLegacyTables(conn: MigrationConn): Promise<void> {
	await conn.run(sql`DROP TABLE entity_delta_entries`);
	await conn.run(sql`DROP TABLE context_delta_entries`);
	await conn.run(sql`DROP TABLE context_term_delta_entries`);
	await conn.run(sql`CREATE INDEX revision_patch_entries_project_idx
		ON revision_patch_entries (tenant_id, project_id)`);
	await conn.run(sql`CREATE INDEX revision_patch_entries_chain_idx
		ON revision_patch_entries (tenant_id, project_id, record_kind, record_key, revision)`);
}

export const revisionPatchLedgerMigration: Migration = {
	id: "0021-revision-patch-ledger",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite revision patch ledger migration requires the SQLite dialect.");
		}
		await createLedger(conn);
		const entries = await readLegacyEntries(conn);
		await copyEntries(conn, entries);
		await contractLegacyTables(conn);
	}
};