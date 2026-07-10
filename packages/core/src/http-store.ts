import { randomUUID } from "node:crypto";

import type {
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	ContextSyncRecord,
	ContextTermSyncRecord,
	DefineContextTermResult,
	ForgetContextTermResult,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult
} from "./context-store.js";
import type { DeleteTenantResult, RenameTenantResult, TenantSummary } from "./database.js";
import type { BodySource, EntityRecord, HistoryEntryRecord, RelationRecord } from "./domain.js";
import type { StorageDriver } from "./storage-driver.js";
import type {
	DatabaseSnapshot,
	DeleteResult,
	EntityDetails,
	HandoffDeleteResult,
	HandoffDetails,
	HandoffRecord,
	InitiativeBundle,
	LinkResult,
	MoveResult,
	StatusUpdateResult,
	UnlinkResult
} from "./store.js";

export type HttpStoreOptions = {
	/** Cloud API base URL, no trailing slash required (e.g. `https://api.example.com`). */
	baseUrl: string;
	/** Bearer token attached to every request. `HttpStore` neither resolves nor refreshes it - the caller (backend selection/CLI seam) owns that. */
	bearerToken: string;
	tenantId: string;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
};

type JsonRpcSuccessResponse = { jsonrpc: "2.0"; id: string; result: unknown };
type JsonRpcErrorResponse = { jsonrpc: "2.0"; id: string; error: { code: number; message: string } };

/**
 * The cloud-mode implementation of the storage-driver seam (ADR13, ADR14):
 * turns every `StorageDriver` operation into a single JSON-RPC call to the
 * cloud API's `/rpc` endpoint (ISS49-ISS52). A JSON-RPC error response
 * surfaces as a thrown `Error` carrying the gate's message, matching
 * `SqliteStore`/`PgStore`'s existing throw-based contract so command code
 * never branches on which backend it holds. `HttpStore` holds no persistent
 * network connection to release, but still honors the seam's close-then-reject
 * contract (`storage-driver-contract.ts`) by refusing any call made after
 * `close()`.
 */
export class HttpStore implements StorageDriver {
	public constructor(options: HttpStoreOptions) {
		this.options = options;
		this.closed = false;
	}

	protected options: HttpStoreOptions;
	protected closed: boolean;

	public get tenantId(): string {
		return this.options.tenantId;
	}

	protected async call<T>(method: string, params?: unknown): Promise<T> {
		if (this.closed) {
			throw new Error("HttpStore is closed; open a new store instead of reusing a closed one.");
		}

		const fetchImpl = this.options.fetchImpl ?? fetch;
		const response = await fetchImpl(`${this.options.baseUrl}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.options.bearerToken}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params })
		});

		if (!response.ok) {
			throw new Error(`HttpStore request to ${method} failed with HTTP ${response.status}.`);
		}

		const body = (await response.json()) as JsonRpcSuccessResponse | JsonRpcErrorResponse;
		if ("error" in body) {
			throw new Error(body.error.message);
		}

		return body.result as T;
	}

	// Entities
	public createEntity(input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		author?: string;
	}): Promise<EntityRecord> {
		return this.call("createEntity", input);
	}

	public getEntityDetails(entityId: string): Promise<EntityDetails> {
		return this.call("getEntityDetails", { entityId });
	}

	public listEntities(kind: string): Promise<EntityRecord[]> {
		return this.call("listEntities", { kind });
	}

	public listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]> {
		return this.call("listEntityHistory", { entityId });
	}

	public listAllHistoryEntries(): Promise<HistoryEntryRecord[]> {
		return this.call("listAllHistoryEntries");
	}

	public applyHistoryEntries(entries: HistoryEntryRecord[]): Promise<{ inserted: number }> {
		return this.call("applyHistoryEntries", { entries });
	}

	public applyResolvedFacts(resolvedEntries: HistoryEntryRecord[]): Promise<{ created: string[]; updated: string[] }> {
		return this.call("applyResolvedFacts", { resolvedEntries });
	}

	public listAllRelations(): Promise<RelationRecord[]> {
		return this.call("listAllRelations");
	}

	public applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }> {
		return this.call("applyRelations", { relations });
	}

	public listOrphans(kind?: string): Promise<EntityRecord[]> {
		return this.call("listOrphans", kind ? { kind } : undefined);
	}

	public listProjectAdrs(): Promise<EntityRecord[]> {
		return this.call("listProjectAdrs");
	}

	public updateEntityStatus(input: { entityId: string; status: string; author?: string }): Promise<StatusUpdateResult> {
		return this.call("updateEntityStatus", input);
	}

	public setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string }): Promise<EntityRecord> {
		return this.call("setEntityBody", input);
	}

	public archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult> {
		return this.call("archiveEntity", input);
	}

	public deleteEntity(input: { entityId: string }): Promise<DeleteResult> {
		return this.call("deleteEntity", input);
	}

	public moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult> {
		return this.call("moveEntity", input);
	}

	public linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult> {
		return this.call("linkEntities", input);
	}

	public unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult> {
		return this.call("unlinkEntities", input);
	}

	public getDatabaseSnapshot(): Promise<DatabaseSnapshot> {
		return this.call("getDatabaseSnapshot");
	}

	public getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle> {
		return this.call("getInitiativeBundle", { initiativeId });
	}

	// Handoffs
	public createHandoff(input: { entityId: string; summary?: string; body: string }): Promise<HandoffRecord> {
		return this.call("createHandoff", input);
	}

	public updateHandoff(input: { handoffId: string; summary?: string; body?: string }): Promise<HandoffRecord> {
		return this.call("updateHandoff", input);
	}

	public deleteHandoff(input: { handoffId: string }): Promise<HandoffDeleteResult> {
		return this.call("deleteHandoff", input);
	}

	public getHandoffDetails(entityId: string): Promise<HandoffDetails> {
		return this.call("getHandoffDetails", { entityId });
	}

	public listHandoffs(filter?: { initiativeId?: string; entityId?: string }): Promise<HandoffRecord[]> {
		return this.call("listHandoffs", filter);
	}

	public listAllHandoffs(): Promise<HandoffRecord[]> {
		return this.call("listAllHandoffs");
	}

	public applyHandoffs(handoffs: HandoffRecord[]): Promise<{ inserted: number }> {
		return this.call("applyHandoffs", { handoffs });
	}

	// Context / glossary
	public listContexts(): Promise<ContextListResult> {
		return this.call("listContexts");
	}

	public getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return this.call("getContextDetails", input);
	}

	public getContextDirectory(): Promise<ContextDirectory> {
		return this.call("getContextDirectory");
	}

	public queryContextDirectory(input?: QueryContextDirectoryInput): Promise<QueryContextDirectoryResult> {
		return this.call("queryContextDirectory", input);
	}

	public upsertContext(input: { scopeRef?: string; title: string; summary: string }): Promise<ContextDetails> {
		return this.call("upsertContext", input);
	}

	public defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[] }): Promise<DefineContextTermResult> {
		return this.call("defineContextTerm", input);
	}

	public forgetContextTerm(input: { scopeRef?: string; term: string }): Promise<ForgetContextTermResult> {
		return this.call("forgetContextTerm", input);
	}

	public listAllContexts(): Promise<ContextSyncRecord[]> {
		return this.call("listAllContexts");
	}

	public applyContexts(contexts: ContextSyncRecord[]): Promise<{ applied: number }> {
		return this.call("applyContexts", { contexts });
	}

	public listAllContextTerms(): Promise<ContextTermSyncRecord[]> {
		return this.call("listAllContextTerms");
	}

	public applyContextTerms(terms: ContextTermSyncRecord[]): Promise<{ applied: number }> {
		return this.call("applyContextTerms", { terms });
	}

	// Tenant administration
	public listTenants(): Promise<TenantSummary[]> {
		return this.call("listTenants");
	}

	public deleteTenant(tenantId: string): Promise<DeleteTenantResult> {
		return this.call("deleteTenant", { tenantId });
	}

	public renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult> {
		return this.call("renameTenant", { previousTenantId, newTenantId });
	}

	public async close(): Promise<void> {
		this.closed = true;
	}
}
