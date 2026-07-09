import { createServer, type Server } from "node:http";

export type { AuthIdentity, AuthProvider } from "./auth/auth-provider.js";
export { EntraIdAuthProvider, type EntraIdAuthProviderOptions } from "./auth/entra-id-auth-provider.js";
export { LocalAuthProvider, type LocalAuthProviderOptions } from "./auth/local-auth-provider.js";

/**
 * Configuration for the agent-issues cloud API host.
 *
 * This package is a deployable scaffold only. A later slice fills in the
 * JSON-RPC gate that fronts the Postgres backend (ADR13); for now the host
 * exists so the monorepo has a home for that service.
 */
export interface ApiServerOptions {
	host?: string;
	port?: number;
}

export interface ApiServerHandle {
	server: Server;
	url: string;
}

const NOT_IMPLEMENTED_MESSAGE = "The agent-issues cloud API is not implemented yet.";

export function createApiServer(options: ApiServerOptions = {}): ApiServerHandle {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 4400;

	const server = createServer((_request, response) => {
		response.writeHead(501, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ error: NOT_IMPLEMENTED_MESSAGE }));
	});

	server.listen(port, host);

	return { server, url: `http://${host}:${port}` };
}
