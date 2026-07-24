import type { StorageDriver } from "../features/storage-driver/storage-driver.js";
import { decodeCanonicalChainBundle, encodeCanonicalChainBundle, type CanonicalChainWireBundle } from "../features/synchronize/canonical-chain.js";

/**
 * One entry per `StorageDriver` method exposed over JSON-RPC (ADR13, ADR14).
 * Generic over `StorageDriver` rather than hardcoded to `PgStore` (ADR44):
 * the local daemon fronts a `SqliteStore` through this exact same dispatch
 * table. The tracer bullet (ISS49) wired only `createEntity`; the remaining
 * entity, handoff, context/glossary, and tenant-administration methods were
 * added mechanically by ISS50-ISS52 following this exact shape - every
 * handler only ever calls `StorageDriver` interface methods, so widening
 * the type is a pure type-level change.
 */
export type RpcMethodHandler = (store: StorageDriver, params: unknown) => Promise<unknown>;

export const rpcMethods: Record<string, RpcMethodHandler> = {
	exportCanonicalChains: async (store) => encodeCanonicalChainBundle(await store.exportCanonicalChains()),
	importCanonicalChains: async (store, params) => store.importCanonicalChains(decodeCanonicalChainBundle((params as { bundle: CanonicalChainWireBundle }).bundle)),
	getHistoryDiagnostics: async (store) => store.getHistoryDiagnostics(),
	createEntity: async (store, params) => store.createEntity(params as Parameters<StorageDriver["createEntity"]>[0]),

	// Entity lifecycle (ISS50). Methods whose `StorageDriver` signature takes
	// a bare string/no argument are wrapped in a named-field params object for
	// a consistent JSON-RPC surface; methods that already take a single input
	// object are forwarded to `store` unchanged.
	getEntityDetails: async (store, params) => store.getEntityDetails((params as { entityId: string }).entityId),
	queryEntityRelations: async (store, params) => store.queryEntityRelations(params as Parameters<StorageDriver["queryEntityRelations"]>[0]),
	listEntities: async (store, params) => store.listEntities((params as { kind: string }).kind),
	queryEntities: async (store, params) => store.queryEntities(params as Parameters<StorageDriver["queryEntities"]>[0]),
	listEntityHistory: async (store, params) => store.listEntityHistory((params as { entityId: string }).entityId),
	listAllRelations: async (store) => store.listAllRelations(),
	applyRelations: async (store, params) => store.applyRelations((params as { relations: Parameters<StorageDriver["applyRelations"]>[0] }).relations),
	listOrphans: async (store, params) => store.listOrphans((params as { kind?: string } | undefined)?.kind),
	listProjectAdrs: async (store) => store.listProjectAdrs(),
	updateEntityStatus: async (store, params) => store.updateEntityStatus(params as Parameters<StorageDriver["updateEntityStatus"]>[0]),
	updateEntity: async (store, params) => store.updateEntity(params as Parameters<StorageDriver["updateEntity"]>[0]),
	setEntityBody: async (store, params) => store.setEntityBody(params as Parameters<StorageDriver["setEntityBody"]>[0]),
	materializeEntityRevision: async (store, params) => store.materializeEntityRevision(params as Parameters<StorageDriver["materializeEntityRevision"]>[0]),
	restoreEntityRevision: async (store, params) => store.restoreEntityRevision(params as Parameters<StorageDriver["restoreEntityRevision"]>[0]),
	archiveEntity: async (store, params) => store.archiveEntity(params as Parameters<StorageDriver["archiveEntity"]>[0]),
	deleteEntity: async (store, params) => store.deleteEntity(params as Parameters<StorageDriver["deleteEntity"]>[0]),
	moveEntity: async (store, params) => store.moveEntity(params as Parameters<StorageDriver["moveEntity"]>[0]),
	linkEntities: async (store, params) => store.linkEntities(params as Parameters<StorageDriver["linkEntities"]>[0]),
	unlinkEntities: async (store, params) => store.unlinkEntities(params as Parameters<StorageDriver["unlinkEntities"]>[0]),
	getDatabaseSnapshot: async (store, params) => store.getDatabaseSnapshot(params as Parameters<StorageDriver["getDatabaseSnapshot"]>[0]),
	getProjectDiscovery: async (store, params) => store.getProjectDiscovery(params as Parameters<StorageDriver["getProjectDiscovery"]>[0]),
	getInitiativeBundle: async (store, params) => store.getInitiativeBundle((params as { initiativeId: string }).initiativeId),
	getSnapshotSignature: async (store) => store.getSnapshotSignature(),

	listContexts: async (store) => store.listContexts(),
	getContextDetails: async (store, params) => store.getContextDetails(params as Parameters<StorageDriver["getContextDetails"]>[0]),
	getContextDirectory: async (store) => store.getContextDirectory(),
	queryContextDirectory: async (store, params) => store.queryContextDirectory(params as Parameters<StorageDriver["queryContextDirectory"]>[0]),
	upsertContext: async (store, params) => store.upsertContext(params as Parameters<StorageDriver["upsertContext"]>[0]),
	defineContextTerm: async (store, params) => store.defineContextTerm(params as Parameters<StorageDriver["defineContextTerm"]>[0]),
	forgetContextTerm: async (store, params) => store.forgetContextTerm(params as Parameters<StorageDriver["forgetContextTerm"]>[0]),
	materializeContextRevision: async (store, params) => store.materializeContextRevision(params as Parameters<StorageDriver["materializeContextRevision"]>[0]),
	materializeContextTermRevision: async (store, params) => store.materializeContextTermRevision(params as Parameters<StorageDriver["materializeContextTermRevision"]>[0]),
	restoreContextRevision: async (store, params) => store.restoreContextRevision(params as Parameters<StorageDriver["restoreContextRevision"]>[0]),
	restoreContextTermRevision: async (store, params) => store.restoreContextTermRevision(params as Parameters<StorageDriver["restoreContextTermRevision"]>[0]),

	// Tenant administration (ISS52). `PgStore`'s guard against acting on any
	// tenant other than the auth-seam-resolved one (ISS46's requireOwnTenant)
	// is enforced inside these methods themselves; the gate adds no
	// additional authorization surface.
	listTenants: async (store) => store.listTenants(),
	deleteTenant: async (store, params) => store.deleteTenant((params as { tenantId: string }).tenantId),
	renameTenant: async (store, params) => {
		const { previousTenantId, newTenantId } = params as { previousTenantId: string; newTenantId: string };
		return store.renameTenant(previousTenantId, newTenantId);
	}
};

/**
 * JSON-RPC methods that mutate `PgStore` data (ISS48, ADR13). Only a
 * successful call to one of these triggers a `snapshot-changed` broadcast on
 * the gate's SSE change-event channel; read-only methods never do.
 */
export const writeMethods = new Set<string>([
	"importCanonicalChains",
	"createEntity",
	"updateEntityStatus",
	"updateEntity",
	"setEntityBody",
	"restoreEntityRevision",
	"archiveEntity",
	"deleteEntity",
	"moveEntity",
	"linkEntities",
	"unlinkEntities",
	"upsertContext",
	"defineContextTerm",
	"forgetContextTerm",
	"restoreContextRevision",
	"restoreContextTermRevision",
	"deleteTenant",
	"renameTenant",
	"applyRelations"
]);
