import type {
	BodySource,
	CanonicalChainBundle,
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	DatabaseSnapshot,
	DefineContextTermResult,
	DeleteResult,
	DeleteTenantResult,
	EntityDetails,
	EntityRecord,
	ForgetContextTermResult,
	HistoryEntryRecord,
	InitiativeBundle,
	LinkResult,
	MoveResult,
	ProjectDiscovery,
	ProjectSnapshot,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult,
	QueryEntitiesInput,
	QueryEntitiesResult,
	QueryEntityRelationsInput,
	RelationRecord,
	RenameTenantResult,
	StatusUpdateResult,
	StorageDriver,
	TenantSummary,
	UnlinkResult
} from "@agent-issues/core";
import { measureHistory } from "@agent-issues/core";
import type { Pool } from "pg";

import { withTenantTransaction } from "./db/connection.js";
import { exportCanonicalChains, importCanonicalChains } from "./features/synchronize/pg-canonical-chain-store.js";
import { deleteTenant, listTenants, renameTenant } from "./db/tenant-admin.js";
import {
	defineContextTerm,
	forgetContextTerm,
	getContextDetails,
	getContextDirectory,
	listContexts,
	materializeContextRevision,
	materializeContextTermRevision,
	queryContextDirectory,
	restoreContextRevision,
	restoreContextTermRevision,
	upsertContext
} from "./features/context/pg-context-store.js";
import {
	applyRelations,
	archiveEntity,
	createEntity,
	deleteEntity,
	getDatabaseSnapshot,
	getProjectDiscovery,
	getEntityDetails,
	getInitiativeBundle,
	getSnapshotSignature,
	linkEntities,
	listAllRelations,
	listEntities,
	listEntityHistory,
	listOrphans,
	listProjectAdrs,
	materializeEntityRevision,
	moveEntity,
	queryEntities,
	queryEntityRelations,
	restoreEntityRevision,
	setEntityBody,
	unlinkEntities,
	updateEntity,
	updateEntityStatus
} from "./features/entity-store/pg-entity-store.js";
import { getHistoryMaterializationDepths, recordHistoryMaterialization } from "./features/history-diagnostics.js";

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

	public async exportCanonicalChains() {
		return withTenantTransaction(this.pool, this.tenantId, (client) => exportCanonicalChains(client, this.tenantId));
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle) {
		return withTenantTransaction(this.pool, this.tenantId, (client) => importCanonicalChains(client, this.tenantId, bundle));
	}

	public async getHistoryDiagnostics() {
		return measureHistory(await this.exportCanonicalChains(), getHistoryMaterializationDepths(this.pool, this.tenantId));
	}

	public async createEntity(input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		author?: string;
		links?: Array<{ relationType: string; targetId: string }>;
	}): Promise<EntityRecord> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => createEntity(client, this.tenantId, input, this.projectIdentity));
	}

	public async getEntityDetails(entityId: string): Promise<EntityDetails> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getEntityDetails(client, this.tenantId, entityId));
	}

	public async queryEntityRelations(input: QueryEntityRelationsInput): Promise<EntityDetails> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => queryEntityRelations(client, this.tenantId, input));
	}

	public async listEntities(kind: string): Promise<EntityRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listEntities(client, this.tenantId, kind));
	}

	public async queryEntities(input: QueryEntitiesInput): Promise<QueryEntitiesResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => queryEntities(client, this.tenantId, input));
	}

	public async listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => listEntityHistory(client, this.tenantId, entityId));
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

	public async updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => updateEntity(client, this.tenantId, input));
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => setEntityBody(client, this.tenantId, input));
	}

	public async materializeEntityRevision(input: { entityId: string; revision: number }) {
		const result = await withTenantTransaction(this.pool, this.tenantId, (client) => materializeEntityRevision(client, this.tenantId, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "entity", result.headRevision, result.targetRevision);
		return result;
	}

	public async restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await withTenantTransaction(this.pool, this.tenantId, (client) => restoreEntityRevision(client, this.tenantId, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "entity", input.expectedRevision, input.revision);
		return result;
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

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	public async getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	public async getDatabaseSnapshot(input?: { projectId: string }): Promise<DatabaseSnapshot | ProjectSnapshot> {
		if (input) {
			return withTenantTransaction(this.pool, this.tenantId, (client) =>
				getDatabaseSnapshot(client, this.tenantId, this.projectIdentity, input)
			);
		}

		return withTenantTransaction(this.pool, this.tenantId, (client) => getDatabaseSnapshot(client, this.tenantId, this.projectIdentity));
	}

	public async getProjectDiscovery(input?: { projectId?: string }): Promise<ProjectDiscovery> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getProjectDiscovery(client, this.tenantId, input));
	}

	public async getSnapshotSignature(): Promise<string> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => getSnapshotSignature(client, this.tenantId));
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

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ContextDetails> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => upsertContext(client, this.tenantId, this.projectIdentity, input));
	}

	public async defineContextTerm(input: {
		scopeRef?: string;
		term: string;
		definition: string;
		avoid?: string[];
		author?: string;
		expectedRevision?: number;
		expectedContentHash?: string;
	}): Promise<DefineContextTermResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => defineContextTerm(client, this.tenantId, this.projectIdentity, input));
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ForgetContextTermResult> {
		return withTenantTransaction(this.pool, this.tenantId, (client) => forgetContextTerm(client, this.tenantId, this.projectIdentity, input));
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }) {
		const result = await withTenantTransaction(this.pool, this.tenantId, (client) => materializeContextRevision(client, this.tenantId, this.projectIdentity, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "context", result.headRevision, result.targetRevision);
		return result;
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }) {
		const result = await withTenantTransaction(this.pool, this.tenantId, (client) => materializeContextTermRevision(client, this.tenantId, this.projectIdentity, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "context-term", result.headRevision, result.targetRevision);
		return result;
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await withTenantTransaction(this.pool, this.tenantId, (client) => restoreContextRevision(client, this.tenantId, this.projectIdentity, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "context", input.expectedRevision, input.revision);
		return result;
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await withTenantTransaction(this.pool, this.tenantId, (client) => restoreContextTermRevision(client, this.tenantId, this.projectIdentity, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "context-term", input.expectedRevision, input.revision);
		return result;
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
