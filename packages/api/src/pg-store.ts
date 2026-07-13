import type {
	BodySource,
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	ContextSyncRecord,
	ContextTermSyncRecord,
	DatabaseSnapshot,
	DefineContextTermResult,
	DeleteResult,
	DeleteTenantResult,
	EntityDetails,
	EntityRecord,
	ForgetContextTermResult,
	HandoffDeleteResult,
	HandoffDetails,
	HandoffRecord,
	HistoryEntryRecord,
	InitiativeBundle,
	LinkResult,
	MoveResult,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult,
	RelationRecord,
	RenameTenantResult,
	StatusUpdateResult,
	StorageDriver,
	TenantSummary,
	UnlinkResult
} from "@agent-issues/core";
import type { Pool } from "pg";

import { withTenantTransaction } from "./db/connection.js";
import { deleteTenant, listTenants, renameTenant } from "./db/tenant-admin.js";
import {
	applyContextTerms,
	applyContexts,
	defineContextTerm,
	forgetContextTerm,
	getContextDetails,
	getContextDirectory,
	listAllContextTerms,
	listAllContexts,
	listContexts,
	queryContextDirectory,
	upsertContext
} from "./features/context/pg-context-store.js";
import {
	applyHandoffs,
	applyHistoryEntries,
	applyRelations,
	applyResolvedFacts,
	archiveEntity,
	createEntity,
	createHandoff,
	deleteEntity,
	deleteHandoff,
	getDatabaseSnapshot,
	getEntityDetails,
	getHandoffDetails,
	getInitiativeBundle,
	getSnapshotSignature,
	linkEntities,
	listAllHandoffs,
	listAllHistoryEntries,
	listAllRelations,
	listEntities,
	listEntityHistory,
	listHandoffs,
	listOrphans,
	listProjectAdrs,
	moveEntity,
	setEntityBody,
	unlinkEntities,
	updateEntityStatus,
	updateHandoff
} from "./features/entity-store/pg-entity-store.js";

/**
 * Postgres implementation of the storage-driver seam (ADR11, ADR13, ISS39).
 * Every method opens exactly one `withTenantTransaction` (ADR9's `SET LOCAL
 * app.tenant_id`), so RLS is always active for the query, then delegates to
 * the free functions in `features/entity-store`, `features/context`, and
 * `db/tenant-admin` - mirroring `SqliteStore`'s own thin-delegating-class
 * shape exactly (`api-local/src/sqlite-store.ts`).
 *
 * Tenant administration (`listTenants`/`deleteTenant`/`renameTenant`) is
 * necessarily narrower here than `SqliteStore`'s: RLS makes each `PgStore`
 * instance's own tenant the only one it can ever see or touch (ADR9), so
 * these methods only ever report on or act on `this.tenantId` - never an
 * arbitrary other tenant the way a single SQLite file's admin CLI can.
 * `renameTenant` copies every row to the new tenant id under a temporarily
 * re-pointed `app.tenant_id` and then deletes the old rows, rather than a
 * single `UPDATE ... SET tenant_id`, because RLS's `USING` (old value) and
 * `WITH CHECK` (new value) can never both pass for one statement scoped to
 * a single session tenant id.
 */
export class PgStore implements StorageDriver {
	public constructor(
		private readonly pool: Pool,
		public readonly tenantId: string,
		/**
		 * The client-resolved project identity (ISS183, mirroring
		 * `resolveProjectIdentity` in core) this request is scoped to.
		 * Threaded from the cloud gate's `x-agent-issues-project-identity`
		 * header. Undefined keeps today's behavior: the bare (no `--scope`)
		 * default context resolves to the tenant-wide sentinel, exactly as
		 * before this issue - so single-project tenants and any caller that
		 * doesn't send the header see no change at all.
		 */
		private readonly projectIdentity?: string
	) {}

	public async createEntity(input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		author?: string;
	}): Promise<EntityRecord> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => createEntity(client, this.tenantId, input));
	}

	public async getEntityDetails(entityId: string): Promise<EntityDetails> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getEntityDetails(client, this.tenantId, entityId));
	}

	public async listEntities(kind: string): Promise<EntityRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listEntities(client, this.tenantId, kind));
	}

	public async listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listEntityHistory(client, this.tenantId, entityId));
	}

	public async listAllHistoryEntries(): Promise<HistoryEntryRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listAllHistoryEntries(client, this.tenantId));
	}

	public async applyHistoryEntries(entries: HistoryEntryRecord[]): Promise<{ inserted: number }> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => applyHistoryEntries(client, this.tenantId, entries));
	}

	public async applyResolvedFacts(resolvedEntries: HistoryEntryRecord[]): Promise<{ created: string[]; updated: string[] }> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => applyResolvedFacts(client, this.tenantId, resolvedEntries));
	}

	public async listAllRelations(): Promise<RelationRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listAllRelations(client, this.tenantId));
	}

	public async applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => applyRelations(client, this.tenantId, relations));
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => linkEntities(client, this.tenantId, input));
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => unlinkEntities(client, this.tenantId, input));
	}

	public async updateEntityStatus(input: { entityId: string; status: string; author?: string }): Promise<StatusUpdateResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => updateEntityStatus(client, this.tenantId, input));
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string }): Promise<EntityRecord> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => setEntityBody(client, this.tenantId, input));
	}

	public async archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => archiveEntity(client, this.tenantId, input));
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => moveEntity(client, this.tenantId, input));
	}

	public async deleteEntity(input: { entityId: string }): Promise<DeleteResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => deleteEntity(client, this.tenantId, input));
	}

	public async listOrphans(kind?: string): Promise<EntityRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listOrphans(client, this.tenantId, kind));
	}

	public async listProjectAdrs(): Promise<EntityRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listProjectAdrs(client, this.tenantId));
	}

	public async getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getInitiativeBundle(client, this.tenantId, initiativeId));
	}

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getDatabaseSnapshot(client, this.tenantId, this.projectIdentity));
	}

	public async getSnapshotSignature(): Promise<string> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getSnapshotSignature(client, this.tenantId));
	}

	public async createHandoff(input: { entityId: string; summary?: string; body: string }): Promise<HandoffRecord> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => createHandoff(client, this.tenantId, input));
	}

	public async updateHandoff(input: { handoffId: string; summary?: string; body?: string }): Promise<HandoffRecord> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => updateHandoff(client, this.tenantId, input));
	}

	public async deleteHandoff(input: { handoffId: string }): Promise<HandoffDeleteResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => deleteHandoff(client, this.tenantId, input));
	}

	public async getHandoffDetails(entityId: string): Promise<HandoffDetails> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getHandoffDetails(client, this.tenantId, entityId));
	}

	public async listHandoffs(filter?: { initiativeId?: string; entityId?: string }): Promise<HandoffRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listHandoffs(client, this.tenantId, filter));
	}

	public async listAllHandoffs(): Promise<HandoffRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listAllHandoffs(client, this.tenantId));
	}

	public async applyHandoffs(handoffs: HandoffRecord[]): Promise<{ inserted: number }> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => applyHandoffs(client, this.tenantId, handoffs));
	}

	public async listContexts(): Promise<ContextListResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listContexts(client, this.tenantId, this.projectIdentity));
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getContextDetails(client, this.tenantId, this.projectIdentity, input));
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getContextDirectory(client, this.tenantId, this.projectIdentity));
	}

	public async queryContextDirectory(input: QueryContextDirectoryInput = {}): Promise<QueryContextDirectoryResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) =>
			queryContextDirectory(client, this.tenantId, this.projectIdentity, input)
		);
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string }): Promise<ContextDetails> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => upsertContext(client, this.tenantId, this.projectIdentity, input));
	}

	public async defineContextTerm(input: {
		scopeRef?: string;
		term: string;
		definition: string;
		avoid?: string[];
	}): Promise<DefineContextTermResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => defineContextTerm(client, this.tenantId, this.projectIdentity, input));
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string }): Promise<ForgetContextTermResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => forgetContextTerm(client, this.tenantId, this.projectIdentity, input));
	}

	public async listAllContexts(): Promise<ContextSyncRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listAllContexts(client, this.tenantId));
	}

	public async applyContexts(contexts: ContextSyncRecord[]): Promise<{ applied: number }> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => applyContexts(client, this.tenantId, contexts));
	}

	public async listAllContextTerms(): Promise<ContextTermSyncRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listAllContextTerms(client, this.tenantId));
	}

	public async applyContextTerms(terms: ContextTermSyncRecord[]): Promise<{ applied: number }> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => applyContextTerms(client, this.tenantId, terms));
	}

	public async listTenants(): Promise<TenantSummary[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listTenants(client, this.tenantId));
	}

	public async deleteTenant(tenantId: string): Promise<DeleteTenantResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => deleteTenant(client, this.tenantId, tenantId));
	}

	public async renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => renameTenant(client, this.tenantId, previousTenantId, newTenantId));
	}

	public async close(): Promise<void> {
		await this.pool.end();
	}
}

export function openPgStore(pool: Pool, tenantId: string): PgStore {
	return new PgStore(pool, tenantId);
}
