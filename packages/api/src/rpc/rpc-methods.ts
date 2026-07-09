import type { PgStore } from "../pg-store.js";

/**
 * One entry per `StorageDriver` method exposed over JSON-RPC (ADR13, ADR14).
 * The tracer bullet (ISS49) wires only `createEntity`; the remaining entity,
 * handoff, context/glossary, and tenant-administration methods are added
 * mechanically by ISS50-ISS52 following this exact shape.
 */
export type RpcMethodHandler = (store: PgStore, params: unknown) => Promise<unknown>;

export const rpcMethods: Record<string, RpcMethodHandler> = {
	createEntity: async (store, params) => store.createEntity(params as Parameters<PgStore["createEntity"]>[0]),

	// Entity lifecycle (ISS50). Methods whose `StorageDriver` signature takes
	// a bare string/no argument are wrapped in a named-field params object for
	// a consistent JSON-RPC surface; methods that already take a single input
	// object are forwarded to `PgStore` unchanged.
	getEntityDetails: async (store, params) => store.getEntityDetails((params as { entityId: string }).entityId),
	listEntities: async (store, params) => store.listEntities((params as { kind: string }).kind),
	listEntityHistory: async (store, params) => store.listEntityHistory((params as { entityId: string }).entityId),
	listOrphans: async (store, params) => store.listOrphans((params as { kind?: string } | undefined)?.kind),
	listProjectAdrs: async (store) => store.listProjectAdrs(),
	updateEntityStatus: async (store, params) => store.updateEntityStatus(params as Parameters<PgStore["updateEntityStatus"]>[0]),
	setEntityBody: async (store, params) => store.setEntityBody(params as Parameters<PgStore["setEntityBody"]>[0]),
	archiveEntity: async (store, params) => store.archiveEntity(params as Parameters<PgStore["archiveEntity"]>[0]),
	deleteEntity: async (store, params) => store.deleteEntity(params as Parameters<PgStore["deleteEntity"]>[0]),
	moveEntity: async (store, params) => store.moveEntity(params as Parameters<PgStore["moveEntity"]>[0]),
	linkEntities: async (store, params) => store.linkEntities(params as Parameters<PgStore["linkEntities"]>[0]),
	unlinkEntities: async (store, params) => store.unlinkEntities(params as Parameters<PgStore["unlinkEntities"]>[0]),
	getDatabaseSnapshot: async (store) => store.getDatabaseSnapshot(),
	getInitiativeBundle: async (store, params) => store.getInitiativeBundle((params as { initiativeId: string }).initiativeId),

	// Handoffs and context/glossary (ISS51), same wrapping convention as ISS50.
	createHandoff: async (store, params) => store.createHandoff(params as Parameters<PgStore["createHandoff"]>[0]),
	updateHandoff: async (store, params) => store.updateHandoff(params as Parameters<PgStore["updateHandoff"]>[0]),
	deleteHandoff: async (store, params) => store.deleteHandoff(params as Parameters<PgStore["deleteHandoff"]>[0]),
	getHandoffDetails: async (store, params) => store.getHandoffDetails((params as { entityId: string }).entityId),
	listHandoffs: async (store, params) => store.listHandoffs(params as Parameters<PgStore["listHandoffs"]>[0]),

	listContexts: async (store) => store.listContexts(),
	getContextDetails: async (store, params) => store.getContextDetails(params as Parameters<PgStore["getContextDetails"]>[0]),
	getContextDirectory: async (store) => store.getContextDirectory(),
	queryContextDirectory: async (store, params) => store.queryContextDirectory(params as Parameters<PgStore["queryContextDirectory"]>[0]),
	upsertContext: async (store, params) => store.upsertContext(params as Parameters<PgStore["upsertContext"]>[0]),
	defineContextTerm: async (store, params) => store.defineContextTerm(params as Parameters<PgStore["defineContextTerm"]>[0]),
	forgetContextTerm: async (store, params) => store.forgetContextTerm(params as Parameters<PgStore["forgetContextTerm"]>[0]),

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
	"renameTenant"
]);
