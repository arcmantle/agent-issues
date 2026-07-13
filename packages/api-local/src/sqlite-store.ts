import { existsSync, statSync } from "node:fs";

import type { BodySource, HistoryEntryRecord, RelationRecord, StorageDriver } from "@agent-issues/core";
import type {
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	ContextSyncRecord,
	ContextTermSyncRecord,
	QueryContextDirectoryInput
} from "./features/context/context-store.js";
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
} from "./features/context/context-store.js";
import type { DatabaseHandle, DatabaseLocationOptions } from "./db/database.js";
import { deleteTenant, ensureDatabase, listTenants, renameTenant } from "./db/database.js";
import type { HandoffRecord } from "./features/entity-store/store.js";
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
	public constructor(private readonly db: DatabaseHandle) {}

	public get tenantId(): string {
		return this.db.tenantId;
	}

	public async createEntity(input: { kind: string; title: string; parentId?: string; status?: string; body?: string; author?: string }) {
		return createEntity(this.db, input);
	}

	public async getEntityDetails(entityId: string) {
		return getEntityDetails(this.db, entityId);
	}

	public async listEntities(kind: string) {
		return listEntities(this.db, kind);
	}

	public async listEntityHistory(entityId: string) {
		return listEntityHistory(this.db, entityId);
	}

	public async listAllHistoryEntries() {
		return listAllHistoryEntries(this.db);
	}

	public async applyHistoryEntries(entries: HistoryEntryRecord[]) {
		return applyHistoryEntries(this.db, entries);
	}

	public async applyResolvedFacts(resolvedEntries: HistoryEntryRecord[]) {
		return applyResolvedFacts(this.db, resolvedEntries);
	}

	public async listAllRelations() {
		return listAllRelations(this.db);
	}

	public async applyRelations(relations: RelationRecord[]) {
		return applyRelations(this.db, relations);
	}

	public async listAllContexts() {
		return listAllContexts(this.db);
	}

	public async applyContexts(contexts: ContextSyncRecord[]) {
		return applyContexts(this.db, contexts);
	}

	public async listAllContextTerms() {
		return listAllContextTerms(this.db);
	}

	public async applyContextTerms(terms: ContextTermSyncRecord[]) {
		return applyContextTerms(this.db, terms);
	}

	public async listAllHandoffs() {
		return listAllHandoffs(this.db);
	}

	public async applyHandoffs(handoffs: HandoffRecord[]) {
		return applyHandoffs(this.db, handoffs);
	}

	public async listOrphans(kind?: string) {
		return kind ? listOrphans(this.db, kind) : listOrphans(this.db);
	}

	public async listProjectAdrs() {
		return listProjectAdrs(this.db);
	}

	public async updateEntityStatus(input: { entityId: string; status: string; author?: string }) {
		return updateEntityStatus(this.db, input);
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string }) {
		return setEntityBody(this.db, input);
	}

	public async archiveEntity(input: { entityId: string }) {
		return archiveEntity(this.db, input);
	}

	public async deleteEntity(input: { entityId: string }) {
		return deleteEntity(this.db, input);
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }) {
		return moveEntity(this.db, input);
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }) {
		return linkEntities(this.db, input);
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }) {
		return unlinkEntities(this.db, input);
	}

	public async getDatabaseSnapshot() {
		return getDatabaseSnapshot(this.db);
	}

	public async getInitiativeBundle(initiativeId: string) {
		return getInitiativeBundle(this.db, initiativeId);
	}

	public async getSnapshotSignature(): Promise<string> {
		return computeFileStatSignature(this.db.name);
	}

	public async createHandoff(input: { entityId: string; summary?: string; body: string }) {
		return createHandoff(this.db, input);
	}

	public async updateHandoff(input: { handoffId: string; summary?: string; body?: string }) {
		return updateHandoff(this.db, input);
	}

	public async deleteHandoff(input: { handoffId: string }) {
		return deleteHandoff(this.db, input);
	}

	public async getHandoffDetails(entityId: string) {
		return getHandoffDetails(this.db, entityId);
	}

	public async listHandoffs(filter?: { initiativeId?: string; entityId?: string }) {
		return listHandoffs(this.db, filter);
	}

	public async listContexts(): Promise<ContextListResult> {
		return listContexts(this.db);
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return getContextDetails(this.db, input);
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return getContextDirectory(this.db);
	}

	public async queryContextDirectory(input?: QueryContextDirectoryInput) {
		return queryContextDirectory(this.db, input);
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string }): Promise<ContextDetails> {
		return upsertContext(this.db, input);
	}

	public async defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[] }) {
		return defineContextTerm(this.db, input);
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string }) {
		return forgetContextTerm(this.db, input);
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
	const { db, dbPath } = await ensureDatabase(inputPath, options);
	return { store: new SqliteStore(db), dbPath };
}
