import { createHash, randomUUID } from "node:crypto";

import {
	addContextTermRevisionColumns,
	createContextTermDeltaEntriesIndex,
	createContextTermDeltaEntriesTable,
	RESERVED_SYSTEM_AUTHOR
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const contextTermRevisionDeltaMigration: Migration = {
	id: "0009-context-term-revision-delta",
	up: async (conn) => {
		await addContextTermRevisionColumns(conn);
		await createContextTermDeltaEntriesTable(conn);
		await createContextTermDeltaEntriesIndex(conn);
		const rows = await conn.all<{ tenant_id: string; context_key: string; term: string; definition: string; avoid_terms: string; created_at: string }>(
			sql`SELECT tenant_id, context_key, term, definition, avoid_terms, created_at FROM context_terms`
		);
		for (const row of rows) {
			const avoid = parseAvoidTerms(row.avoid_terms);
			const contentHash = createHash("sha256").update(JSON.stringify({ definition: row.definition, avoid, tombstone: false })).digest("hex");
			await conn.run(sql`UPDATE context_terms SET content_hash = ${contentHash} WHERE tenant_id = ${row.tenant_id} AND context_key = ${row.context_key} AND term = ${row.term} AND content_hash = ''`);
			await conn.run(sql`INSERT INTO context_term_delta_entries (id, tenant_id, context_key, term, revision, author, prior_definition, prior_avoid_terms, prior_tombstone, created_at)
				VALUES (${randomUUID()}, ${row.tenant_id}, ${row.context_key}, ${row.term}, 1, ${RESERVED_SYSTEM_AUTHOR}, ${row.definition}, ${JSON.stringify(avoid)}, FALSE, ${row.created_at})
				ON CONFLICT (tenant_id, context_key, term, revision) DO NOTHING`);
		}
		await conn.run(sql`ALTER TABLE context_term_delta_entries ENABLE ROW LEVEL SECURITY`);
		await conn.run(sql`ALTER TABLE context_term_delta_entries FORCE ROW LEVEL SECURITY`);
		const policies = await conn.all(sql`SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'context_term_delta_entries' AND policyname = 'tenant_isolation'`);
		if (policies.length === 0) {
			await conn.run(sql`CREATE POLICY tenant_isolation ON context_term_delta_entries USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`);
		}
	}
};

function parseAvoidTerms(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}