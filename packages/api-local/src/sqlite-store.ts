import { measureHistory, type BodySource, type DatabaseSnapshot, type ProjectSnapshot, type RelationRecord, type StorageDriver } from "@agent-issues/core";
import type { CanonicalChainBundle } from "@agent-issues/core";
import { LocalSynchronizeStore } from "./features/synchronize/canonical-chain-store.js";
import type {
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	QueryContextDirectoryInput
} from "./features/context/context-store.js";
import { LocalContextStore } from "./features/context/context-store.js";
import type { DatabaseLocationOptions } from "./db/database.js";
import { LocalHistoryDiagnosticsStore } from "./features/history-diagnostics.js";
import { deleteTenant, ensureDatabase, listTenants, renameTenant } from "./db/database.js";
import type { SqliteExecutor, SqliteInternalConnection } from "./db/sqlite-executor.js";
import { LocalEntityStore } from "./features/entity-store/store.js";

export type OpenSqliteStoreResult = {
	store: SqliteStore;
	dbPath: string;
};

/**
 * The local, offline-default implementation of the storage-driver seam
 * (ADR11, ADR13). Wraps a synchronous better-sqlite3 connection; every
 * method resolves immediately since SQLite access is synchronous, but the
 * async signatures match the seam so a Postgres/HttpStore implementation
 * can slot in without callers branching on backend.
 */
export class SqliteStore implements StorageDriver {
	public constructor(executor: SqliteInternalConnection) {
		this.executor = executor;
		this.synchronizeStore = new LocalSynchronizeStore(executor);
		this.historyDiagnosticsStore = new LocalHistoryDiagnosticsStore(executor);
		this.contextStore = new LocalContextStore(executor);
		this.entityStore = new LocalEntityStore(executor);
	}

	protected executor: SqliteInternalConnection;
	private readonly synchronizeStore: LocalSynchronizeStore;
	private readonly historyDiagnosticsStore: LocalHistoryDiagnosticsStore;
	private readonly contextStore: LocalContextStore;
	private readonly entityStore: LocalEntityStore;

	public get tenantId(): string {
		return this.executor.tenantId;
	}

	public async exportCanonicalChains() {
		return this.synchronizeStore.exportCanonicalChains();
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle) {
		return this.synchronizeStore.importCanonicalChains(bundle);
	}

	public async getHistoryDiagnostics() {
		return measureHistory(await this.synchronizeStore.exportCanonicalChains(), await this.historyDiagnosticsStore.getMaterializationDepths());
	}

	public async createEntity(input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		author?: string;
		links?: Array<{ relationType: string; targetId: string }>;
	}) {
		return this.entityStore.createEntity(input);
	}

	public async getEntityDetails(entityId: string) {
		return this.entityStore.getEntityDetails(entityId);
	}

	public async queryEntityRelations(input: Parameters<StorageDriver["queryEntityRelations"]>[0]) {
		return this.entityStore.queryEntityRelations(input);
	}

	public async listEntities(kind: string) {
		return this.entityStore.listEntities(kind);
	}

	public async queryEntities(input: Parameters<StorageDriver["queryEntities"]>[0]) {
		return this.entityStore.queryEntities(input);
	}

	public async listEntityHistory(entityId: string) {
		return this.entityStore.listEntityHistory(entityId);
	}

	public async listAllRelations() {
		return this.entityStore.listAllRelations();
	}

	public async applyRelations(relations: RelationRecord[]) {
		return this.entityStore.applyRelations(relations);
	}

	public async listOrphans(kind?: string) {
		return this.entityStore.listOrphans(kind);
	}

	public async listProjectAdrs() {
		return this.entityStore.listProjectAdrs();
	}

	public async updateEntityStatus(input: { entityId: string; status: string; author?: string }) {
		return this.entityStore.updateEntityStatus(input);
	}

	public async updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.entityStore.updateEntity(input);
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.entityStore.setEntityBody(input);
	}

	public async materializeEntityRevision(input: { entityId: string; revision: number }) {
		return this.entityStore.materializeEntityRevision(input);
	}

	public async restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.entityStore.restoreEntityRevision(input);
	}

	public async archiveEntity(input: { entityId: string }) {
		return this.entityStore.archiveEntity(input);
	}

	public async deleteEntity(input: { entityId: string }) {
		return this.entityStore.deleteEntity(input);
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }) {
		return this.entityStore.moveEntity(input);
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }) {
		return this.entityStore.linkEntities(input);
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }) {
		return this.entityStore.unlinkEntities(input);
	}

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	public async getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	public async getDatabaseSnapshot(input?: { projectId: string }): Promise<DatabaseSnapshot | ProjectSnapshot> {
		return input ? this.entityStore.getDatabaseSnapshot(input) : this.entityStore.getDatabaseSnapshot();
	}

	public async getProjectDiscovery(input?: { projectId?: string }) {
		return this.entityStore.getProjectDiscovery(input);
	}

	public async getInitiativeBundle(initiativeId: string) {
		return this.entityStore.getInitiativeBundle(initiativeId);
	}

	public async getSnapshotSignature(): Promise<string> {
		return this.entityStore.getSnapshotSignature();
	}

	public async listContexts(): Promise<ContextListResult> {
		return this.contextStore.listContexts();
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return this.contextStore.getContextDetails(input);
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return this.contextStore.getContextDirectory();
	}

	public async queryContextDirectory(input?: QueryContextDirectoryInput) {
		return this.contextStore.queryContextDirectory(input);
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ContextDetails> {
		return this.contextStore.upsertContext(input);
	}

	public async defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }) {
		return this.contextStore.defineContextTerm(input);
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }) {
		return this.contextStore.forgetContextTerm(input);
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }) {
		return this.contextStore.materializeContextRevision(input);
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }) {
		return this.contextStore.materializeContextTermRevision(input);
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.contextStore.restoreContextRevision(input);
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.contextStore.restoreContextTermRevision(input);
	}

	public async listTenants() {
		return listTenants(this.executor);
	}

	public async deleteTenant(tenantId: string) {
		return deleteTenant(this.executor, tenantId);
	}

	public async renameTenant(previousTenantId: string, newTenantId: string) {
		return renameTenant(this.executor, previousTenantId, newTenantId);
	}

	public async close(): Promise<void> {
		this.executor.close();
	}
}

export async function openSqliteStore(inputPath?: string, options?: DatabaseLocationOptions): Promise<OpenSqliteStoreResult> {
	const { executor, dbPath } = await ensureDatabase(inputPath, options);
	return { store: new SqliteStore(executor), dbPath };
}
