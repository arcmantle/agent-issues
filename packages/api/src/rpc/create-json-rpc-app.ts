import express, { type Express } from "express";
import type { Pool } from "pg";

import type { AuthProvider } from "../auth/auth-provider.js";
import { PgStore } from "../pg-store.js";
import { isJsonRpcRequest, JSON_RPC_ERROR_CODES, type JsonRpcErrorResponse, type JsonRpcSuccessResponse } from "./json-rpc.js";
import { rpcMethods } from "./rpc-methods.js";

export type CreateJsonRpcAppOptions = {
	pool: Pool;
	authProvider: AuthProvider;
};

/**
 * The single Postgres gate's JSON-RPC surface (ADR13, ADR14): auth seam ->
 * tenant resolution -> method dispatch -> `PgStore` (which itself opens the
 * one `withTenantTransaction` per ADR9). Per-request tenant scoping always
 * comes from the validated bearer token, never from the request body, so a
 * caller cannot widen its own access by passing a different tenantId in
 * `params` - `PgStore` is constructed with `identity.tenantId` and RLS
 * (ADR9) backstops it even if a handler carelessly forwarded such a field.
 */
export function createJsonRpcApp(options: CreateJsonRpcAppOptions): Express {
	const { pool, authProvider } = options;
	const app = express();
	app.use(express.json());

	app.post("/rpc", async (request, response) => {
		const authHeader = request.header("authorization");
		if (!authHeader) {
			response.status(401).json({ error: "Missing Authorization header." });
			return;
		}

		let identity;
		try {
			identity = await authProvider.validateToken(authHeader);
		} catch {
			response.status(401).json({ error: "Invalid or expired bearer token." });
			return;
		}

		const rpcRequest = request.body;
		if (!isJsonRpcRequest(rpcRequest)) {
			response.status(400).json({ error: "Malformed JSON-RPC request: expected { jsonrpc: \"2.0\", method, id }." });
			return;
		}

		const handler = rpcMethods[rpcRequest.method];
		if (!handler) {
			const errorResponse: JsonRpcErrorResponse = {
				jsonrpc: "2.0",
				id: rpcRequest.id,
				error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${rpcRequest.method}` }
			};
			response.status(200).json(errorResponse);
			return;
		}

		const store = new PgStore(pool, identity.tenantId);
		try {
			const result = await handler(store, rpcRequest.params);
			const successResponse: JsonRpcSuccessResponse = { jsonrpc: "2.0", id: rpcRequest.id, result };
			response.status(200).json(successResponse);
		} catch (error) {
			const errorResponse: JsonRpcErrorResponse = {
				jsonrpc: "2.0",
				id: rpcRequest.id,
				error: { code: JSON_RPC_ERROR_CODES.serverError, message: error instanceof Error ? error.message : "Internal error." }
			};
			response.status(200).json(errorResponse);
		}
	});

	return app;
}
