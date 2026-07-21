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

import type { TenantExecutor } from "../../db/connection.js";

type EntityHeadRow = { id: string; kind: string; title: string; body: string; body_source: string; status: string; revision: number; content_hash: string; tombstone: boolean; created_at: string; updated_at: string; parent_id: string | null };
type EntityDeltaRow = { id: string; entity_id: string; revision: number; author: string; prior_title: string; prior_body: string; prior_body_source: string; prior_status: string | null; prior_parent_id: string | null; prior_parent_changed: boolean; prior_tombstone: boolean | null; restored_from_revision: number | null; created_at: string };
type ContextHeadRow = { key: string; scope_entity_id: string | null; title: string; summary: string; revision: number; content_hash: string; created_at: string; updated_at: string };
type ContextDeltaRow = { id: string; context_key: string; revision: number; author: string; prior_title: string; prior_summary: string; restored_from_revision: number | null; created_at: string };
type ContextTermHeadRow = { context_key: string; term: string; definition: string; avoid_terms: string; tombstone: boolean; revision: number; content_hash: string; created_at: string; updated_at: string };
type ContextTermDeltaRow = { id: string; context_key: string; term: string; revision: number; author: string; prior_definition: string; prior_avoid_terms: string; prior_tombstone: boolean; restored_from_revision: number | null; created_at: string };

export async function exportCanonicalChains(client: TenantExecutor, tenantId: string): Promise<CanonicalChainBundle> {
	const entitiesResult = await client.execute(sql`SELECT entities.*, (SELECT relations.from_id FROM relations WHERE relations.tenant_id=entities.tenant_id AND relations.to_id=entities.id AND relations.type IN ('contains','owns','records','tracks','creates','decomposes') ORDER BY relations.from_id LIMIT 1) AS parent_id FROM entities WHERE tenant_id=${tenantId}`);
	const entityDeltasResult = await client.execute(sql`SELECT * FROM entity_delta_entries WHERE tenant_id=${tenantId} ORDER BY entity_id,revision`);
	const contextsResult = await client.execute(sql`SELECT * FROM contexts WHERE tenant_id=${tenantId}`);
	const contextDeltasResult = await client.execute(sql`SELECT * FROM context_delta_entries WHERE tenant_id=${tenantId} ORDER BY context_key,revision`);
	const termsResult = await client.execute(sql`SELECT * FROM context_terms WHERE tenant_id=${tenantId}`);
	const termDeltasResult = await client.execute(sql`SELECT * FROM context_term_delta_entries WHERE tenant_id=${tenantId} ORDER BY context_key,term,revision`);
	const entityDeltas = entityDeltasResult.rows as EntityDeltaRow[];
	const contextDeltas = contextDeltasResult.rows as ContextDeltaRow[];
	const termDeltas = termDeltasResult.rows as ContextTermDeltaRow[];
	return {
		entities: (entitiesResult.rows as EntityHeadRow[]).map((row): CanonicalEntityChain => {
			if (!isEntityKind(row.kind) || !isBodySource(row.body_source)) throw new Error(`Cannot export invalid entity ${row.id}.`);
			return { head: { id: row.id, kind: row.kind, title: row.title, body: row.body, bodySource: row.body_source, status: row.status, parentId: row.parent_id, tombstone: row.tombstone, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: entityDeltas.filter((delta) => delta.entity_id === row.id).map((delta) => ({ id: delta.id, revision: delta.revision, author: delta.author, createdAt: delta.created_at, priorTitle: delta.prior_title, priorBody: delta.prior_body, priorBodySource: isBodySource(delta.prior_body_source) ? delta.prior_body_source : "authored", ...(delta.prior_status !== null && { priorStatus: delta.prior_status }), ...(delta.prior_parent_changed && { priorParentId: delta.prior_parent_id }), ...(delta.prior_tombstone !== null && { priorTombstone: delta.prior_tombstone }), ...(delta.restored_from_revision !== null && { restoredFromRevision: delta.restored_from_revision }) })) };
		}),
		contexts: (contextsResult.rows as ContextHeadRow[]).map((row): CanonicalContextChain => ({ head: { key: row.key, scopeEntityId: row.scope_entity_id, title: row.title, summary: row.summary, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: contextDeltas.filter((delta) => delta.context_key === row.key).map((delta) => ({ id: delta.id, revision: delta.revision, author: delta.author, createdAt: delta.created_at, priorTitle: delta.prior_title, priorSummary: delta.prior_summary, ...(delta.restored_from_revision !== null && { restoredFromRevision: delta.restored_from_revision }) })) })),
		contextTerms: (termsResult.rows as ContextTermHeadRow[]).map((row): CanonicalContextTermChain => ({ head: { contextKey: row.context_key, term: row.term, definition: row.definition, avoid: parseStringArray(row.avoid_terms), tombstone: row.tombstone, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: termDeltas.filter((delta) => delta.context_key === row.context_key && delta.term === row.term).map((delta) => ({ id: delta.id, revision: delta.revision, author: delta.author, createdAt: delta.created_at, priorDefinition: delta.prior_definition, priorAvoid: parseStringArray(delta.prior_avoid_terms), priorTombstone: delta.prior_tombstone, ...(delta.restored_from_revision !== null && { restoredFromRevision: delta.restored_from_revision }) })) }))
	};
}

export async function importCanonicalChains(client: TenantExecutor, tenantId: string, incoming: CanonicalChainBundle): Promise<CanonicalChainImportResult> {
	const current = await exportCanonicalChains(client, tenantId);
	const merged = mergeCanonicalChainBundles(current, incoming);
	const result: CanonicalChainImportResult = { entitiesCreated: [], entitiesAdvanced: [], contextsCreated: [], contextsAdvanced: [], contextTermsCreated: [], contextTermsAdvanced: [] };
	const currentEntities = new Map(current.entities.map((chain) => [chain.head.id, chain]));
	for (const chain of merged.entities) {
		const existing = currentEntities.get(chain.head.id);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeEntity(client, tenantId, chain, existing === undefined);
		(existing ? result.entitiesAdvanced : result.entitiesCreated).push(chain.head.id);
	}
	await rebuildStructuralParents(client, tenantId, merged.entities);
	const currentContexts = new Map(current.contexts.map((chain) => [chain.head.key, chain]));
	for (const chain of merged.contexts) {
		const existing = currentContexts.get(chain.head.key);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeContext(client, tenantId, chain, existing === undefined);
		(existing ? result.contextsAdvanced : result.contextsCreated).push(chain.head.key);
	}
	const currentTerms = new Map(current.contextTerms.map((chain) => [`${chain.head.contextKey}\u0000${chain.head.term}`, chain]));
	for (const chain of merged.contextTerms) {
		const existing = currentTerms.get(`${chain.head.contextKey}\u0000${chain.head.term}`);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeTerm(client, tenantId, chain, existing === undefined);
		(existing ? result.contextTermsAdvanced : result.contextTermsCreated).push(`${chain.head.contextKey}:${chain.head.term}`);
	}
	return result;
}

async function writeEntity(client: TenantExecutor, tenantId: string, chain: CanonicalEntityChain, created: boolean): Promise<void> {
	const head = chain.head;
	if (created) await client.execute(sql`INSERT INTO entities (tenant_id,id,kind,title,status,body,body_source,revision,content_hash,tombstone,project_id,created_at,updated_at) VALUES (${tenantId},${head.id},${head.kind},${head.title},${head.status},${head.body},${head.bodySource},${head.revision},${head.contentHash},${head.tombstone},${head.kind === "project" ? head.id : null},${head.createdAt},${head.updatedAt})`);
	else await client.execute(sql`UPDATE entities SET title=${head.title},status=${head.status},body=${head.body},body_source=${head.bodySource},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone},updated_at=${head.updatedAt} WHERE tenant_id=${tenantId} AND id=${head.id}`);
	for (const delta of chain.deltas) await client.execute(sql`INSERT INTO entity_delta_entries (id,tenant_id,entity_id,revision,author,prior_title,prior_body,prior_body_source,prior_status,prior_parent_id,prior_parent_changed,prior_tombstone,restored_from_revision,created_at) VALUES (${delta.id},${tenantId},${head.id},${delta.revision},${delta.author},${delta.priorTitle},${delta.priorBody},${delta.priorBodySource},${delta.priorStatus ?? null},${delta.priorParentId ?? null},${Object.hasOwn(delta,"priorParentId")},${delta.priorTombstone ?? null},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,entity_id,revision) DO NOTHING`);
	await bumpCounter(client, tenantId, head.kind, head.id);
}

async function rebuildStructuralParents(client: TenantExecutor, tenantId: string, chains: CanonicalEntityChain[]): Promise<void> {
	for (const chain of chains) {
		await client.execute(sql`DELETE FROM relations WHERE tenant_id=${tenantId} AND to_id=${chain.head.id} AND type IN ('contains','owns','records','tracks','creates','decomposes')`);
		if (!chain.head.parentId || chain.head.tombstone) continue;
		const parent = chains.find((candidate) => candidate.head.id === chain.head.parentId)?.head;
		if (!parent) throw new Error(`Missing canonical parent ${chain.head.parentId} for ${chain.head.id}.`);
		const relationType = getAllowedRelationType(parent.kind, chain.head.kind);
		if (!relationType || !isStructuralRelationType(relationType)) throw new Error(`Invalid canonical parent ${parent.id} for ${chain.head.id}.`);
		await client.execute(sql`INSERT INTO relations (tenant_id,from_id,to_id,type,created_at) VALUES (${tenantId},${parent.id},${chain.head.id},${relationType},${chain.head.updatedAt}) ON CONFLICT DO NOTHING`);
		await client.execute(sql`UPDATE entities SET project_id=CASE WHEN ${parent.kind}='project' THEN ${parent.id} ELSE (SELECT project_id FROM entities WHERE tenant_id=${tenantId} AND id=${parent.id}) END WHERE tenant_id=${tenantId} AND id=${chain.head.id}`);
	}
}

async function writeContext(client: TenantExecutor, tenantId: string, chain: CanonicalContextChain, created: boolean): Promise<void> {
	const head = chain.head;
	if (created) await client.execute(sql`INSERT INTO contexts (tenant_id,key,scope_entity_id,title,summary,revision,content_hash,created_at,updated_at) VALUES (${tenantId},${head.key},${head.scopeEntityId},${head.title},${head.summary},${head.revision},${head.contentHash},${head.createdAt},${head.updatedAt})`);
	else await client.execute(sql`UPDATE contexts SET scope_entity_id=${head.scopeEntityId},title=${head.title},summary=${head.summary},revision=${head.revision},content_hash=${head.contentHash},updated_at=${head.updatedAt} WHERE tenant_id=${tenantId} AND key=${head.key}`);
	for (const delta of chain.deltas) await client.execute(sql`INSERT INTO context_delta_entries (id,tenant_id,context_key,revision,author,prior_title,prior_summary,restored_from_revision,created_at) VALUES (${delta.id},${tenantId},${head.key},${delta.revision},${delta.author},${delta.priorTitle},${delta.priorSummary},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,context_key,revision) DO NOTHING`);
}

async function writeTerm(client: TenantExecutor, tenantId: string, chain: CanonicalContextTermChain, created: boolean): Promise<void> {
	const head = chain.head;
	if (created) await client.execute(sql`INSERT INTO context_terms (tenant_id,context_key,term,definition,avoid_terms,revision,content_hash,tombstone,created_at,updated_at) VALUES (${tenantId},${head.contextKey},${head.term},${head.definition},${JSON.stringify(head.avoid)},${head.revision},${head.contentHash},${head.tombstone},${head.createdAt},${head.updatedAt})`);
	else await client.execute(sql`UPDATE context_terms SET definition=${head.definition},avoid_terms=${JSON.stringify(head.avoid)},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone},updated_at=${head.updatedAt} WHERE tenant_id=${tenantId} AND context_key=${head.contextKey} AND term=${head.term}`);
	for (const delta of chain.deltas) await client.execute(sql`INSERT INTO context_term_delta_entries (id,tenant_id,context_key,term,revision,author,prior_definition,prior_avoid_terms,prior_tombstone,restored_from_revision,created_at) VALUES (${delta.id},${tenantId},${head.contextKey},${head.term},${delta.revision},${delta.author},${delta.priorDefinition},${JSON.stringify(delta.priorAvoid)},${delta.priorTombstone},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,context_key,term,revision) DO NOTHING`);
}

async function bumpCounter(client: TenantExecutor, tenantId: string, kind: EntityKind, entityId: string): Promise<void> {
	const suffix = Number(entityId.slice(ID_PREFIX[kind].length));
	if (Number.isInteger(suffix) && suffix >= 0) await client.execute(sql`INSERT INTO counters (tenant_id,kind,next_value) VALUES (${tenantId},${kind},${suffix + 1}) ON CONFLICT (tenant_id,kind) DO UPDATE SET next_value=GREATEST(counters.next_value,excluded.next_value)`);
}

function parseStringArray(value: string): string[] {
	try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}