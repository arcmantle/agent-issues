import { encodeContextRecordKey, encodeEntityRecordKey } from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

type EntityPatchRow = { id: string; entity_id: string };
type ContextPatchRow = { id: string; context_key: string };
type ContextTermPatchRow = { id: string; context_key: string; term: string };

function encodeLegacyContextTermRecordKey(contextKey: string, term: string): string {
	return `${Buffer.byteLength(contextKey, "utf8")}:${contextKey}${Buffer.byteLength(term, "utf8")}:${term}`;
}

async function resolveContextProjectId(conn: Parameters<Migration["up"]>[0], tenantId: string, contextKey: string): Promise<string> {
	const rows = await conn.all<{ project_id: string | null }>(sql`SELECT scope.project_id
		FROM contexts AS context
		LEFT JOIN entities AS scope
			ON scope.tenant_id = context.tenant_id AND scope.id = context.scope_entity_id
		WHERE context.tenant_id = ${tenantId} AND context.key = ${contextKey}`);
	if (rows[0]?.project_id) {
		return rows[0].project_id;
	}
	if (contextKey === "default") {
		return "PROJ0";
	}
	if (contextKey.startsWith("default:") && contextKey.length > "default:".length) {
		return contextKey.slice("default:".length);
	}
	throw new Error(`Cannot assign context ${contextKey} revision patches to a project.`);
}

export const revisionPatchLedgerMigration: Migration = {
	id: "0014-revision-patch-ledger",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("PostgreSQL revision patch ledger migration requires the PostgreSQL dialect.");
		}
		await conn.run(sql`CREATE TABLE revision_patch_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			record_kind TEXT NOT NULL CHECK (record_kind IN ('entity', 'context', 'context-term')),
			record_key TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			author TEXT NOT NULL,
			patch_format INTEGER NOT NULL CHECK (patch_format > 0),
			reverse_patch BYTEA NOT NULL,
			source_hash TEXT NOT NULL,
			target_hash TEXT NOT NULL,
			restored_from_revision INTEGER,
			created_at TEXT NOT NULL,
			CONSTRAINT revision_patch_entries_chain_idx UNIQUE (tenant_id, project_id, record_kind, record_key, revision)
		)`);

		const entityRows = await conn.all<EntityPatchRow & { tenant_id: string; project_id: string | null }>(sql`SELECT delta.id, delta.tenant_id, delta.entity_id, head.project_id
			FROM entity_delta_entries AS delta
			LEFT JOIN entities AS head ON head.tenant_id = delta.tenant_id AND head.id = delta.entity_id`);
		for (const row of entityRows) {
			if (!row.project_id) throw new Error(`Cannot assign entity ${row.entity_id} revision patches to a project.`);
			await conn.run(sql`INSERT INTO revision_patch_entries
				SELECT id, tenant_id, ${row.project_id}, 'entity', ${encodeEntityRecordKey(row.entity_id)}, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
				FROM entity_delta_entries WHERE id = ${row.id}`);
		}

		const contextRows = await conn.all<ContextPatchRow & { tenant_id: string }>(sql`SELECT id, tenant_id, context_key FROM context_delta_entries`);
		for (const row of contextRows) {
			const projectId = await resolveContextProjectId(conn, row.tenant_id, row.context_key);
			await conn.run(sql`INSERT INTO revision_patch_entries
				SELECT id, tenant_id, ${projectId}, 'context', ${encodeContextRecordKey(row.context_key)}, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
				FROM context_delta_entries WHERE id = ${row.id}`);
		}

		const termRows = await conn.all<ContextTermPatchRow & { tenant_id: string }>(sql`SELECT id, tenant_id, context_key, term FROM context_term_delta_entries`);
		for (const row of termRows) {
			const projectId = await resolveContextProjectId(conn, row.tenant_id, row.context_key);
			await conn.run(sql`INSERT INTO revision_patch_entries
				SELECT id, tenant_id, ${projectId}, 'context-term', ${encodeLegacyContextTermRecordKey(row.context_key, row.term)}, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
				FROM context_term_delta_entries WHERE id = ${row.id}`);
		}

		const counts = await conn.all<{ source_count: string; target_count: string }>(sql`SELECT
			(SELECT count(*) FROM entity_delta_entries) + (SELECT count(*) FROM context_delta_entries) + (SELECT count(*) FROM context_term_delta_entries) AS source_count,
			(SELECT count(*) FROM revision_patch_entries) AS target_count`);
		if (counts[0]?.source_count !== counts[0]?.target_count) {
			throw new Error("Revision patch ledger migration did not preserve every legacy entry.");
		}

		await conn.run(sql`DROP TABLE entity_delta_entries, context_delta_entries, context_term_delta_entries`);
		await conn.run(sql`CREATE INDEX revision_patch_entries_project_idx ON revision_patch_entries (tenant_id, project_id)`);
		await conn.run(sql`ALTER TABLE revision_patch_entries ENABLE ROW LEVEL SECURITY`);
		await conn.run(sql`ALTER TABLE revision_patch_entries FORCE ROW LEVEL SECURITY`);
		await conn.run(sql`CREATE POLICY tenant_isolation ON revision_patch_entries
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`);
	}
};