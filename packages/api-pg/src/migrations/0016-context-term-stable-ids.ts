import {
	applyReverseFieldPatch,
	computeContextTermContentHash,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	createReverseFieldPatch,
	deriveMigratedContextTermId,
	encodeContextTermRecordKey,
	type ReverseFieldPatchTransition
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

type HeadRow = { tenant_id: string; context_key: string; term: string; definition: string; avoid_terms: string; tombstone: boolean };
type PatchRow = { id: string; revision: number; patch_format: number; reverse_patch: Buffer; source_hash: Buffer; target_hash: Buffer };
const legacyRegistry = CONTEXT_TERM_REVERSE_PATCH_REGISTRY.slice(0, 3);

function parseStringArray(value: string): string[] {
	if (value === "") return [];
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("Cannot migrate malformed context-term avoid list.");
	return parsed;
}

function legacyRecordKey(contextKey: string, term: string): string {
	return `${Buffer.byteLength(contextKey, "utf8")}:${contextKey}${Buffer.byteLength(term, "utf8")}:${term}`;
}

function decodeTransition(row: PatchRow): ReverseFieldPatchTransition {
	return { patchFormat: row.patch_format, reversePatch: row.reverse_patch, sourceHash: row.source_hash.toString("hex"), targetHash: row.target_hash.toString("hex") };
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
	id: "0016-context-term-stable-ids",
	async up(conn) {
		if (conn.dialect !== "postgres") throw new Error("PostgreSQL context-term stable ID migration requires the PostgreSQL dialect.");
		const heads = await conn.all<HeadRow>(sql`SELECT tenant_id, context_key, term, definition, avoid_terms, tombstone FROM context_terms`);
		await conn.run(sql`ALTER TABLE context_terms ADD COLUMN id UUID`);
		for (const head of heads) {
			const id = deriveMigratedContextTermId(head.context_key, head.term);
			const avoid = parseStringArray(head.avoid_terms);
			const patches = await conn.all<PatchRow>(sql`SELECT id, revision, patch_format, reverse_patch, source_hash, target_hash FROM revision_patch_entries
				WHERE tenant_id = ${head.tenant_id} AND record_kind = 'context-term' AND record_key = ${legacyRecordKey(head.context_key, head.term)} ORDER BY revision DESC`);
			let successor = { definition: head.definition, avoid, tombstone: head.tombstone };
			for (const patch of patches) {
				const predecessor = applyLegacyTransition(successor, decodeTransition(patch));
				const transition = createReverseFieldPatch({ term: head.term, ...successor }, { term: head.term, ...predecessor }, CONTEXT_TERM_REVERSE_PATCH_REGISTRY);
				await conn.run(sql`UPDATE revision_patch_entries SET record_key = ${encodeContextTermRecordKey(id)}, patch_format = ${transition.patchFormat}, reverse_patch = ${Buffer.from(transition.reversePatch)}, source_hash = ${Buffer.from(transition.sourceHash, "hex")}, target_hash = ${Buffer.from(transition.targetHash, "hex")} WHERE id = ${patch.id}`);
				successor = predecessor;
			}
			await conn.run(sql`UPDATE context_terms SET id = ${id}::uuid, content_hash = ${computeContextTermContentHash(head.term, head.definition, avoid, head.tombstone)} WHERE tenant_id = ${head.tenant_id} AND context_key = ${head.context_key} AND term = ${head.term}`);
		}
		await conn.run(sql`ALTER TABLE context_terms ALTER COLUMN id SET NOT NULL`);
		await conn.run(sql`CREATE UNIQUE INDEX context_terms_tenant_id_idx ON context_terms (tenant_id, id)`);
	}
};