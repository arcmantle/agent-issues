import type {
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	DefineContextTermResult,
	ForgetContextTermResult,
	MaterializedContextRevision,
	MaterializedContextTermRevision,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult
} from "../context/context-types.js";
import type { DeleteTenantResult, RenameTenantResult, TenantSummary } from "../entity-store/tenant-types.js";
import type { BodySource, EntityRecord, HistoryEntryRecord, RelationRecord, MaterializedEntityRevision } from "../entity-store/domain.js";
import type {
	DatabaseSnapshot,
	DeleteResult,
	EntityDetails,
	InitiativeBundle,
	LinkResult,
	MoveResult,
	ProjectDiscovery,
	ProjectSnapshot,
	QueryEntitiesInput,
	QueryEntitiesResult,
	QueryEntityRelationsInput,
	StatusUpdateResult,
	UnlinkResult
} from "../entity-store/store-types.js";
import type { CanonicalChainBundle, CanonicalChainImportResult } from "../synchronize/canonical-chain.js";
import type { HistoryDiagnostics } from "./history-diagnostics.js";

/**
 * The engine-agnostic boundary the domain layer talks to (ADR11, ADR13):
 * SQLite (`SqliteStore`) implements it today, an HTTP-backed cloud client
 * implements it later, and callers never branch on which one they hold.
 * Every operation is async because the cloud path is inherently async.
 */
export interface StorageDriver {
	readonly tenantId: string;
	exportCanonicalChains(): Promise<CanonicalChainBundle>;
	importCanonicalChains(bundle: CanonicalChainBundle): Promise<CanonicalChainImportResult>;
	getHistoryDiagnostics(): Promise<HistoryDiagnostics>;

	// Entities
	createEntity(input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		author?: string;
		links?: Array<{ relationType: string; targetId: string }>;
	}): Promise<EntityRecord>;
	getEntityDetails(entityId: string): Promise<EntityDetails>;
	queryEntityRelations(input: QueryEntityRelationsInput): Promise<EntityDetails>;
	listEntities(kind: string): Promise<EntityRecord[]>;
	queryEntities(input: QueryEntitiesInput): Promise<QueryEntitiesResult>;
	listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]>;
	/** Non-structural relations transferred after canonical entity import. */
	listAllRelations(): Promise<RelationRecord[]>;
	applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }>;
	listOrphans(kind?: string): Promise<EntityRecord[]>;
	listProjectAdrs(): Promise<EntityRecord[]>;
	updateEntityStatus(input: { entityId: string; status: string; author?: string }): Promise<StatusUpdateResult>;
	updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord>;
	setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord>;
	/** Materializes entity facts at a specific historical revision by walking the reverse-delta chain (ADR55/ISS261). */
	materializeEntityRevision(input: { entityId: string; revision: number }): Promise<MaterializedEntityRevision>;
	restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedEntityRevision>;
	archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult>;
	deleteEntity(input: { entityId: string }): Promise<DeleteResult>;
	moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult>;
	linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult>;
	unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult>;
	getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	getProjectDiscovery(input?: { projectId?: string }): Promise<ProjectDiscovery>;
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

	// Context / glossary
	listContexts(): Promise<ContextListResult>;
	getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails>;
	getContextDirectory(): Promise<ContextDirectory>;
	queryContextDirectory(input?: QueryContextDirectoryInput): Promise<QueryContextDirectoryResult>;
	upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ContextDetails>;
	defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<DefineContextTermResult>;
	forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ForgetContextTermResult>;
	materializeContextRevision(input: { scopeRef?: string; revision: number }): Promise<MaterializedContextRevision>;
	materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }): Promise<MaterializedContextTermRevision>;
	restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedContextRevision>;
	restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedContextTermRevision>;

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
