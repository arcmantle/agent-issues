import { existsSync, statSync } from "node:fs";

import { measureHistory, type BodySource, type DatabaseSnapshot, type ProjectSnapshot, type RelationRecord, type StorageDriver } from "@agent-issues/core";
import type { CanonicalChainBundle } from "@agent-issues/core";
import { exportCanonicalChains, importCanonicalChains } from "./features/synchronize/canonical-chain-store.js";
import type {
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	QueryContextDirectoryInput
} from "./features/context/context-store.js";
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
} from "./features/context/context-store.js";
import type { DatabaseHandle, DatabaseLocationOptions } from "./db/database.js";
import { getHistoryMaterializationDepths } from "./features/history-diagnostics.js";
import { deleteTenant, ensureDatabase, listTenants, renameTenant } from "./db/database.js";
import type { SqliteExecutor } from "./db/sqlite-executor.js";
import {
	applyRelations,
	archiveEntity,
	createEntity,
	deleteEntity,
	getDatabaseSnapshot,
	getProjectDiscovery,
	getEntityDetails,
	getInitiativeBundle,
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
} from "./features/entity-store/store.js";

export type OpenSqliteStoreResult = {
	store: SqliteStore;
	dbPath: string;
};

/**
 * A stat-based signature of the sqlite file backing this store and its WAL/
 * SHM sidecar files (ISS191): `size:mtime` per candidate path, joined -
 * changes whenever any write reaches the file (any tenant, since one file
 * can hold several - matching the pre-ISS191 direct-`stat()` polling
 * behavior exactly), and stays stable with no writes. Missing sidecar files
 * (e.g. before WAL mode ever checkpoints) are represented explicitly rather
 * than omitted, so a file's mere appearance/disappearance also counts as a
 * change.
 */
function computeFileStatSignature(dbPath: string): string {
	return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
		.map((candidate) => {
			if (!existsSync(candidate)) {
				return `${candidate}:missing`;
			}

			const stats = statSync(candidate);
			return `${candidate}:${stats.size}:${stats.mtimeMs}`;
		})
		.join("|");
}

/**
 * The local, offline-default implementation of the storage-driver seam
 * (ADR11, ADR13). Wraps a synchronous better-sqlite3 connection; every
 * method resolves immediately since SQLite access is synchronous, but the
 * async signatures match the seam so a Postgres/HttpStore implementation
 * can slot in without callers branching on backend.
 */
export class SqliteStore implements StorageDriver {
	public constructor(executor: SqliteExecutor) {
		this.executor = executor;
	}

	protected executor: SqliteExecutor;

	protected get db(): DatabaseHandle {
		return this.executor.db;
	}

	public get tenantId(): string {
		return this.db.tenantId;
	}

	public async exportCanonicalChains() {
		return exportCanonicalChains(this.executor);
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle) {
		return importCanonicalChains(this.executor, bundle);
	}

	public async getHistoryDiagnostics() {
		return measureHistory(exportCanonicalChains(this.executor), getHistoryMaterializationDepths(this.executor));
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
		return createEntity(this.executor, input);
	}

	public async getEntityDetails(entityId: string) {
		return getEntityDetails(this.executor, entityId);
	}

	public async queryEntityRelations(input: Parameters<StorageDriver["queryEntityRelations"]>[0]) {
		return queryEntityRelations(this.executor, input);
	}

	public async listEntities(kind: string) {
		return listEntities(this.executor, kind);
	}

	public async queryEntities(input: Parameters<StorageDriver["queryEntities"]>[0]) {
		return queryEntities(this.executor, input);
	}

	public async listEntityHistory(entityId: string) {
		return listEntityHistory(this.executor, entityId);
	}

	public async listAllRelations() {
		return listAllRelations(this.executor);
	}

	public async applyRelations(relations: RelationRecord[]) {
		return applyRelations(this.executor, relations);
	}

	public async listOrphans(kind?: string) {
		return kind ? listOrphans(this.executor, kind) : listOrphans(this.executor);
	}

	public async listProjectAdrs() {
		return listProjectAdrs(this.executor);
	}

	public async updateEntityStatus(input: { entityId: string; status: string; author?: string }) {
		return updateEntityStatus(this.executor, input);
	}

	public async updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return updateEntity(this.executor, input);
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return setEntityBody(this.executor, input);
	}

	public async materializeEntityRevision(input: { entityId: string; revision: number }) {
		return materializeEntityRevision(this.executor, input);
	}

	public async restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return restoreEntityRevision(this.executor, input);
	}

	public async archiveEntity(input: { entityId: string }) {
		return archiveEntity(this.executor, input);
	}

	public async deleteEntity(input: { entityId: string }) {
		return deleteEntity(this.executor, input);
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }) {
		return moveEntity(this.executor, input);
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }) {
		return linkEntities(this.executor, input);
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }) {
		return unlinkEntities(this.executor, input);
	}

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	public async getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	public async getDatabaseSnapshot(input?: { projectId: string }): Promise<DatabaseSnapshot | ProjectSnapshot> {
		return input ? getDatabaseSnapshot(this.executor, input) : getDatabaseSnapshot(this.executor);
	}

	public async getProjectDiscovery(input?: { projectId?: string }) {
		return getProjectDiscovery(this.executor, input);
	}

	public async getInitiativeBundle(initiativeId: string) {
		return getInitiativeBundle(this.executor, initiativeId);
	}

	public async getSnapshotSignature(): Promise<string> {
		return computeFileStatSignature(this.db.name);
	}

	public async listContexts(): Promise<ContextListResult> {
		return listContexts(this.executor);
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return getContextDetails(this.executor, input);
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return getContextDirectory(this.executor);
	}

	public async queryContextDirectory(input?: QueryContextDirectoryInput) {
		return queryContextDirectory(this.executor, input);
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ContextDetails> {
		return upsertContext(this.executor, input);
	}

	public async defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }) {
		return defineContextTerm(this.executor, input);
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }) {
		return forgetContextTerm(this.executor, input);
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }) {
		return materializeContextRevision(this.executor, input);
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }) {
		return materializeContextTermRevision(this.executor, input);
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return restoreContextRevision(this.executor, input);
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return restoreContextTermRevision(this.executor, input);
	}

	public async listTenants() {
		return listTenants(this.db);
	}

	public async deleteTenant(tenantId: string) {
		return deleteTenant(this.db, tenantId);
	}

	public async renameTenant(previousTenantId: string, newTenantId: string) {
		return renameTenant(this.db, previousTenantId, newTenantId);
	}

	public async close(): Promise<void> {
		this.db.close();
	}
}

export async function openSqliteStore(inputPath?: string, options?: DatabaseLocationOptions): Promise<OpenSqliteStoreResult> {
	const { executor, dbPath } = await ensureDatabase(inputPath, options);
	return { store: new SqliteStore(executor), dbPath };
}
