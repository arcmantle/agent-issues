import {
	CONTEXT_REVERSE_PATCH_REGISTRY,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	createReverseFieldPatch,
	ENTITY_REVERSE_PATCH_REGISTRY,
	type Migration,
	type MigrationConn,
	type ReversePatchRegistry
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

type LegacyDelta = {
	id: string;
	tenant_id: string;
	revision: number;
	author: string;
	restored_from_revision: number | null;
	created_at: string;
};

type EntityDelta = LegacyDelta & {
	entity_id: string;
	prior_title: string;
	prior_body: string;
	prior_body_source: string;
	prior_status: string | null;
	prior_parent_id: string | null;
	prior_parent_changed: number;
	prior_tombstone: number | null;
};

type ContextDelta = LegacyDelta & {
	context_key: string;
	prior_title: string;
	prior_summary: string;
};

type ContextTermDelta = LegacyDelta & {
	context_key: string;
	term: string;
	prior_definition: string;
	prior_avoid_terms: string;
	prior_tombstone: number;
};

type TransitionRow = LegacyDelta & {
	logicalId: string;
	patchFormat: number;
	reversePatch: Uint8Array;
	sourceHash: string;
	targetHash: string;
};

function parseStringArray(value: string): string[] {
	if (value === "") {
		return [];
	}
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
		throw new Error("Cannot migrate malformed context-term avoid list.");
	}
	return parsed;
}

function convertChain<State extends object, Delta extends LegacyDelta>(
	head: State,
	deltas: Delta[],
	registry: ReversePatchRegistry,
	logicalId: string,
	predecessorOf: (state: State, delta: Delta) => State
): TransitionRow[] {
	let source = head;
	const converted: TransitionRow[] = [];
	for (const delta of deltas.sort((left, right) => right.revision - left.revision)) {
		const target = predecessorOf(source, delta);
		const transition = createReverseFieldPatch(source, target, registry);
		converted.push({ ...delta, logicalId, ...transition });
		source = target;
	}
	return converted;
}

async function createCompactTables(conn: MigrationConn): Promise<void> {
	await conn.run(sql`CREATE TABLE entity_delta_entries_compact (
		id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, entity_id TEXT NOT NULL,
		revision INTEGER NOT NULL, author TEXT NOT NULL, patch_format INTEGER NOT NULL,
		reverse_patch BLOB NOT NULL, source_hash TEXT NOT NULL, target_hash TEXT NOT NULL,
		restored_from_revision INTEGER, created_at TEXT NOT NULL,
		UNIQUE (tenant_id, entity_id, revision)
	)`);
	await conn.run(sql`CREATE TABLE context_delta_entries_compact (
		id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, context_key TEXT NOT NULL,
		revision INTEGER NOT NULL, author TEXT NOT NULL, patch_format INTEGER NOT NULL,
		reverse_patch BLOB NOT NULL, source_hash TEXT NOT NULL, target_hash TEXT NOT NULL,
		restored_from_revision INTEGER, created_at TEXT NOT NULL,
		UNIQUE (tenant_id, context_key, revision)
	)`);
	await conn.run(sql`CREATE TABLE context_term_delta_entries_compact (
		id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, context_key TEXT NOT NULL, term TEXT NOT NULL,
		revision INTEGER NOT NULL, author TEXT NOT NULL, patch_format INTEGER NOT NULL,
		reverse_patch BLOB NOT NULL, source_hash TEXT NOT NULL, target_hash TEXT NOT NULL,
		restored_from_revision INTEGER, created_at TEXT NOT NULL,
		UNIQUE (tenant_id, context_key, term, revision)
	)`);
}

async function migrateEntities(conn: MigrationConn): Promise<void> {
	const heads = await conn.all<{
		tenant_id: string; id: string; title: string; body: string; body_source: string;
		status: string; revision: number; tombstone: number; parent_id: string | null;
	}>(sql`SELECT entity.tenant_id, entity.id, entity.title, entity.body, entity.body_source,
		entity.status, entity.revision, entity.tombstone,
		(SELECT relation.from_id FROM relations AS relation
		 WHERE relation.tenant_id = entity.tenant_id AND relation.to_id = entity.id
		   AND relation.type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')
		 LIMIT 1) AS parent_id
		FROM entities AS entity`);
	for (const head of heads) {
		const deltas = await conn.all<EntityDelta>(sql`SELECT * FROM entity_delta_entries
			WHERE tenant_id = ${head.tenant_id} AND entity_id = ${head.id} ORDER BY revision DESC`);
		const state = { title: head.title, body: head.body, bodySource: head.body_source, status: head.status, parentId: head.parent_id, tombstone: Boolean(head.tombstone) };
		const converted = convertChain(state, deltas, ENTITY_REVERSE_PATCH_REGISTRY, head.id, (current, delta) => ({
			title: delta.prior_title,
			body: delta.prior_body,
			bodySource: delta.prior_body_source,
			status: delta.prior_status ?? current.status,
			parentId: delta.prior_parent_changed ? delta.prior_parent_id : current.parentId,
			tombstone: delta.prior_tombstone === null ? current.tombstone : Boolean(delta.prior_tombstone)
		}));
		for (const row of converted) {
			await conn.run(sql`INSERT INTO entity_delta_entries_compact
				(id, tenant_id, entity_id, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
				VALUES (${row.id}, ${row.tenant_id}, ${row.logicalId}, ${row.revision}, ${row.author}, ${row.patchFormat}, ${row.reversePatch}, ${row.sourceHash}, ${row.targetHash}, ${row.restored_from_revision}, ${row.created_at})`);
		}
	}
}

async function migrateContexts(conn: MigrationConn): Promise<void> {
	const heads = await conn.all<{ tenant_id: string; key: string; title: string; summary: string }>(sql`SELECT tenant_id, key, title, summary FROM contexts`);
	for (const head of heads) {
		const deltas = await conn.all<ContextDelta>(sql`SELECT * FROM context_delta_entries
			WHERE tenant_id = ${head.tenant_id} AND context_key = ${head.key} ORDER BY revision DESC`);
		const state = { title: head.title, summary: head.summary };
		const converted = convertChain(state, deltas, CONTEXT_REVERSE_PATCH_REGISTRY, head.key, (_current, delta) => ({ title: delta.prior_title, summary: delta.prior_summary }));
		for (const row of converted) {
			await conn.run(sql`INSERT INTO context_delta_entries_compact
				(id, tenant_id, context_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
				VALUES (${row.id}, ${row.tenant_id}, ${row.logicalId}, ${row.revision}, ${row.author}, ${row.patchFormat}, ${row.reversePatch}, ${row.sourceHash}, ${row.targetHash}, ${row.restored_from_revision}, ${row.created_at})`);
		}
	}
}

async function migrateContextTerms(conn: MigrationConn): Promise<void> {
	const heads = await conn.all<{ tenant_id: string; context_key: string; term: string; definition: string; avoid_terms: string; tombstone: number }>(sql`SELECT tenant_id, context_key, term, definition, avoid_terms, tombstone FROM context_terms`);
	for (const head of heads) {
		const deltas = await conn.all<ContextTermDelta>(sql`SELECT * FROM context_term_delta_entries
			WHERE tenant_id = ${head.tenant_id} AND context_key = ${head.context_key} AND term = ${head.term} ORDER BY revision DESC`);
		const state = { definition: head.definition, avoid: parseStringArray(head.avoid_terms), tombstone: Boolean(head.tombstone) };
		const logicalId = `${head.context_key}\u0000${head.term}`;
		const converted = convertChain(state, deltas, CONTEXT_TERM_REVERSE_PATCH_REGISTRY, logicalId, (_current, delta) => ({
			definition: delta.prior_definition,
			avoid: parseStringArray(delta.prior_avoid_terms),
			tombstone: Boolean(delta.prior_tombstone)
		}));
		for (const row of converted) {
			await conn.run(sql`INSERT INTO context_term_delta_entries_compact
				(id, tenant_id, context_key, term, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
				VALUES (${row.id}, ${row.tenant_id}, ${head.context_key}, ${head.term}, ${row.revision}, ${row.author}, ${row.patchFormat}, ${row.reversePatch}, ${row.sourceHash}, ${row.targetHash}, ${row.restored_from_revision}, ${row.created_at})`);
		}
	}
}

async function swapTables(conn: MigrationConn): Promise<void> {
	for (const table of ["entity_delta_entries", "context_delta_entries", "context_term_delta_entries"] as const) {
		await conn.run(sql.raw(`DROP TABLE ${table}`));
		await conn.run(sql.raw(`ALTER TABLE ${table}_compact RENAME TO ${table}`));
	}
	await conn.run(sql`CREATE INDEX entity_delta_entries_tenant_entity_revision_idx ON entity_delta_entries (tenant_id, entity_id, revision)`);
	await conn.run(sql`CREATE INDEX context_delta_entries_tenant_key_revision_idx ON context_delta_entries (tenant_id, context_key, revision)`);
	await conn.run(sql`CREATE INDEX context_term_delta_entries_tenant_term_revision_idx ON context_term_delta_entries (tenant_id, context_key, term, revision)`);
}

export const compactReverseFieldPatchesMigration: Migration = {
	id: "0020-compact-reverse-field-patches",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite compact patch migration requires the SQLite dialect.");
		}
		await createCompactTables(conn);
		await migrateEntities(conn);
		await migrateContexts(conn);
		await migrateContextTerms(conn);
		await swapTables(conn);
	}
};
