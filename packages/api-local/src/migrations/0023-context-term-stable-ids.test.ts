import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
	applyReverseFieldPatch,
	computeContextTermContentHash,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	createReverseFieldPatch,
	deriveMigratedContextTermId,
	encodeContextTermRecordKey
} from "@agent-issues/core";
import { runMigrations } from "../db/migration-runner.js";
import { contextTermStableIdsMigration } from "./0023-context-term-stable-ids.js";

const databases: Database.Database[] = [];
const legacyRegistry = CONTEXT_TERM_REVERSE_PATCH_REGISTRY.slice(0, 3);

function legacyRecordKey(contextKey: string, term: string): string {
	return `${Buffer.byteLength(contextKey, "utf8")}:${contextKey}${Buffer.byteLength(term, "utf8")}:${term}`;
}

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

describe("context term stable ID migration", () => {
	it("backfills deterministic IDs and losslessly rewrites existing term history", async () => {
		const db = new Database(":memory:");
		databases.push(db);
		db.exec(`
			CREATE TABLE contexts (tenant_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (tenant_id, key));
			CREATE TABLE context_terms (tenant_id TEXT NOT NULL, context_key TEXT NOT NULL, term TEXT NOT NULL, definition TEXT NOT NULL, avoid_terms TEXT NOT NULL, revision INTEGER NOT NULL, content_hash TEXT NOT NULL, tombstone INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, context_key, term));
			CREATE TABLE revision_patch_entries (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, record_kind TEXT NOT NULL, record_key TEXT NOT NULL, revision INTEGER NOT NULL, author TEXT NOT NULL, patch_format INTEGER NOT NULL, reverse_patch BLOB NOT NULL, source_hash BLOB NOT NULL, target_hash BLOB NOT NULL, restored_from_revision INTEGER, created_at TEXT NOT NULL, UNIQUE (tenant_id, project_id, record_kind, record_key, revision));
		`);
		const first = { definition: "Initial.", avoid: ["request"], tombstone: false };
		const second = { definition: "Updated.", avoid: ["draft"], tombstone: false };
		const third = { ...second, tombstone: true };
		const transitions = [
			{ revision: 3, ...createReverseFieldPatch(third, second, legacyRegistry) },
			{ revision: 2, ...createReverseFieldPatch(second, first, legacyRegistry) },
			{ revision: 1, ...createReverseFieldPatch(first, first, legacyRegistry) }
		];
		db.prepare("INSERT INTO contexts VALUES (?, ?)").run("tenant-a", "default:PROJ1");
		db.prepare("INSERT INTO context_terms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("tenant-a", "default:PROJ1", "Order", third.definition, JSON.stringify(third.avoid), 3, "legacy-head-hash", 1, "2026-01-01", "2026-01-03");
		for (const transition of transitions) {
			db.prepare("INSERT INTO revision_patch_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`patch-${transition.revision}`, "tenant-a", "PROJ1", "context-term", legacyRecordKey("default:PROJ1", "Order"), transition.revision, "system", transition.patchFormat, Buffer.from(transition.reversePatch), Buffer.from(transition.sourceHash, "hex"), Buffer.from(transition.targetHash, "hex"), null, `2026-01-0${transition.revision}`);
		}

		await runMigrations(db, [contextTermStableIdsMigration]);

		const id = deriveMigratedContextTermId("default:PROJ1", "Order");
		expect(db.prepare("SELECT id, content_hash FROM context_terms").get()).toEqual({ id, content_hash: computeContextTermContentHash("Order", third.definition, third.avoid, true) });
		const rows = db.prepare("SELECT revision, record_key, reverse_patch, lower(hex(source_hash)) AS source_hash, lower(hex(target_hash)) AS target_hash FROM revision_patch_entries ORDER BY revision DESC").all() as Array<{ revision: number; record_key: string; reverse_patch: Buffer; source_hash: string; target_hash: string }>;
		expect(rows.every((row) => row.record_key === encodeContextTermRecordKey(id))).toBe(true);
		let state = { term: "Order", ...third };
		for (const row of rows) state = applyReverseFieldPatch(state, { patchFormat: 1, reversePatch: row.reverse_patch, sourceHash: row.source_hash, targetHash: row.target_hash }, CONTEXT_TERM_REVERSE_PATCH_REGISTRY);
		expect(state).toEqual({ term: "Order", ...first });
	});
});