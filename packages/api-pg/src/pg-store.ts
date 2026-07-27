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

import { withTenantTransaction, type TenantExecutor } from "./db/connection.js";
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
	primeCurrentProjectId,
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

	/**
	 * The project this store settled on, kept for its lifetime. See
	 * `transaction` for why it is resolved once rather than per call.
	 */
	protected currentProjectId?: string;

	/**
	 * One `withTenantTransaction` per store method (ADR9), carrying this
	 * request's `projectIdentity` onto the executor so project-scoped reads can
	 * resolve it.
	 *
	 * The project is resolved on this store's FIRST transaction and remembered
	 * for its lifetime, which is what makes cloud behave like local rather than
	 * merely look like it: local resolves `currentProjectId` once when the
	 * database is opened, so a session that later creates a second project
	 * keeps operating as the project it opened against. Resolving lazily or
	 * per-transaction instead would make the same sequence start failing the
	 * moment a second project appeared. Only harvested after `fn` succeeds - a
	 * rolled-back transaction may have resolved to a project that no longer
	 * exists.
	 */
	protected transaction<T>(fn: (client: TenantExecutor) => Promise<T>): Promise<T> {
		return withTenantTransaction(
			this.pool,
			this.tenantId,
			async (client) => {
				// Awaited before `fn` runs, not merely started: the advisory lock
				// inside project registration is transaction-scoped, so it cannot
				// serialize two resolutions racing within this same transaction.
				// Letting `fn` start first is how a store ends up minting two
				// projects for one identity and making it ambiguous forever.
				const projectId = this.currentProjectId ?? (await primeCurrentProjectId(client));
				client.currentProjectId = Promise.resolve(projectId);

				const result = await fn(client);
				this.currentProjectId = projectId;
				return result;
			},
			this.projectIdentity
		);
	}

	/**
	 * For the methods that legitimately span every project - project discovery
	 * (the call that tells you which projects exist), whole-tenant synchronize,
	 * and tenant administration. These deliberately skip project resolution:
	 * requiring one would make discovery fail in exactly the multi-project
	 * tenants it exists for, and would let a `deleteTenant` call register a
	 * project in the tenant it is about to remove.
	 */
	protected tenantWideTransaction<T>(fn: (client: TenantExecutor) => Promise<T>): Promise<T> {
		return withTenantTransaction(this.pool, this.tenantId, fn, this.projectIdentity);
	}

	public async exportCanonicalChains() {
		return this.tenantWideTransaction((client) => exportCanonicalChains(client));
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle) {
		return this.tenantWideTransaction((client) => importCanonicalChains(client, bundle));
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
		return this.transaction((client) => createEntity(client, input, this.projectIdentity));
	}

	public async getEntityDetails(entityId: string): Promise<EntityDetails> {
		return this.transaction((client) => getEntityDetails(client, entityId));
	}

	public async queryEntityRelations(input: QueryEntityRelationsInput): Promise<EntityDetails> {
		return this.transaction((client) => queryEntityRelations(client, input));
	}

	public async listEntities(kind: string): Promise<EntityRecord[]> {
		return this.transaction((client) => listEntities(client, kind));
	}

	public async queryEntities(input: QueryEntitiesInput): Promise<QueryEntitiesResult> {
		return this.transaction((client) => queryEntities(client, input));
	}

	public async listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]> {
		return this.transaction((client) => listEntityHistory(client, entityId));
	}

	public async listAllRelations(): Promise<RelationRecord[]> {
		return this.transaction((client) => listAllRelations(client));
	}

	public async applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }> {
		return this.transaction((client) => applyRelations(client, relations));
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult> {
		return this.transaction((client) => linkEntities(client, input));
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult> {
		return this.transaction((client) => unlinkEntities(client, input));
	}

	public async updateEntityStatus(input: { entityId: string; status: string; author?: string }): Promise<StatusUpdateResult> {
		return this.transaction((client) => updateEntityStatus(client, input));
	}

	public async updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord> {
		return this.transaction((client) => updateEntity(client, input));
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord> {
		return this.transaction((client) => setEntityBody(client, input));
	}

	public async materializeEntityRevision(input: { entityId: string; revision: number }) {
		const result = await this.transaction((client) => materializeEntityRevision(client, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "entity", result.headRevision, result.targetRevision);
		return result;
	}

	public async restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await this.transaction((client) => restoreEntityRevision(client, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "entity", input.expectedRevision, input.revision);
		return result;
	}

	public async archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult> {
		return this.transaction((client) => archiveEntity(client, input));
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult> {
		return this.transaction((client) => moveEntity(client, input));
	}

	public async deleteEntity(input: { entityId: string }): Promise<DeleteResult> {
		return this.transaction((client) => deleteEntity(client, input));
	}

	public async listOrphans(kind?: string): Promise<EntityRecord[]> {
		return this.transaction((client) => listOrphans(client, kind));
	}

	public async listProjectAdrs(): Promise<EntityRecord[]> {
		return this.transaction((client) => listProjectAdrs(client));
	}

	public async getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle> {
		return this.transaction((client) => getInitiativeBundle(client, initiativeId));
	}

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	public async getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	public async getDatabaseSnapshot(input?: { projectId: string }): Promise<DatabaseSnapshot | ProjectSnapshot> {
		if (input) {
			return this.transaction((client) => getDatabaseSnapshot(client, this.projectIdentity, input));
		}

		return this.transaction((client) => getDatabaseSnapshot(client, this.projectIdentity));
	}

	public async getProjectDiscovery(input?: { projectId?: string }): Promise<ProjectDiscovery> {
		return this.tenantWideTransaction((client) => getProjectDiscovery(client, input));
	}

	public async getSnapshotSignature(): Promise<string> {
		return this.tenantWideTransaction((client) => getSnapshotSignature(client));
	}

	public async listContexts(): Promise<ContextListResult> {
		return this.transaction((client) => listContexts(client, this.projectIdentity));
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return this.transaction((client) => getContextDetails(client, this.projectIdentity, input));
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return this.transaction((client) => getContextDirectory(client, this.projectIdentity));
	}

	public async queryContextDirectory(input: QueryContextDirectoryInput = {}): Promise<QueryContextDirectoryResult> {
		return this.transaction((client) => queryContextDirectory(client, this.projectIdentity, input));
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ContextDetails> {
		return this.transaction((client) => upsertContext(client, this.projectIdentity, input));
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
		return this.transaction((client) => defineContextTerm(client, this.projectIdentity, input));
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ForgetContextTermResult> {
		return this.transaction((client) => forgetContextTerm(client, this.projectIdentity, input));
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }) {
		const result = await this.transaction((client) => materializeContextRevision(client, this.projectIdentity, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "context", result.headRevision, result.targetRevision);
		return result;
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }) {
		const result = await this.transaction((client) => materializeContextTermRevision(client, this.projectIdentity, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "context-term", result.headRevision, result.targetRevision);
		return result;
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await this.transaction((client) => restoreContextRevision(client, this.projectIdentity, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "context", input.expectedRevision, input.revision);
		return result;
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await this.transaction((client) => restoreContextTermRevision(client, this.projectIdentity, input));
		recordHistoryMaterialization(this.pool, this.tenantId, "context-term", input.expectedRevision, input.revision);
		return result;
	}

	public async listTenants(): Promise<TenantSummary[]> {
		return this.tenantWideTransaction((client) => listTenants(client, this.tenantId));
	}

	public async deleteTenant(tenantId: string): Promise<DeleteTenantResult> {
		return this.tenantWideTransaction((client) => deleteTenant(client, this.tenantId, tenantId));
	}

	public async renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult> {
		return this.tenantWideTransaction((client) => renameTenant(client, this.tenantId, previousTenantId, newTenantId));
	}

	public async close(): Promise<void> {
		await this.pool.end();
	}
}

export function openPgStore(pool: Pool, tenantId: string): PgStore {
	return new PgStore(pool, tenantId);
}
