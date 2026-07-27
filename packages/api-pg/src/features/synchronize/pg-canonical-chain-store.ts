import { sql } from "drizzle-orm";

import {
	DEFAULT_PROJECT_ID,
	deriveMigratedEntityIdentity,
	encodeCanonicalReference,
	encodeContextRecordKey,
	encodeContextTermRecordKey,
	encodeEntityRecordKey,
	getAllowedRelationType,
	isBodySource,
	isEntityKind,
	isStructuralRelationType,
	mergeCanonicalChainBundles,
	type CanonicalChainBundle,
	type CanonicalChainImportResult,
	type CanonicalContextChain,
	type CanonicalContextTermChain,
	type CanonicalEntityChain
} from "@agent-issues/core";

import type { TenantExecutor } from "../../db/connection.js";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";

type EntityHeadRow = { id: string; reference: string; kind: string; title: string; body: string; body_source: string; status: string; revision: number; content_hash: string; tombstone: boolean; project_id: string | null; created_at: string; updated_at: string; parent_id: string | null };
type ContextHeadRow = { id: string; reference: string; key: string; scope_entity_id: string | null; title: string; summary: string; revision: number; content_hash: string; created_at: string; updated_at: string };
type ContextTermHeadRow = { id: string; context_key: string; term: string; definition: string; avoid_terms: string; tombstone: boolean; revision: number; content_hash: string; created_at: string; updated_at: string };
type LedgerRow = { id: string; project_id: string; record_kind: string; record_key: string; revision: number; author: string; patch_format: number; reverse_patch: Buffer; source_hash: Buffer; target_hash: Buffer; restored_from_revision: number | null; created_at: string };

function mapDelta(delta: LedgerRow) {
	return {
		id: delta.id,
		revision: delta.revision,
		author: delta.author,
		createdAt: delta.created_at,
		patchFormat: delta.patch_format,
		reversePatch: delta.reverse_patch,
		sourceHash: decodeRevisionPatchHash(delta.source_hash),
		targetHash: decodeRevisionPatchHash(delta.target_hash),
		...(delta.restored_from_revision !== null && { restoredFromRevision: delta.restored_from_revision })
	};
}

export async function exportCanonicalChains(client: TenantExecutor): Promise<CanonicalChainBundle> {
	const entitiesResult = await client.execute(sql`SELECT entities.*, (SELECT relations.from_id FROM relations WHERE relations.tenant_id=entities.tenant_id AND relations.to_id=entities.id AND relations.type IN ('contains','owns','records','tracks','creates','decomposes') ORDER BY relations.created_at, relations.from_id LIMIT 1) AS parent_id FROM entities WHERE tenant_id=${client.tenantId}`);
	const contextsResult = await client.execute(sql`SELECT * FROM contexts WHERE tenant_id=${client.tenantId}`);
	const termsResult = await client.execute(sql`SELECT * FROM context_terms WHERE tenant_id=${client.tenantId}`);
	const ledgerResult = await client.execute(sql`SELECT * FROM revision_entries WHERE tenant_id=${client.tenantId} ORDER BY project_id,record_kind,record_key,revision`);
	const ledgerRows = ledgerResult.rows as LedgerRow[];
	return {
		entities: (entitiesResult.rows as EntityHeadRow[]).map((row): CanonicalEntityChain => {
			if (!isEntityKind(row.kind) || !isBodySource(row.body_source)) throw new Error(`Cannot export invalid entity ${row.id}.`);
			return { head: { id: row.id, reference: row.reference, kind: row.kind, title: row.title, body: row.body, bodySource: row.body_source, status: row.status, parentId: row.parent_id, tombstone: row.tombstone, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.project_id === row.project_id && delta.record_kind === "entity" && delta.record_key === encodeEntityRecordKey(row.id)).map(mapDelta) };
		}),
		contexts: (contextsResult.rows as ContextHeadRow[]).map((row): CanonicalContextChain => ({ head: { id: row.id, reference: row.reference, key: row.key, scopeEntityId: row.scope_entity_id, title: row.title, summary: row.summary, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "context" && delta.record_key === encodeContextRecordKey(row.id)).map(mapDelta) })),
		contextTerms: (termsResult.rows as ContextTermHeadRow[]).map((row): CanonicalContextTermChain => ({ head: { id: row.id, reference: encodeCanonicalReference("contextTerm", row.id), contextKey: row.context_key, term: row.term, definition: row.definition, avoid: parseStringArray(row.avoid_terms), tombstone: row.tombstone, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "context-term" && delta.record_key === encodeContextTermRecordKey(row.id)).map(mapDelta) }))
	};
}

export async function importCanonicalChains(client: TenantExecutor, incoming: CanonicalChainBundle): Promise<CanonicalChainImportResult> {
	const current = await exportCanonicalChains(client);
	const merged = mergeCanonicalChainBundles(current, incoming);
	const result: CanonicalChainImportResult = { entitiesCreated: [], entitiesAdvanced: [], contextsCreated: [], contextsAdvanced: [], contextTermsCreated: [], contextTermsAdvanced: [] };
	const currentEntities = new Map(current.entities.map((chain) => [chain.head.id, chain]));
	for (const chain of merged.entities) {
		const existing = currentEntities.get(chain.head.id);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeEntity(client, chain, existing === undefined, resolveCanonicalProjectId(chain, merged.entities));
		(existing ? result.entitiesAdvanced : result.entitiesCreated).push(chain.head.id);
	}
	await rebuildStructuralParents(client, merged.entities);
	const currentContexts = new Map(current.contexts.map((chain) => [chain.head.id, chain]));
	for (const chain of merged.contexts) {
		const existing = currentContexts.get(chain.head.id);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeContext(client, chain, existing === undefined);
		(existing ? result.contextsAdvanced : result.contextsCreated).push(chain.head.key);
	}
	const currentTerms = new Map(current.contextTerms.map((chain) => [chain.head.id, chain]));
	for (const chain of merged.contextTerms) {
		const existing = currentTerms.get(chain.head.id);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeTerm(client, chain, existing === undefined);
		(existing ? result.contextTermsAdvanced : result.contextTermsCreated).push(`${chain.head.contextKey}:${chain.head.term}`);
	}
	return result;
}

async function writeEntity(client: TenantExecutor, chain: CanonicalEntityChain, created: boolean, projectId: string): Promise<void> {
	const head = chain.head;
	if (created) await client.execute(sql`INSERT INTO entities (tenant_id,id,reference,kind,title,status,body,body_source,revision,content_hash,tombstone,project_id,created_at,updated_at) VALUES (${client.tenantId},${head.id}::uuid,${head.reference},${head.kind},${head.title},${head.status},${head.body},${head.bodySource},${head.revision},${head.contentHash},${head.tombstone},${projectId},${head.createdAt},${head.updatedAt})`);
	else await client.execute(sql`UPDATE entities SET title=${head.title},status=${head.status},body=${head.body},body_source=${head.bodySource},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone},project_id=${projectId},updated_at=${head.updatedAt} WHERE tenant_id=${client.tenantId} AND id=${head.id}`);
	for (const delta of chain.deltas) await client.execute(sql`INSERT INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${client.tenantId},${projectId},'entity',${encodeEntityRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,project_id,record_kind,record_key,revision) DO NOTHING`);
}

function resolveCanonicalProjectId(chain: CanonicalEntityChain, chains: CanonicalEntityChain[]): string {
	let current = chain;
	const visited = new Set<string>();
	while (current.head.kind !== "project") {
		if (!current.head.parentId) {
			const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
			const defaultProject = chains.find((candidate) => candidate.head.id === defaultProjectId);
			if (!defaultProject) throw new Error(`Missing canonical default project ${DEFAULT_PROJECT_ID}.`);
			return defaultProject.head.id;
		}
		if (visited.has(current.head.id)) {
			throw new Error(`Cannot resolve canonical project for entity ${chain.head.id}.`);
		}
		visited.add(current.head.id);
		const parent = chains.find((candidate) => candidate.head.id === current.head.parentId);
		if (!parent) throw new Error(`Missing canonical parent ${current.head.parentId} for ${current.head.id}.`);
		current = parent;
	}
	return current.head.id;
}

async function rebuildStructuralParents(client: TenantExecutor, chains: CanonicalEntityChain[]): Promise<void> {
	for (const chain of chains) {
		await client.execute(sql`DELETE FROM relations WHERE tenant_id=${client.tenantId} AND to_id=${chain.head.id} AND type IN ('contains','owns','records','tracks','creates','decomposes')`);
		if (!chain.head.parentId || chain.head.tombstone) continue;
		const parent = chains.find((candidate) => candidate.head.id === chain.head.parentId)?.head;
		if (!parent) throw new Error(`Missing canonical parent ${chain.head.parentId} for ${chain.head.id}.`);
		const relationType = getAllowedRelationType(parent.kind, chain.head.kind);
		if (!relationType || !isStructuralRelationType(relationType)) throw new Error(`Invalid canonical parent ${parent.id} for ${chain.head.id}.`);
		await client.execute(sql`INSERT INTO relations (tenant_id,from_id,to_id,type,created_at) VALUES (${client.tenantId},${parent.id},${chain.head.id},${relationType},${chain.head.updatedAt}) ON CONFLICT DO NOTHING`);
		await client.execute(sql`UPDATE entities SET project_id=CASE WHEN ${parent.kind}='project' THEN ${parent.id} ELSE (SELECT project_id FROM entities WHERE tenant_id=${client.tenantId} AND id=${parent.id}) END WHERE tenant_id=${client.tenantId} AND id=${chain.head.id}`);
	}
}

async function writeContext(client: TenantExecutor, chain: CanonicalContextChain, created: boolean): Promise<void> {
	const head = chain.head;
	if (created) await client.execute(sql`INSERT INTO contexts (tenant_id,id,reference,key,scope_entity_id,title,summary,revision,content_hash,created_at,updated_at) VALUES (${client.tenantId},${head.id}::uuid,${head.reference},${head.key},${head.scopeEntityId},${head.title},${head.summary},${head.revision},${head.contentHash},${head.createdAt},${head.updatedAt})`);
	else await client.execute(sql`UPDATE contexts SET scope_entity_id=${head.scopeEntityId},title=${head.title},summary=${head.summary},revision=${head.revision},content_hash=${head.contentHash},updated_at=${head.updatedAt} WHERE tenant_id=${client.tenantId} AND key=${head.key}`);
	const projectId = await getContextProjectId(client, head.key, head.scopeEntityId);
	for (const delta of chain.deltas) await client.execute(sql`INSERT INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${client.tenantId},${projectId},'context',${encodeContextRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,project_id,record_kind,record_key,revision) DO NOTHING`);
}

async function writeTerm(client: TenantExecutor, chain: CanonicalContextTermChain, created: boolean): Promise<void> {
	const head = chain.head;
	if (created) await client.execute(sql`INSERT INTO context_terms (tenant_id,id,context_key,term,definition,avoid_terms,revision,content_hash,tombstone,created_at,updated_at) VALUES (${client.tenantId},${head.id}::uuid,${head.contextKey},${head.term},${head.definition},${JSON.stringify(head.avoid)},${head.revision},${head.contentHash},${head.tombstone},${head.createdAt},${head.updatedAt})`);
	else await client.execute(sql`UPDATE context_terms SET context_key=${head.contextKey},term=${head.term},definition=${head.definition},avoid_terms=${JSON.stringify(head.avoid)},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone},updated_at=${head.updatedAt} WHERE tenant_id=${client.tenantId} AND id=${head.id}::uuid`);
	const projectId = await getContextProjectId(client, head.contextKey);
	for (const delta of chain.deltas) await client.execute(sql`INSERT INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${client.tenantId},${projectId},'context-term',${encodeContextTermRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,project_id,record_kind,record_key,revision) DO NOTHING`);
}

async function getEntityProjectId(client: TenantExecutor, entityId: string): Promise<string> {
	const result = await client.execute(sql`SELECT project_id FROM entities WHERE tenant_id=${client.tenantId} AND id=${entityId}`);
	const projectId = (result.rows[0] as { project_id: string | null } | undefined)?.project_id;
	if (!projectId) throw new Error(`Cannot resolve project for entity ${entityId}.`);
	return projectId;
}

async function getContextProjectId(client: TenantExecutor, contextKey: string, scopeEntityId?: string | null): Promise<string> {
	if (scopeEntityId) return getEntityProjectId(client, scopeEntityId);
	if (contextKey === "default") return deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
	if (contextKey.startsWith("default:")) {
		const projectId = contextKey.slice("default:".length);
		return projectId === DEFAULT_PROJECT_ID ? deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId : projectId;
	}
	const result = await client.execute(sql`SELECT scope_entity_id FROM contexts WHERE tenant_id=${client.tenantId} AND key=${contextKey}`);
	const storedScope = (result.rows[0] as { scope_entity_id: string | null } | undefined)?.scope_entity_id;
	if (storedScope) return getEntityProjectId(client, storedScope);
	throw new Error(`Cannot resolve project for context ${contextKey}.`);
}

function parseStringArray(value: string): string[] {
	try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}