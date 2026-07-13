import { createServer, type Server } from "node:http";

import type { Pool } from "pg";

import type { AuthProvider } from "./auth/auth-provider.js";
import { PgStore } from "./pg-store.js";
import { createJsonRpcApp } from "./rpc/create-json-rpc-app.js";

export type { AuthIdentity, AuthProvider } from "./auth/auth-provider.js";
export { EntraIdAuthProvider, type EntraIdAuthProviderOptions } from "./auth/entra-id-auth-provider.js";
export { LocalAuthProvider, type LocalAuthProviderOptions } from "./auth/local-auth-provider.js";
export { createJsonRpcApp, type CreateJsonRpcAppOptions } from "./rpc/create-json-rpc-app.js";

/**
 * Configuration for the agent-issues cloud API host: the single Postgres
 * gate (ADR13). `pool` and `authProvider` are required with no defaults, so
 * the gate can never silently start without both real Postgres access and a
 * real auth seam (ADR12).
 */
export interface ApiServerOptions {
	host?: string;
	port?: number;
	pool: Pool;
	authProvider: AuthProvider;
}

export interface ApiServerHandle {
	server: Server;
	url: string;
}

export function createApiServer(options: ApiServerOptions): ApiServerHandle {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 4400;

	const app = createJsonRpcApp({
		authProvider: options.authProvider,
		createStore: (identity, projectIdentity) => new PgStore(options.pool, identity.tenantId, projectIdentity)
	});
	const server = createServer(app);

	server.listen(port, host);

	return { server, url: `http://${host}:${port}` };
}

