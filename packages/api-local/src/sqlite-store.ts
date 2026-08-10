import { measureHistory, resolveLocalUsername, type AuthIdentity, type BodySource, type DatabaseSnapshot, type ProjectSnapshot, type RelationRecord, type StorageDriver } from "@agent-issues/core";
import type { CanonicalChainBundle } from "@agent-issues/core";
import { LocalSynchronizeStore } from "./features/synchronize/canonical-chain-store.js";
import * as localSynchronizeStore from "./features/synchronize/canonical-chain-store.js";
import { LocalUserDirectoryStore, upsertUser } from "./features/user-directory/store.js";
import type {
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	QueryContextDirectoryInput
} from "./features/context/context-store.js";
import { LocalContextStore } from "./features/context/context-store.js";
import * as localContextStore from "./features/context/context-store.js";
import type { DatabaseLocationOptions } from "./db/database.js";
import { LocalHistoryDiagnosticsStore } from "./features/history-diagnostics.js";
import { deleteTenant, ensureDatabase, listTenants, renameTenant } from "./db/database.js";
import type { SqliteExecutor, SqliteInternalConnection } from "./db/sqlite-executor.js";
import { LocalEntityStore } from "./features/entity-store/store.js";
import * as localEntityStore from "./features/entity-store/store.js";
import { LocalIssueCommentStore } from "./features/issue-comment/store.js";

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
	public constructor(executor: SqliteInternalConnection, actorIdentity?: AuthIdentity) {
		this.executor = executor;
		this.actorIdentity = actorIdentity;
		this.synchronizeStore = new LocalSynchronizeStore(executor);
		this.userDirectoryStore = new LocalUserDirectoryStore(executor);
		this.historyDiagnosticsStore = new LocalHistoryDiagnosticsStore(executor);
		this.contextStore = new LocalContextStore(executor);
		this.entityStore = new LocalEntityStore(executor);
		this.issueCommentStore = new LocalIssueCommentStore(executor);
	}

	protected executor: SqliteInternalConnection;
	protected readonly actorIdentity: AuthIdentity | undefined;
	private readonly synchronizeStore: LocalSynchronizeStore;
	private readonly userDirectoryStore: LocalUserDirectoryStore;
	private readonly historyDiagnosticsStore: LocalHistoryDiagnosticsStore;
	private readonly contextStore: LocalContextStore;
	private readonly entityStore: LocalEntityStore;
	protected readonly issueCommentStore: LocalIssueCommentStore;

	public get tenantId(): string {
		return this.executor.tenantId;
	}

	public withAuthenticatedIdentity(identity: AuthIdentity): StorageDriver {
		return new SqliteStore(this.executor, identity);
	}

	public async exportCanonicalChains() {
		return this.synchronizeStore.exportCanonicalChains();
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle) {
		return this.executor.drizzle.transaction(() => localSynchronizeStore.importCanonicalChains(this.executor, bundle));
	}

	public async upsertUser(input: Parameters<StorageDriver["upsertUser"]>[0]) {
		return this.userDirectoryStore.upsertUser(input);
	}

	public async listUsers() {
		return this.userDirectoryStore.listUsers();
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
		return this.mutate((actorId) => localEntityStore.createEntity(this.executor, input, actorId));
	}

	public async getEntityDetails(entityId: string) {
		const details = await this.entityStore.getEntityDetails(entityId);
		return details.entity.kind === "issue"
			? { ...details, comments: this.issueCommentStore.listIssueComments({ issueId: details.entity.id }) }
			: details;
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

	public async createIssueComment(input: Parameters<StorageDriver["createIssueComment"]>[0]) {
		return this.mutate((actorId) => this.issueCommentStore.createIssueComment(input, actorId));
	}

	public async updateIssueComment(input: Parameters<StorageDriver["updateIssueComment"]>[0]) {
		return this.mutate((actorId) => this.issueCommentStore.updateIssueComment(input, actorId));
	}

	public async deleteIssueComment(input: Parameters<StorageDriver["deleteIssueComment"]>[0]) {
		return this.mutate((actorId) => this.issueCommentStore.deleteIssueComment(input, actorId));
	}

	public async listIssueComments(input: Parameters<StorageDriver["listIssueComments"]>[0]) {
		return this.issueCommentStore.listIssueComments(input);
	}

	public async listIssueCommentHistory(input: Parameters<StorageDriver["listIssueCommentHistory"]>[0]) {
		return this.issueCommentStore.listIssueCommentHistory(input);
	}

	public async listAllRelations() {
		return this.entityStore.listAllRelations();
	}

	public async applyRelations(relations: RelationRecord[]) {
		return this.executor.drizzle.transaction(() => localEntityStore.applyRelations(this.executor, relations));
	}

	public async listOrphans(kind?: string) {
		return this.entityStore.listOrphans(kind);
	}

	public async listProjectAdrs() {
		return this.entityStore.listProjectAdrs();
	}

	public async updateEntityStatus(input: { entityId: string; status: string; author?: string }) {
		return this.mutate((actorId) => localEntityStore.updateEntityStatus(this.executor, input, actorId));
	}

	public async updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.mutate((actorId) => localEntityStore.updateEntity(this.executor, input, actorId));
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.mutate((actorId) => localEntityStore.setEntityBody(this.executor, input, actorId));
	}

	public async materializeEntityRevision(input: { entityId: string; revision: number }) {
		return this.entityStore.materializeEntityRevision(input);
	}

	public async restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.mutate((actorId) => localEntityStore.restoreEntityRevision(this.executor, input, actorId));
	}

	public async archiveEntity(input: { entityId: string }) {
		return this.mutate((actorId) => localEntityStore.archiveEntity(this.executor, input, actorId));
	}

	public async deleteEntity(input: { entityId: string }) {
		return this.mutate((actorId) => localEntityStore.deleteEntity(this.executor, input, actorId));
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }) {
		return this.mutate((actorId) => localEntityStore.moveEntity(this.executor, input, actorId));
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }) {
		return this.mutate((actorId) => localEntityStore.linkEntities(this.executor, input, actorId));
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }) {
		return this.mutate(() => localEntityStore.unlinkEntities(this.executor, input));
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
		return this.mutate((actorId) => localContextStore.upsertContext(this.executor, input, actorId));
	}

	public async defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }) {
		return this.mutate((actorId) => localContextStore.defineContextTerm(this.executor, input, actorId));
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }) {
		return this.mutate((actorId) => localContextStore.forgetContextTerm(this.executor, input, actorId));
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }) {
		return this.contextStore.materializeContextRevision(input);
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }) {
		return this.contextStore.materializeContextTermRevision(input);
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.mutate((actorId) => localContextStore.restoreContextRevision(this.executor, input, actorId));
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.mutate((actorId) => localContextStore.restoreContextTermRevision(this.executor, input, actorId));
	}

	public async listTenants() {
		return listTenants(this.executor);
	}

	public async deleteTenant(tenantId: string) {
		return this.mutate(() => deleteTenant(this.executor, tenantId));
	}

	public async renameTenant(previousTenantId: string, newTenantId: string) {
		return this.mutate(() => renameTenant(this.executor, previousTenantId, newTenantId));
	}

	public async close(): Promise<void> {
		this.executor.close();
	}

	protected mutate<T>(operation: (actorId: string) => T): T {
		return this.executor.drizzle.transaction(() => {
			const username = resolveLocalUsername();
			const identity = this.actorIdentity ?? { userId: `local:${username}`, tenantId: this.tenantId, displayName: username };
			const user = upsertUser(this.executor, { authenticationSubject: identity.userId, displayName: identity.displayName });
			return operation(user.id);
		});
	}
}

export async function openSqliteStore(inputPath?: string, options?: DatabaseLocationOptions): Promise<OpenSqliteStoreResult> {
	const { executor, dbPath } = await ensureDatabase(inputPath, options);
	return { store: new SqliteStore(executor), dbPath };
}
