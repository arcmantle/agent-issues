import express, { type Express, type Request } from "express";
import type { Pool } from "pg";

import type { AuthIdentity, AuthProvider } from "../auth/auth-provider.js";
import { PgStore } from "../pg-store.js";
import { ChangeEventBroadcaster } from "./change-events.js";
import { isJsonRpcRequest, JSON_RPC_ERROR_CODES, type JsonRpcErrorResponse, type JsonRpcSuccessResponse } from "./json-rpc.js";
import { rpcMethods, writeMethods } from "./rpc-methods.js";

export type CreateJsonRpcAppOptions = {
	pool: Pool;
	authProvider: AuthProvider;
};

type AuthResult = { identity: AuthIdentity } | { errorStatus: number; errorBody: { error: string } };

/**
 * Shared by both the JSON-RPC dispatch route and the SSE change-event route:
 * a missing/invalid bearer token is rejected the same way, before either
 * route does anything tenant-scoped.
 */
async function resolveIdentity(request: Request, authProvider: AuthProvider): Promise<AuthResult> {
	const authHeader = request.header("authorization");
	if (!authHeader) {
		return { errorStatus: 401, errorBody: { error: "Missing Authorization header." } };
	}

	try {
		const identity = await authProvider.validateToken(authHeader);
		return { identity };
	} catch {
		return { errorStatus: 401, errorBody: { error: "Invalid or expired bearer token." } };
	}
}

/**
 * The single Postgres gate's JSON-RPC surface (ADR13, ADR14): auth seam ->
 * tenant resolution -> method dispatch -> `PgStore` (which itself opens the
 * one `withTenantTransaction` per ADR9). Per-request tenant scoping always
 * comes from the validated bearer token, never from the request body, so a
 * caller cannot widen its own access by passing a different tenantId in
 * `params` - `PgStore` is constructed with `identity.tenantId` and RLS
 * (ADR9) backstops it even if a handler carelessly forwarded such a field.
 *
 * The gate also owns the change-notification channel (ADR13): `/events` is
 * an SSE stream, scoped per tenant, that the site's live-refresh consumes in
 * cloud mode the same way it already consumes the local file-watch-driven
 * `/events` stream. `writeMethods` (`rpc-methods.js`) marks which JSON-RPC
 * methods are writes; only those trigger a broadcast after they succeed.
 */
export function createJsonRpcApp(options: CreateJsonRpcAppOptions): Express {
	const { pool, authProvider } = options;
	const app = express();
	app.use(express.json());
	const changeEvents = new ChangeEventBroadcaster();

	app.get("/events", async (request, response) => {
		const auth = await resolveIdentity(request, authProvider);
		if ("errorStatus" in auth) {
			response.status(auth.errorStatus).json(auth.errorBody);
			return;
		}

		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive"
		});
		response.write("retry: 1000\n");
		response.write(`data: ${JSON.stringify({ type: "connected", at: new Date().toISOString() })}\n\n`);

		const unsubscribe = changeEvents.subscribe(auth.identity.tenantId, response);
		request.on("close", unsubscribe);
	});

	app.post("/rpc", async (request, response) => {
		const auth = await resolveIdentity(request, authProvider);
		if ("errorStatus" in auth) {
			response.status(auth.errorStatus).json(auth.errorBody);
			return;
		}

		const identity = auth.identity;
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
			if (writeMethods.has(rpcRequest.method)) {
				changeEvents.publishSnapshotChanged(identity.tenantId);
			}
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

