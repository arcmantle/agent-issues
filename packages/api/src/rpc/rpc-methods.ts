import type { PgStore } from "../pg-store.js";

/**
 * One entry per `StorageDriver` method exposed over JSON-RPC (ADR13, ADR14).
 * The tracer bullet (ISS49) wires only `createEntity`; the remaining entity,
 * handoff, context/glossary, and tenant-administration methods are added
 * mechanically by ISS50-ISS52 following this exact shape.
 */
export type RpcMethodHandler = (store: PgStore, params: unknown) => Promise<unknown>;

export const rpcMethods: Record<string, RpcMethodHandler> = {
	createEntity: async (store, params) => store.createEntity(params as Parameters<PgStore["createEntity"]>[0])
};
