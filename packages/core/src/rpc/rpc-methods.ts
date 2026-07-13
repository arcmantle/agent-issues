import type { StorageDriver } from "../features/storage-driver/storage-driver.js";

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
	createEntity: async (store, params) => store.createEntity(params as Parameters<StorageDriver["createEntity"]>[0]),

	// Entity lifecycle (ISS50). Methods whose `StorageDriver` signature takes
	// a bare string/no argument are wrapped in a named-field params object for
	// a consistent JSON-RPC surface; methods that already take a single input
	// object are forwarded to `store` unchanged.
	getEntityDetails: async (store, params) => store.getEntityDetails((params as { entityId: string }).entityId),
	listEntities: async (store, params) => store.listEntities((params as { kind: string }).kind),
	listEntityHistory: async (store, params) => store.listEntityHistory((params as { entityId: string }).entityId),
	listAllHistoryEntries: async (store) => store.listAllHistoryEntries(),
	// Deliberately absent from `writeMethods` below: it only appends rows to
	// `history_entries`, which `getDatabaseSnapshot` never reads (ISS57) - so
	// it can never change what a `snapshot-changed` broadcast would report.
	applyHistoryEntries: async (store, params) => store.applyHistoryEntries((params as { entries: Parameters<StorageDriver["applyHistoryEntries"]>[0] }).entries),
	applyResolvedFacts: async (store, params) =>
		store.applyResolvedFacts((params as { resolvedEntries: Parameters<StorageDriver["applyResolvedFacts"]>[0] }).resolvedEntries),
	listAllRelations: async (store) => store.listAllRelations(),
	applyRelations: async (store, params) => store.applyRelations((params as { relations: Parameters<StorageDriver["applyRelations"]>[0] }).relations),
	listOrphans: async (store, params) => store.listOrphans((params as { kind?: string } | undefined)?.kind),
	listProjectAdrs: async (store) => store.listProjectAdrs(),
	updateEntityStatus: async (store, params) => store.updateEntityStatus(params as Parameters<StorageDriver["updateEntityStatus"]>[0]),
	setEntityBody: async (store, params) => store.setEntityBody(params as Parameters<StorageDriver["setEntityBody"]>[0]),
	archiveEntity: async (store, params) => store.archiveEntity(params as Parameters<StorageDriver["archiveEntity"]>[0]),
	deleteEntity: async (store, params) => store.deleteEntity(params as Parameters<StorageDriver["deleteEntity"]>[0]),
	moveEntity: async (store, params) => store.moveEntity(params as Parameters<StorageDriver["moveEntity"]>[0]),
	linkEntities: async (store, params) => store.linkEntities(params as Parameters<StorageDriver["linkEntities"]>[0]),
	unlinkEntities: async (store, params) => store.unlinkEntities(params as Parameters<StorageDriver["unlinkEntities"]>[0]),
	getDatabaseSnapshot: async (store) => store.getDatabaseSnapshot(),
	getInitiativeBundle: async (store, params) => store.getInitiativeBundle((params as { initiativeId: string }).initiativeId),
	getSnapshotSignature: async (store) => store.getSnapshotSignature(),

	// Handoffs and context/glossary (ISS51), same wrapping convention as ISS50.
	createHandoff: async (store, params) => store.createHandoff(params as Parameters<StorageDriver["createHandoff"]>[0]),
	updateHandoff: async (store, params) => store.updateHandoff(params as Parameters<StorageDriver["updateHandoff"]>[0]),
	deleteHandoff: async (store, params) => store.deleteHandoff(params as Parameters<StorageDriver["deleteHandoff"]>[0]),
	getHandoffDetails: async (store, params) => store.getHandoffDetails((params as { entityId: string }).entityId),
	listHandoffs: async (store, params) => store.listHandoffs(params as Parameters<StorageDriver["listHandoffs"]>[0]),
	listAllHandoffs: async (store) => store.listAllHandoffs(),
	applyHandoffs: async (store, params) => store.applyHandoffs((params as { handoffs: Parameters<StorageDriver["applyHandoffs"]>[0] }).handoffs),

	listContexts: async (store) => store.listContexts(),
	getContextDetails: async (store, params) => store.getContextDetails(params as Parameters<StorageDriver["getContextDetails"]>[0]),
	getContextDirectory: async (store) => store.getContextDirectory(),
	queryContextDirectory: async (store, params) => store.queryContextDirectory(params as Parameters<StorageDriver["queryContextDirectory"]>[0]),
	upsertContext: async (store, params) => store.upsertContext(params as Parameters<StorageDriver["upsertContext"]>[0]),
	defineContextTerm: async (store, params) => store.defineContextTerm(params as Parameters<StorageDriver["defineContextTerm"]>[0]),
	forgetContextTerm: async (store, params) => store.forgetContextTerm(params as Parameters<StorageDriver["forgetContextTerm"]>[0]),
	listAllContexts: async (store) => store.listAllContexts(),
	applyContexts: async (store, params) => store.applyContexts((params as { contexts: Parameters<StorageDriver["applyContexts"]>[0] }).contexts),
	listAllContextTerms: async (store) => store.listAllContextTerms(),
	applyContextTerms: async (store, params) => store.applyContextTerms((params as { terms: Parameters<StorageDriver["applyContextTerms"]>[0] }).terms),

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
	"createEntity",
	"updateEntityStatus",
	"setEntityBody",
	"archiveEntity",
	"deleteEntity",
	"moveEntity",
	"linkEntities",
	"unlinkEntities",
	"createHandoff",
	"updateHandoff",
	"deleteHandoff",
	"upsertContext",
	"defineContextTerm",
	"forgetContextTerm",
	"deleteTenant",
	"renameTenant",
	// Unlike `applyHistoryEntries` (history-only), `applyResolvedFacts` can
	// create/update `entities` rows directly, which is exactly what
	// `getDatabaseSnapshot` reads - so synchronizing does need to broadcast
	// a `snapshot-changed` event when it changes anything (ISS59).
	"applyResolvedFacts",
	// Same reasoning as `applyResolvedFacts` above: `getDatabaseSnapshot`
	// reads the `relations` table directly, so bulk-applying relations
	// (ISS60) must broadcast too.
	"applyRelations",
	// `getDatabaseSnapshot`'s per-initiative `InitiativeBundle` includes
	// `handoffs`, and its top-level `contexts` field is built straight from
	// the `contexts`/`context_terms` tables - so bulk-applying any of these
	// (ISS62) must broadcast too, same as `applyRelations` above.
	"applyHandoffs",
	"applyContexts",
	"applyContextTerms"
]);
