import { sql } from "drizzle-orm";

import {
	getAllowedRelationType,
	ID_PREFIX,
	isBodySource,
	isEntityKind,
	isStructuralRelationType,
	mergeCanonicalChainBundles,
	type CanonicalChainBundle,
	type CanonicalChainImportResult,
	type CanonicalContextChain,
	type CanonicalContextTermChain,
	type CanonicalEntityChain,
	type EntityKind
} from "@agent-issues/core";

import type { SqliteExecutor } from "../../db/sqlite-executor.js";

type EntityHeadRow = { id: string; kind: string; title: string; body: string; body_source: string; status: string; revision: number; content_hash: string; tombstone: number; created_at: string; updated_at: string; parent_id: string | null };
type EntityDeltaRow = { id: string; entity_id: string; revision: number; author: string; prior_title: string; prior_body: string; prior_body_source: string; prior_status: string | null; prior_parent_id: string | null; prior_parent_changed: number; prior_tombstone: number | null; restored_from_revision: number | null; created_at: string };
type ContextHeadRow = { key: string; scope_entity_id: string | null; title: string; summary: string; revision: number; content_hash: string; created_at: string; updated_at: string };
type ContextDeltaRow = { id: string; context_key: string; revision: number; author: string; prior_title: string; prior_summary: string; restored_from_revision: number | null; created_at: string };
type ContextTermHeadRow = { context_key: string; term: string; definition: string; avoid_terms: string; tombstone: number; revision: number; content_hash: string; created_at: string; updated_at: string };
type ContextTermDeltaRow = { id: string; context_key: string; term: string; revision: number; author: string; prior_definition: string; prior_avoid_terms: string; prior_tombstone: number; restored_from_revision: number | null; created_at: string };

export function exportCanonicalChains(db: SqliteExecutor): CanonicalChainBundle {
	const entityRows = db.drizzle.all(sql`SELECT entities.*,
		(SELECT relations.from_id FROM relations WHERE relations.tenant_id = entities.tenant_id AND relations.to_id = entities.id AND relations.type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes') ORDER BY relations.from_id LIMIT 1) AS parent_id
		FROM entities WHERE tenant_id = ${db.tenantId}`) as EntityHeadRow[];
	const entityDeltas = db.drizzle.all(sql`SELECT * FROM entity_delta_entries WHERE tenant_id = ${db.tenantId} ORDER BY entity_id, revision`) as EntityDeltaRow[];
	const contextRows = db.drizzle.all(sql`SELECT * FROM contexts WHERE tenant_id = ${db.tenantId}`) as ContextHeadRow[];
	const contextDeltas = db.drizzle.all(sql`SELECT * FROM context_delta_entries WHERE tenant_id = ${db.tenantId} ORDER BY context_key, revision`) as ContextDeltaRow[];
	const termRows = db.drizzle.all(sql`SELECT * FROM context_terms WHERE tenant_id = ${db.tenantId}`) as ContextTermHeadRow[];
	const termDeltas = db.drizzle.all(sql`SELECT * FROM context_term_delta_entries WHERE tenant_id = ${db.tenantId} ORDER BY context_key, term, revision`) as ContextTermDeltaRow[];

	return {
		entities: entityRows.map((row): CanonicalEntityChain => {
			if (!isEntityKind(row.kind) || !isBodySource(row.body_source)) {
				throw new Error(`Cannot export invalid entity ${row.id}.`);
			}
			return {
				head: { id: row.id, kind: row.kind, title: row.title, body: row.body, bodySource: row.body_source, status: row.status, parentId: row.parent_id, tombstone: Boolean(row.tombstone), revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at },
				deltas: entityDeltas.filter((delta) => delta.entity_id === row.id).map((delta) => ({ id: delta.id, revision: delta.revision, author: delta.author, createdAt: delta.created_at, priorTitle: delta.prior_title, priorBody: delta.prior_body, priorBodySource: isBodySource(delta.prior_body_source) ? delta.prior_body_source : "authored", ...(delta.prior_status !== null && { priorStatus: delta.prior_status }), ...(delta.prior_parent_changed !== 0 && { priorParentId: delta.prior_parent_id }), ...(delta.prior_tombstone !== null && { priorTombstone: Boolean(delta.prior_tombstone) }), ...(delta.restored_from_revision !== null && { restoredFromRevision: delta.restored_from_revision }) }))
			};
		}),
		contexts: contextRows.map((row): CanonicalContextChain => ({ head: { key: row.key, scopeEntityId: row.scope_entity_id, title: row.title, summary: row.summary, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: contextDeltas.filter((delta) => delta.context_key === row.key).map((delta) => ({ id: delta.id, revision: delta.revision, author: delta.author, createdAt: delta.created_at, priorTitle: delta.prior_title, priorSummary: delta.prior_summary, ...(delta.restored_from_revision !== null && { restoredFromRevision: delta.restored_from_revision }) })) })),
		contextTerms: termRows.map((row): CanonicalContextTermChain => ({ head: { contextKey: row.context_key, term: row.term, definition: row.definition, avoid: parseStringArray(row.avoid_terms), tombstone: Boolean(row.tombstone), revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: termDeltas.filter((delta) => delta.context_key === row.context_key && delta.term === row.term).map((delta) => ({ id: delta.id, revision: delta.revision, author: delta.author, createdAt: delta.created_at, priorDefinition: delta.prior_definition, priorAvoid: parseStringArray(delta.prior_avoid_terms), priorTombstone: Boolean(delta.prior_tombstone), ...(delta.restored_from_revision !== null && { restoredFromRevision: delta.restored_from_revision }) })) }))
	};
}

export function importCanonicalChains(db: SqliteExecutor, incoming: CanonicalChainBundle): CanonicalChainImportResult {
	return db.transaction(() => {
		const current = exportCanonicalChains(db);
		const merged = mergeCanonicalChainBundles(current, incoming);
		const result: CanonicalChainImportResult = { entitiesCreated: [], entitiesAdvanced: [], contextsCreated: [], contextsAdvanced: [], contextTermsCreated: [], contextTermsAdvanced: [] };
		const currentEntities = new Map(current.entities.map((chain) => [chain.head.id, chain]));
		for (const chain of merged.entities) {
			const existing = currentEntities.get(chain.head.id);
			if (existing?.head.revision === chain.head.revision) continue;
			writeEntity(db, chain, existing === undefined);
			(existing ? result.entitiesAdvanced : result.entitiesCreated).push(chain.head.id);
		}
		rebuildStructuralParents(db, merged.entities);

		const currentContexts = new Map(current.contexts.map((chain) => [chain.head.key, chain]));
		for (const chain of merged.contexts) {
			const existing = currentContexts.get(chain.head.key);
			if (existing?.head.revision === chain.head.revision) continue;
			writeContext(db, chain, existing === undefined);
			(existing ? result.contextsAdvanced : result.contextsCreated).push(chain.head.key);
		}
		const currentTerms = new Map(current.contextTerms.map((chain) => [`${chain.head.contextKey}\u0000${chain.head.term}`, chain]));
		for (const chain of merged.contextTerms) {
			const key = `${chain.head.contextKey}\u0000${chain.head.term}`;
			const existing = currentTerms.get(key);
			if (existing?.head.revision === chain.head.revision) continue;
			writeContextTerm(db, chain, existing === undefined);
			(existing ? result.contextTermsAdvanced : result.contextTermsCreated).push(`${chain.head.contextKey}:${chain.head.term}`);
		}
		return result;
	});
}

function writeEntity(db: SqliteExecutor, chain: CanonicalEntityChain, created: boolean): void {
	const head = chain.head;
	if (created) db.drizzle.run(sql`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, revision, content_hash, tombstone, project_id, created_at, updated_at) VALUES (${db.tenantId}, ${head.id}, ${head.kind}, ${head.title}, ${head.status}, ${head.body}, ${head.bodySource}, ${head.revision}, ${head.contentHash}, ${head.tombstone ? 1 : 0}, ${head.kind === "project" ? head.id : db.currentProjectId}, ${head.createdAt}, ${head.updatedAt})`);
	else db.drizzle.run(sql`UPDATE entities SET title=${head.title}, status=${head.status}, body=${head.body}, body_source=${head.bodySource}, revision=${head.revision}, content_hash=${head.contentHash}, tombstone=${head.tombstone ? 1 : 0}, updated_at=${head.updatedAt} WHERE tenant_id=${db.tenantId} AND id=${head.id}`);
	for (const delta of chain.deltas) db.drizzle.run(sql`INSERT OR IGNORE INTO entity_delta_entries (id, tenant_id, entity_id, revision, author, prior_title, prior_body, prior_body_source, prior_status, prior_parent_id, prior_parent_changed, prior_tombstone, restored_from_revision, created_at) VALUES (${delta.id}, ${db.tenantId}, ${head.id}, ${delta.revision}, ${delta.author}, ${delta.priorTitle}, ${delta.priorBody}, ${delta.priorBodySource}, ${delta.priorStatus ?? null}, ${delta.priorParentId ?? null}, ${Object.hasOwn(delta, "priorParentId") ? 1 : 0}, ${delta.priorTombstone ?? null}, ${delta.restoredFromRevision ?? null}, ${delta.createdAt})`);
	if (created) bumpCounterPast(db, head.kind, head.id);
}

function bumpCounterPast(db: SqliteExecutor, kind: EntityKind, entityId: string): void {
	const numericSuffix = Number(entityId.slice(ID_PREFIX[kind].length));
	if (!Number.isInteger(numericSuffix) || numericSuffix < 0) return;
	db.drizzle.run(sql`UPDATE counters SET next_value = max(next_value, ${numericSuffix + 1}) WHERE tenant_id = ${db.tenantId} AND kind = ${kind}`);
}

function rebuildStructuralParents(db: SqliteExecutor, chains: CanonicalEntityChain[]): void {
	for (const chain of chains) {
		db.drizzle.run(sql`DELETE FROM relations WHERE tenant_id=${db.tenantId} AND to_id=${chain.head.id} AND type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')`);
		if (!chain.head.parentId || chain.head.tombstone) continue;
		const parent = chains.find((candidate) => candidate.head.id === chain.head.parentId)?.head;
		if (!parent) throw new Error(`Missing canonical parent ${chain.head.parentId} for ${chain.head.id}.`);
		const relationType = getAllowedRelationType(parent.kind, chain.head.kind);
		if (!relationType || !isStructuralRelationType(relationType)) throw new Error(`Invalid canonical parent ${parent.id} for ${chain.head.id}.`);
		db.drizzle.run(sql`INSERT OR IGNORE INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES (${db.tenantId}, ${parent.id}, ${chain.head.id}, ${relationType}, ${chain.head.updatedAt})`);
		const parentProject = db.drizzle.all(sql`SELECT project_id FROM entities WHERE tenant_id=${db.tenantId} AND id=${parent.id}`)[0] as { project_id: string | null } | undefined;
		db.drizzle.run(sql`UPDATE entities SET project_id=${parent.kind === "project" ? parent.id : parentProject?.project_id ?? db.currentProjectId} WHERE tenant_id=${db.tenantId} AND id=${chain.head.id}`);
	}
}

function writeContext(db: SqliteExecutor, chain: CanonicalContextChain, created: boolean): void {
	const head = chain.head;
	if (created) db.drizzle.run(sql`INSERT INTO contexts (tenant_id,key,scope_entity_id,title,summary,revision,content_hash,created_at,updated_at) VALUES (${db.tenantId},${head.key},${head.scopeEntityId},${head.title},${head.summary},${head.revision},${head.contentHash},${head.createdAt},${head.updatedAt})`);
	else db.drizzle.run(sql`UPDATE contexts SET scope_entity_id=${head.scopeEntityId},title=${head.title},summary=${head.summary},revision=${head.revision},content_hash=${head.contentHash},updated_at=${head.updatedAt} WHERE tenant_id=${db.tenantId} AND key=${head.key}`);
	for (const delta of chain.deltas) db.drizzle.run(sql`INSERT OR IGNORE INTO context_delta_entries (id,tenant_id,context_key,revision,author,prior_title,prior_summary,restored_from_revision,created_at) VALUES (${delta.id},${db.tenantId},${head.key},${delta.revision},${delta.author},${delta.priorTitle},${delta.priorSummary},${delta.restoredFromRevision ?? null},${delta.createdAt})`);
}

function writeContextTerm(db: SqliteExecutor, chain: CanonicalContextTermChain, created: boolean): void {
	const head = chain.head;
	if (created) db.drizzle.run(sql`INSERT INTO context_terms (tenant_id,context_key,term,definition,avoid_terms,revision,content_hash,tombstone,created_at,updated_at) VALUES (${db.tenantId},${head.contextKey},${head.term},${head.definition},${JSON.stringify(head.avoid)},${head.revision},${head.contentHash},${head.tombstone ? 1 : 0},${head.createdAt},${head.updatedAt})`);
	else db.drizzle.run(sql`UPDATE context_terms SET definition=${head.definition},avoid_terms=${JSON.stringify(head.avoid)},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone ? 1 : 0},updated_at=${head.updatedAt} WHERE tenant_id=${db.tenantId} AND context_key=${head.contextKey} AND term=${head.term}`);
	for (const delta of chain.deltas) db.drizzle.run(sql`INSERT OR IGNORE INTO context_term_delta_entries (id,tenant_id,context_key,term,revision,author,prior_definition,prior_avoid_terms,prior_tombstone,restored_from_revision,created_at) VALUES (${delta.id},${db.tenantId},${head.contextKey},${head.term},${delta.revision},${delta.author},${delta.priorDefinition},${JSON.stringify(delta.priorAvoid)},${delta.priorTombstone ? 1 : 0},${delta.restoredFromRevision ?? null},${delta.createdAt})`);
}

function parseStringArray(value: string): string[] {
	try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}