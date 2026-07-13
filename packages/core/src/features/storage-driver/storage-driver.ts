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
} from "../context/context-store.js";
import type { DeleteTenantResult, RenameTenantResult, TenantSummary } from "../entity-store/database.js";
import type { BodySource, EntityRecord, HistoryEntryRecord, RelationRecord } from "../entity-store/domain.js";
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
} from "../entity-store/store.js";

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
	/**
	 * A cheap, opaque string that changes whenever this tenant's own data
	 * changes and stays stable otherwise (ISS191) - the site server's
	 * local-mode live-refresh polls this instead of directly `stat()`-ing
	 * the sqlite file, so local mode never bypasses this seam the way cloud
	 * mode (which already only ever talks through `StorageDriver`) doesn't.
	 * Callers must never parse or compare its internal shape - only
	 * equality across two calls is meaningful.
	 */
	getSnapshotSignature(): Promise<string>;

	// Handoffs
	createHandoff(input: { entityId: string; summary?: string; body: string }): Promise<HandoffRecord>;
	updateHandoff(input: { handoffId: string; summary?: string; body?: string }): Promise<HandoffRecord>;
	deleteHandoff(input: { handoffId: string }): Promise<HandoffDeleteResult>;
	getHandoffDetails(entityId: string): Promise<HandoffDetails>;
	listHandoffs(filter?: { initiativeId?: string; entityId?: string }): Promise<HandoffRecord[]>;
	/** All handoffs, unfiltered (ISS62/ADR16) - the read half of synchronize's handoff sync. */
	listAllHandoffs(): Promise<HandoffRecord[]>;
	applyHandoffs(handoffs: HandoffRecord[]): Promise<{ inserted: number }>;

	// Context / glossary
	listContexts(): Promise<ContextListResult>;
	getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails>;
	getContextDirectory(): Promise<ContextDirectory>;
	queryContextDirectory(input?: QueryContextDirectoryInput): Promise<QueryContextDirectoryResult>;
	upsertContext(input: { scopeRef?: string; title: string; summary: string }): Promise<ContextDetails>;
	defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[] }): Promise<DefineContextTermResult>;
	forgetContextTerm(input: { scopeRef?: string; term: string }): Promise<ForgetContextTermResult>;
	/** All contexts/terms, unfiltered (ISS62/ADR16) - the read/write halves of synchronize's context sync. */
	listAllContexts(): Promise<ContextSyncRecord[]>;
	applyContexts(contexts: ContextSyncRecord[]): Promise<{ applied: number }>;
	listAllContextTerms(): Promise<ContextTermSyncRecord[]>;
	applyContextTerms(terms: ContextTermSyncRecord[]): Promise<{ applied: number }>;

	// Tenant administration
	listTenants(): Promise<TenantSummary[]>;
	deleteTenant(tenantId: string): Promise<DeleteTenantResult>;
	renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult>;
	// Legacy per-folder tenant consolidation (ISS63) is no longer part of
	// this seam: it only ever ran as a one-time migration step, and the
	// automatic per-open sweep (ISS178/ISS181, database.ts's
	// buildConsolidateLegacyTenantsBackfillMigration) now folds in every
	// outstanding legacy tenant on its own - there is no longer a manual
	// path that needs a `StorageDriver` method to call through.

	close(): Promise<void>;
}
