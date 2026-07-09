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
	getInitiativeBundle: async (store, params) => store.getInitiativeBundle((params as { initiativeId: string }).initiativeId)
};
