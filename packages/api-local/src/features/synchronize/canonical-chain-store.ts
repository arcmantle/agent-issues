import { sql } from "drizzle-orm";

import {
	encodeContextRecordKey,
	encodeContextTermRecordKey,
	encodeEntityRecordKey,
	encodeCanonicalReference,
	DEFAULT_PROJECT_ID,
	deriveMigratedEntityIdentity,
	getAllowedRelationType,
	isBodySource,
	isEntityKind,
	isStructuralRelationType,
	mergeCanonicalChainBundles,
	type CanonicalChainBundle,
	type CanonicalChainImportResult,
	type CanonicalContextChain,
	type CanonicalContextTermChain,
	type CanonicalEntityChain,
	type SynchronizeStore
} from "@agent-issues/core";

import type { SqliteExecutor } from "../../db/sqlite-executor.js";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";

type EntityHeadRow = { id: string; reference: string; kind: string; title: string; body: string; body_source: string; status: string; revision: number; content_hash: string; tombstone: number; project_id: string | null; created_at: string; updated_at: string; parent_id: string | null };
type ContextHeadRow = { id: string; reference: string; key: string; scope_entity_id: string | null; title: string; summary: string; revision: number; content_hash: string; created_at: string; updated_at: string };
type ContextTermHeadRow = { id: string; context_key: string; term: string; definition: string; avoid_terms: string; tombstone: number; revision: number; content_hash: string; created_at: string; updated_at: string };
type LedgerRow = { id: string; project_id: string; record_kind: string; record_key: string; revision: number; author: string; patch_format: number; reverse_patch: Uint8Array; source_hash: Uint8Array; target_hash: Uint8Array; restored_from_revision: number | null; created_at: string };
type SqliteQuerySurface = Pick<SqliteExecutor["drizzle"], "all" | "run">;

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

export function exportCanonicalChains(executor: SqliteExecutor): CanonicalChainBundle {
	const entityRows = executor.drizzle.all(sql`SELECT entities.*,
		(SELECT relations.from_id FROM relations WHERE relations.tenant_id = entities.tenant_id AND relations.to_id = entities.id AND relations.type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')
			ORDER BY relations.created_at, relations.from_id LIMIT 1) AS parent_id
		FROM entities WHERE tenant_id = ${executor.tenantId}`) as EntityHeadRow[];
	const contextRows = executor.drizzle.all(sql`SELECT * FROM contexts WHERE tenant_id = ${executor.tenantId}`) as ContextHeadRow[];
	const termRows = executor.drizzle.all(sql`SELECT * FROM context_terms WHERE tenant_id = ${executor.tenantId}`) as ContextTermHeadRow[];
	const ledgerRows = executor.drizzle.all(sql`SELECT * FROM revision_entries
		WHERE tenant_id = ${executor.tenantId}
		ORDER BY project_id, record_kind, record_key, revision`) as LedgerRow[];

	return {
		entities: entityRows.map((row): CanonicalEntityChain => {
			if (!isEntityKind(row.kind) || !isBodySource(row.body_source)) {
				throw new Error(`Cannot export invalid entity ${row.id}.`);
			}
			return {
				head: { id: row.id, reference: row.reference, kind: row.kind, title: row.title, body: row.body, bodySource: row.body_source, status: row.status, parentId: row.parent_id, tombstone: Boolean(row.tombstone), revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at },
				deltas: ledgerRows.filter((delta) => delta.project_id === row.project_id && delta.record_kind === "entity" && delta.record_key === encodeEntityRecordKey(row.id)).map(mapDelta)
			};
		}),
		contexts: contextRows.map((row): CanonicalContextChain => ({ head: { id: row.id, reference: row.reference, key: row.key, scopeEntityId: row.scope_entity_id, title: row.title, summary: row.summary, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "context" && delta.record_key === encodeContextRecordKey(row.id)).map(mapDelta) })),
		contextTerms: termRows.map((row): CanonicalContextTermChain => ({ head: { id: row.id, reference: encodeCanonicalReference("contextTerm", row.id), contextKey: row.context_key, term: row.term, definition: row.definition, avoid: parseStringArray(row.avoid_terms), tombstone: Boolean(row.tombstone), revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "context-term" && delta.record_key === encodeContextTermRecordKey(row.id)).map(mapDelta) }))
	};
}

export function importCanonicalChains(executor: SqliteExecutor, incoming: CanonicalChainBundle): CanonicalChainImportResult {
	return executor.drizzle.transaction((tx) => {
		const current = exportCanonicalChains(executor);
		const merged = mergeCanonicalChainBundles(current, incoming);
		const result: CanonicalChainImportResult = { entitiesCreated: [], entitiesAdvanced: [], contextsCreated: [], contextsAdvanced: [], contextTermsCreated: [], contextTermsAdvanced: [] };
		const currentEntities = new Map(current.entities.map((chain) => [chain.head.id, chain]));
		for (const chain of merged.entities) {
			const existing = currentEntities.get(chain.head.id);
			if (existing?.head.revision === chain.head.revision) continue;
			writeEntity(tx, executor, chain, existing === undefined);
			(existing ? result.entitiesAdvanced : result.entitiesCreated).push(chain.head.id);
		}
		rebuildStructuralParents(tx, executor, merged.entities);

		const currentContexts = new Map(current.contexts.map((chain) => [chain.head.id, chain]));
		for (const chain of merged.contexts) {
			const existing = currentContexts.get(chain.head.id);
			if (existing?.head.revision === chain.head.revision) continue;
			writeContext(tx, executor, chain, existing === undefined);
			(existing ? result.contextsAdvanced : result.contextsCreated).push(chain.head.key);
		}
		const currentTerms = new Map(current.contextTerms.map((chain) => [chain.head.id, chain]));
		for (const chain of merged.contextTerms) {
			const existing = currentTerms.get(chain.head.id);
			if (existing?.head.revision === chain.head.revision) continue;
			writeContextTerm(tx, executor, chain, existing === undefined);
			(existing ? result.contextTermsAdvanced : result.contextTermsCreated).push(`${chain.head.contextKey}:${chain.head.term}`);
		}
		return result;
	});
}

function writeEntity(query: SqliteQuerySurface, executor: SqliteExecutor, chain: CanonicalEntityChain, created: boolean): void {
	const head = chain.head;
	if (created) query.run(sql`INSERT INTO entities (tenant_id, id, reference, kind, title, status, body, body_source, revision, content_hash, tombstone, project_id, created_at, updated_at) VALUES (${executor.tenantId}, ${head.id}, ${head.reference}, ${head.kind}, ${head.title}, ${head.status}, ${head.body}, ${head.bodySource}, ${head.revision}, ${head.contentHash}, ${head.tombstone ? 1 : 0}, ${head.kind === "project" ? head.id : executor.currentProjectId}, ${head.createdAt}, ${head.updatedAt})`);
	else query.run(sql`UPDATE entities SET title=${head.title}, status=${head.status}, body=${head.body}, body_source=${head.bodySource}, revision=${head.revision}, content_hash=${head.contentHash}, tombstone=${head.tombstone ? 1 : 0}, updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}`);
	const projectId = getEntityProjectId(query, executor, head.id);
	for (const delta of chain.deltas) query.run(sql`INSERT OR IGNORE INTO revision_entries (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at) VALUES (${delta.id}, ${executor.tenantId}, ${projectId}, 'entity', ${encodeEntityRecordKey(head.id)}, ${delta.revision}, ${delta.author}, ${delta.patchFormat}, ${Buffer.from(delta.reversePatch)}, ${encodeRevisionPatchHash(delta.sourceHash)}, ${encodeRevisionPatchHash(delta.targetHash)}, ${delta.restoredFromRevision ?? null}, ${delta.createdAt})`);
}

function rebuildStructuralParents(query: SqliteQuerySurface, executor: SqliteExecutor, chains: CanonicalEntityChain[]): void {
	for (const chain of chains) {
		query.run(sql`DELETE FROM relations WHERE tenant_id=${executor.tenantId} AND to_id=${chain.head.id} AND type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')`);
		if (!chain.head.parentId || chain.head.tombstone) continue;
		const parent = chains.find((candidate) => candidate.head.id === chain.head.parentId)?.head;
		if (!parent) throw new Error(`Missing canonical parent ${chain.head.parentId} for ${chain.head.id}.`);
		const relationType = getAllowedRelationType(parent.kind, chain.head.kind);
		if (!relationType || !isStructuralRelationType(relationType)) throw new Error(`Invalid canonical parent ${parent.id} for ${chain.head.id}.`);
		query.run(sql`INSERT OR IGNORE INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES (${executor.tenantId}, ${parent.id}, ${chain.head.id}, ${relationType}, ${chain.head.updatedAt})`);
		const parentProject = query.all(sql`SELECT project_id FROM entities WHERE tenant_id=${executor.tenantId} AND id=${parent.id}`)[0] as { project_id: string | null } | undefined;
		query.run(sql`UPDATE entities SET project_id=${parent.kind === "project" ? parent.id : parentProject?.project_id ?? executor.currentProjectId} WHERE tenant_id=${executor.tenantId} AND id=${chain.head.id}`);
	}
}

function writeContext(query: SqliteQuerySurface, executor: SqliteExecutor, chain: CanonicalContextChain, created: boolean): void {
	const head = chain.head;
	if (created) query.run(sql`INSERT INTO contexts (tenant_id,id,reference,key,scope_entity_id,title,summary,revision,content_hash,created_at,updated_at) VALUES (${executor.tenantId},${head.id},${head.reference},${head.key},${head.scopeEntityId},${head.title},${head.summary},${head.revision},${head.contentHash},${head.createdAt},${head.updatedAt})`);
	else query.run(sql`UPDATE contexts SET scope_entity_id=${head.scopeEntityId},title=${head.title},summary=${head.summary},revision=${head.revision},content_hash=${head.contentHash},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND key=${head.key}`);
	const projectId = getContextProjectId(query, executor, head.key, head.scopeEntityId);
	for (const delta of chain.deltas) query.run(sql`INSERT OR IGNORE INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'context',${encodeContextRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt})`);
}

function writeContextTerm(query: SqliteQuerySurface, executor: SqliteExecutor, chain: CanonicalContextTermChain, created: boolean): void {
	const head = chain.head;
	if (created) query.run(sql`INSERT INTO context_terms (tenant_id,id,context_key,term,definition,avoid_terms,revision,content_hash,tombstone,created_at,updated_at) VALUES (${executor.tenantId},${head.id},${head.contextKey},${head.term},${head.definition},${JSON.stringify(head.avoid)},${head.revision},${head.contentHash},${head.tombstone ? 1 : 0},${head.createdAt},${head.updatedAt})`);
	else query.run(sql`UPDATE context_terms SET context_key=${head.contextKey},term=${head.term},definition=${head.definition},avoid_terms=${JSON.stringify(head.avoid)},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone ? 1 : 0},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}`);
	const projectId = getContextProjectId(query, executor, head.contextKey);
	for (const delta of chain.deltas) query.run(sql`INSERT OR IGNORE INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'context-term',${encodeContextTermRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt})`);
}

function getEntityProjectId(query: SqliteQuerySurface, executor: SqliteExecutor, entityId: string): string {
	const row = query.all(sql`SELECT project_id FROM entities WHERE tenant_id = ${executor.tenantId} AND id = ${entityId}`)[0] as { project_id: string | null } | undefined;
	if (!row?.project_id) throw new Error(`Cannot resolve project for entity ${entityId}.`);
	return row.project_id;
}

function getContextProjectId(query: SqliteQuerySurface, executor: SqliteExecutor, contextKey: string, scopeEntityId?: string | null): string {
	if (scopeEntityId) return getEntityProjectId(query, executor, scopeEntityId);
	if (contextKey === "default") return executor.currentProjectId;
	if (contextKey.startsWith("default:")) {
		const projectReference = contextKey.slice("default:".length);
		if (projectReference === DEFAULT_PROJECT_ID) {
			return deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
		}
		return projectReference;
	}
	const row = query.all(sql`SELECT scope_entity_id FROM contexts WHERE tenant_id = ${executor.tenantId} AND key = ${contextKey}`)[0] as { scope_entity_id: string | null } | undefined;
	if (row?.scope_entity_id) return getEntityProjectId(query, executor, row.scope_entity_id);
	throw new Error(`Cannot resolve project for context ${contextKey}.`);
}

/**
 * The synchronize feature class (ADR "Backends mirror one another per
 * feature, behind all-async feature interfaces"): a thin, promise-returning
 * wrapper the executor-holding local free functions above, which
 * `SqliteStore` composes alongside the other three feature classes.
 */
export class LocalSynchronizeStore implements SynchronizeStore {
	public constructor(private readonly executor: SqliteExecutor) {}

	public async exportCanonicalChains(): Promise<CanonicalChainBundle> {
		return exportCanonicalChains(this.executor);
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle): Promise<CanonicalChainImportResult> {
		return importCanonicalChains(this.executor, bundle);
	}
}

function parseStringArray(value: string): string[] {
	try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}