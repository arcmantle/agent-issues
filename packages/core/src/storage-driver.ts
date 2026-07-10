import type {
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	DefineContextTermResult,
	ForgetContextTermResult,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult
} from "./context-store.js";
import type { DeleteTenantResult, RenameTenantResult, TenantSummary } from "./database.js";
import type { BodySource, EntityRecord, HistoryEntryRecord, RelationRecord } from "./domain.js";
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

/**
 * The engine-agnostic boundary the domain layer talks to (ADR11, ADR13):
 * SQLite (`SqliteStore`) implements it today, an HTTP-backed cloud client
 * implements it later, and callers never branch on which one they hold.
 * Every operation is async because the cloud path is inherently async.
 */
export interface StorageDriver {
	readonly tenantId: string;

	// Entities
	createEntity(input: { kind: string; title: string; parentId?: string; status?: string; body?: string; author?: string }): Promise<EntityRecord>;
	getEntityDetails(entityId: string): Promise<EntityDetails>;
	listEntities(kind: string): Promise<EntityRecord[]>;
	listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]>;
	listAllHistoryEntries(): Promise<HistoryEntryRecord[]>;
	applyHistoryEntries(entries: HistoryEntryRecord[]): Promise<{ inserted: number }>;
	applyResolvedFacts(resolvedEntries: HistoryEntryRecord[]): Promise<{ created: string[]; updated: string[] }>;
	/** Non-structural relations only (ISS60/ADR16) - structural relations are reconstructed from `applyResolvedFacts`'s `parentId` handling. */
	listAllRelations(): Promise<RelationRecord[]>;
	applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }>;
	listOrphans(kind?: string): Promise<EntityRecord[]>;
	listProjectAdrs(): Promise<EntityRecord[]>;
	updateEntityStatus(input: { entityId: string; status: string; author?: string }): Promise<StatusUpdateResult>;
	setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string }): Promise<EntityRecord>;
	archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult>;
	deleteEntity(input: { entityId: string }): Promise<DeleteResult>;
	moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult>;
	linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult>;
	unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult>;
	getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle>;

	// Handoffs
	createHandoff(input: { entityId: string; summary?: string; body: string }): Promise<HandoffRecord>;
	updateHandoff(input: { handoffId: string; summary?: string; body?: string }): Promise<HandoffRecord>;
	deleteHandoff(input: { handoffId: string }): Promise<HandoffDeleteResult>;
	getHandoffDetails(entityId: string): Promise<HandoffDetails>;
	listHandoffs(filter?: { initiativeId?: string; entityId?: string }): Promise<HandoffRecord[]>;

	// Context / glossary
	listContexts(): Promise<ContextListResult>;
	getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails>;
	getContextDirectory(): Promise<ContextDirectory>;
	queryContextDirectory(input?: QueryContextDirectoryInput): Promise<QueryContextDirectoryResult>;
	upsertContext(input: { scopeRef?: string; title: string; summary: string }): Promise<ContextDetails>;
	defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[] }): Promise<DefineContextTermResult>;
	forgetContextTerm(input: { scopeRef?: string; term: string }): Promise<ForgetContextTermResult>;

	// Tenant administration
	listTenants(): Promise<TenantSummary[]>;
	deleteTenant(tenantId: string): Promise<DeleteTenantResult>;
	renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult>;

	close(): Promise<void>;
}
