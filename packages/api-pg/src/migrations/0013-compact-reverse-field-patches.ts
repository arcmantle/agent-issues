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
	revision: number;
};

type EntityDelta = LegacyDelta & {
	prior_title: string;
	prior_body: string;
	prior_body_source: string;
	prior_status: string | null;
	prior_parent_id: string | null;
	prior_parent_changed: boolean;
	prior_tombstone: boolean | null;
};

type ContextDelta = LegacyDelta & {
	prior_title: string;
	prior_summary: string;
};

type ContextTermDelta = LegacyDelta & {
	prior_definition: string;
	prior_avoid_terms: string;
	prior_tombstone: boolean;
};

function parseStringArray(value: string): string[] {
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
		throw new Error("Cannot migrate malformed context-term avoid list.");
	}
	return parsed;
}

async function writeTransition<State extends object>(
	conn: MigrationConn,
	table: string,
	id: string,
	source: State,
	target: State,
	registry: ReversePatchRegistry
): Promise<void> {
	const transition = createReverseFieldPatch(source, target, registry);
	await conn.run(sql.raw(`UPDATE ${table} SET patch_format = ${transition.patchFormat}, reverse_patch = '\\x${Buffer.from(transition.reversePatch).toString("hex")}'::bytea, source_hash = '${transition.sourceHash}', target_hash = '${transition.targetHash}' WHERE id = '${id.replaceAll("'", "''")}'`));
}

async function addCompactColumns(conn: MigrationConn): Promise<void> {
	for (const table of ["entity_delta_entries", "context_delta_entries", "context_term_delta_entries"] as const) {
		await conn.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN patch_format INTEGER, ADD COLUMN reverse_patch BYTEA, ADD COLUMN source_hash TEXT, ADD COLUMN target_hash TEXT`));
	}
}

async function migrateEntities(conn: MigrationConn): Promise<void> {
	const heads = await conn.all<{
		tenant_id: string; id: string; title: string; body: string; body_source: string;
		status: string; tombstone: boolean; parent_id: string | null;
	}>(sql`SELECT entity.tenant_id, entity.id, entity.title, entity.body, entity.body_source,
		entity.status, entity.tombstone,
		(SELECT relation.from_id FROM relations AS relation
		 WHERE relation.tenant_id = entity.tenant_id AND relation.to_id = entity.id
		   AND relation.type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')
		 LIMIT 1) AS parent_id
		FROM entities AS entity`);
	for (const head of heads) {
		const deltas = await conn.all<EntityDelta>(sql`SELECT * FROM entity_delta_entries
			WHERE tenant_id = ${head.tenant_id} AND entity_id = ${head.id} ORDER BY revision DESC`);
		let source = { title: head.title, body: head.body, bodySource: head.body_source, status: head.status, parentId: head.parent_id, tombstone: head.tombstone };
		for (const delta of deltas) {
			const target = {
				title: delta.prior_title,
				body: delta.prior_body,
				bodySource: delta.prior_body_source,
				status: delta.prior_status ?? source.status,
				parentId: delta.prior_parent_changed ? delta.prior_parent_id : source.parentId,
				tombstone: delta.prior_tombstone ?? source.tombstone
			};
			await writeTransition(conn, "entity_delta_entries", delta.id, source, target, ENTITY_REVERSE_PATCH_REGISTRY);
			source = target;
		}
	}
}

async function migrateContexts(conn: MigrationConn): Promise<void> {
	const heads = await conn.all<{ tenant_id: string; key: string; title: string; summary: string }>(sql`SELECT tenant_id, key, title, summary FROM contexts`);
	for (const head of heads) {
		const deltas = await conn.all<ContextDelta>(sql`SELECT * FROM context_delta_entries
			WHERE tenant_id = ${head.tenant_id} AND context_key = ${head.key} ORDER BY revision DESC`);
		let source = { title: head.title, summary: head.summary };
		for (const delta of deltas) {
			const target = { title: delta.prior_title, summary: delta.prior_summary };
			await writeTransition(conn, "context_delta_entries", delta.id, source, target, CONTEXT_REVERSE_PATCH_REGISTRY);
			source = target;
		}
	}
}

async function migrateContextTerms(conn: MigrationConn): Promise<void> {
	const heads = await conn.all<{ tenant_id: string; context_key: string; term: string; definition: string; avoid_terms: string; tombstone: boolean }>(sql`SELECT tenant_id, context_key, term, definition, avoid_terms, tombstone FROM context_terms`);
	for (const head of heads) {
		const deltas = await conn.all<ContextTermDelta>(sql`SELECT * FROM context_term_delta_entries
			WHERE tenant_id = ${head.tenant_id} AND context_key = ${head.context_key} AND term = ${head.term} ORDER BY revision DESC`);
		let source = { definition: head.definition, avoid: parseStringArray(head.avoid_terms), tombstone: head.tombstone };
		for (const delta of deltas) {
			const target = { definition: delta.prior_definition, avoid: parseStringArray(delta.prior_avoid_terms), tombstone: delta.prior_tombstone };
			await writeTransition(conn, "context_term_delta_entries", delta.id, source, target, CONTEXT_TERM_REVERSE_PATCH_REGISTRY);
			source = target;
		}
	}
}

async function contractLegacyColumns(conn: MigrationConn): Promise<void> {
	for (const table of ["entity_delta_entries", "context_delta_entries", "context_term_delta_entries"] as const) {
		await conn.run(sql.raw(`ALTER TABLE ${table} ALTER COLUMN patch_format SET NOT NULL, ALTER COLUMN reverse_patch SET NOT NULL, ALTER COLUMN source_hash SET NOT NULL, ALTER COLUMN target_hash SET NOT NULL`));
	}
	await conn.run(sql`ALTER TABLE entity_delta_entries DROP COLUMN prior_title, DROP COLUMN prior_body, DROP COLUMN prior_body_source, DROP COLUMN prior_status, DROP COLUMN prior_parent_id, DROP COLUMN prior_parent_changed, DROP COLUMN prior_tombstone`);
	await conn.run(sql`ALTER TABLE context_delta_entries DROP COLUMN prior_title, DROP COLUMN prior_summary`);
	await conn.run(sql`ALTER TABLE context_term_delta_entries DROP COLUMN prior_definition, DROP COLUMN prior_avoid_terms, DROP COLUMN prior_tombstone`);
}

export const compactReverseFieldPatchesMigration: Migration = {
	id: "0013-compact-reverse-field-patches",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("PostgreSQL compact patch migration requires the PostgreSQL dialect.");
		}
		await addCompactColumns(conn);
		await migrateEntities(conn);
		await migrateContexts(conn);
		await migrateContextTerms(conn);
		await contractLegacyColumns(conn);
	}
};
