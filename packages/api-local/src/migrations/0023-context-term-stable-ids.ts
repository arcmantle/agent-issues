import {
	applyReverseFieldPatch,
	computeContextTermContentHash,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	createReverseFieldPatch,
	deriveMigratedContextTermId,
	encodeContextTermRecordKey,
	type Migration,
	type ReverseFieldPatchTransition
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

type ContextTermHeadRow = {
	tenant_id: string;
	context_key: string;
	term: string;
	definition: string;
	avoid_terms: string;
	tombstone: number;
};

type ContextTermPatchRow = {
	id: string;
	revision: number;
	patch_format: number;
	reverse_patch: Uint8Array;
	source_hash: Uint8Array;
	target_hash: Uint8Array;
};

const legacyRegistry = CONTEXT_TERM_REVERSE_PATCH_REGISTRY.slice(0, 3);

function parseStringArray(value: string): string[] {
	if (value === "") return [];
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
		throw new Error("Cannot migrate malformed context-term avoid list.");
	}
	return parsed;
}

function legacyRecordKey(contextKey: string, term: string): string {
	return `${Buffer.byteLength(contextKey, "utf8")}:${contextKey}${Buffer.byteLength(term, "utf8")}:${term}`;
}

function decodeTransition(row: ContextTermPatchRow): ReverseFieldPatchTransition {
	return {
		patchFormat: row.patch_format,
		reversePatch: row.reverse_patch,
		sourceHash: Buffer.from(row.source_hash).toString("hex"),
		targetHash: Buffer.from(row.target_hash).toString("hex")
	};
}

function applyLegacyTransition(
	successor: { definition: string; avoid: string[]; tombstone: boolean },
	transition: ReverseFieldPatchTransition
): { definition: string; avoid: string[]; tombstone: boolean } {
	try {
		return applyReverseFieldPatch(successor, transition, legacyRegistry);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("source hash mismatch")) throw error;
		const predecessor = applyReverseFieldPatch(successor, transition, CONTEXT_TERM_REVERSE_PATCH_REGISTRY) as typeof successor & { term?: string };
		return { definition: predecessor.definition, avoid: predecessor.avoid, tombstone: predecessor.tombstone };
	}
}

export const contextTermStableIdsMigration: Migration = {
	id: "0023-context-term-stable-ids",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite context-term stable ID migration requires the SQLite dialect.");
		}
		const heads = await conn.all<ContextTermHeadRow>(sql`SELECT tenant_id, context_key, term, definition, avoid_terms, tombstone FROM context_terms`);
		await conn.run(sql`ALTER TABLE context_terms ADD COLUMN id TEXT`);
		for (const head of heads) {
			const id = deriveMigratedContextTermId(head.context_key, head.term);
			const avoid = parseStringArray(head.avoid_terms);
			const patches = await conn.all<ContextTermPatchRow>(sql`SELECT id, revision, patch_format, reverse_patch, source_hash, target_hash
				FROM revision_patch_entries
				WHERE tenant_id = ${head.tenant_id} AND record_kind = 'context-term'
					AND record_key = ${legacyRecordKey(head.context_key, head.term)}
				ORDER BY revision DESC`);
			let successor = { definition: head.definition, avoid, tombstone: Boolean(head.tombstone) };
			for (const patch of patches) {
				const predecessor = applyLegacyTransition(successor, decodeTransition(patch));
				const transition = createReverseFieldPatch(
					{ term: head.term, ...successor },
					{ term: head.term, ...predecessor },
					CONTEXT_TERM_REVERSE_PATCH_REGISTRY
				);
				await conn.run(sql`UPDATE revision_patch_entries SET
					record_key = ${encodeContextTermRecordKey(id)},
					patch_format = ${transition.patchFormat},
					reverse_patch = ${transition.reversePatch},
					source_hash = ${Buffer.from(transition.sourceHash, "hex")},
					target_hash = ${Buffer.from(transition.targetHash, "hex")}
					WHERE id = ${patch.id}`);
				successor = predecessor;
			}
			await conn.run(sql`UPDATE context_terms SET id = ${id}, content_hash = ${computeContextTermContentHash(head.term, head.definition, avoid, Boolean(head.tombstone))}
				WHERE tenant_id = ${head.tenant_id} AND context_key = ${head.context_key} AND term = ${head.term}`);
		}
		await conn.run(sql`CREATE TABLE context_terms_stable (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			context_key TEXT NOT NULL,
			term TEXT NOT NULL,
			definition TEXT NOT NULL,
			avoid_terms TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 1,
			content_hash TEXT NOT NULL DEFAULT '',
			tombstone INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, context_key, term),
			FOREIGN KEY (tenant_id, context_key) REFERENCES contexts (tenant_id, key) ON DELETE CASCADE,
			UNIQUE (tenant_id, id)
		)`);
		await conn.run(sql`INSERT INTO context_terms_stable
			(tenant_id, id, context_key, term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at)
			SELECT tenant_id, id, context_key, term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at FROM context_terms`);
		await conn.run(sql`DROP TABLE context_terms`);
		await conn.run(sql`ALTER TABLE context_terms_stable RENAME TO context_terms`);
		await conn.run(sql`CREATE INDEX context_terms_tenant_context_key_idx ON context_terms (tenant_id, context_key)`);
		await conn.run(sql`CREATE UNIQUE INDEX context_terms_tenant_id_idx ON context_terms (tenant_id, id)`);
	}
};