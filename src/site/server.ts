import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ensureDatabase, listTenants, resolveDatabasePath, resolveTenantSlug } from "../database.js";
import { getDatabaseSnapshot } from "../store.js";
import { getBuiltSiteAssetPath, getContentType } from "./assets.js";

export type LiveSiteInfo = {
	dbPath: string;
	host: string;
	port: number;
	url: string;
	openInBrowser: boolean;
	defaultTenant: string;
};

export type LiveSiteHandle = {
	info: LiveSiteInfo;
	server: Server;
	close: () => void;
};

export function startLiveSite(input: {
	dbPath?: string;
	host?: string;
	port?: number;
	openInBrowser?: boolean;
	tenant?: string;
}): LiveSiteHandle {
	const defaultTenant = resolveTenantSlug({ tenant: input.tenant });
	const dbPath = resolveDatabasePath(input.dbPath, { tenant: input.tenant });
	const host = input.host ?? "127.0.0.1";
	const port = input.port ?? 4173;
	const info: LiveSiteInfo = {
		dbPath,
		defaultTenant,
		host,
		port,
		url: `http://${host}:${port}`,
		openInBrowser: input.openInBrowser ?? false
	};
	const clients = new Set<ServerResponse>();
	let databaseSignature = getDatabaseSignature(dbPath);

	const server = createServer((request, response) => {
		handleRequest({ request, response, dbPath, clients, defaultTenant });
	});

	const interval = setInterval(() => {
		const nextSignature = getDatabaseSignature(dbPath);
		if (nextSignature === databaseSignature) {
			return;
		}

		databaseSignature = nextSignature;
		broadcast(clients, JSON.stringify({ type: "snapshot-changed", at: new Date().toISOString() }));
	}, 1000);

	server.on("close", () => {
		clearInterval(interval);
		for (const client of clients) {
			client.end();
		}
		clients.clear();
	});

	server.on("error", () => {
		clearInterval(interval);
	});

	server.listen(port, host, () => {
		if (info.openInBrowser) {
			openUrl(info.url);
		}
	});

	return {
		info,
		server,
		close: () => {
			server.close();
		}
	};
}

function handleRequest(input: {
	request: IncomingMessage;
	response: ServerResponse;
	dbPath: string;
	clients: Set<ServerResponse>;
	defaultTenant: string;
}) {
	const requestUrl = new URL(input.request.url ?? "/", "http://127.0.0.1");
	const requestedTenant = requestUrl.searchParams.get("tenant")?.trim() || input.defaultTenant;

	if (input.request.method !== "GET") {
		writeText(input.response, 405, "Method Not Allowed");
		return;
	}

	if (requestUrl.pathname === "/site-config.json") {
		writeJson(input.response, readSiteConfig(input.dbPath, input.defaultTenant));
		return;
	}

	if (requestUrl.pathname === "/api/snapshot") {
		writeJson(input.response, readSnapshot(input.dbPath, requestedTenant));
		return;
	}

	if (requestUrl.pathname === "/events") {
		input.response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive"
		});
		input.response.write("retry: 1000\n");
		input.response.write(`data: ${JSON.stringify({ type: "connected", at: new Date().toISOString() })}\n\n`);
		input.clients.add(input.response);

		input.request.on("close", () => {
			input.clients.delete(input.response);
		});
		return;
	}

	const assetPath = getBuiltSiteAssetPath(requestUrl.pathname);
	if (assetPath) {
		input.response.writeHead(200, {
			"Content-Type": getContentType(assetPath),
			"Cache-Control": assetPath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable"
		});
		input.response.end(readFileSync(assetPath));
		return;
	}

	writeText(input.response, 404, "Not Found");
}

function readSiteConfig(dbPath: string, defaultTenant: string) {
	const { db } = ensureDatabase(dbPath, { tenant: defaultTenant });
	try {
		const availableTenants = listTenants(db);
		const currentTenant = availableTenants.some((tenant) => tenant.id === defaultTenant)
			? defaultTenant
			: (availableTenants[0]?.id ?? defaultTenant);

		return {
			availableTenants,
			currentTenant,
			dbPath
		};
	} finally {
		db.close();
	}
}

function readSnapshot(dbPath: string, tenant: string) {
	const { db } = ensureDatabase(dbPath, { tenant });
	try {
		return getDatabaseSnapshot(db);
	} finally {
		db.close();
	}
}

function getDatabaseSignature(dbPath: string): string {
	return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
		.map((candidate) => {
			if (!existsSync(candidate)) {
				return `${candidate}:missing`;
			}

			const stats = statSync(candidate);
			return `${candidate}:${stats.size}:${stats.mtimeMs}`;
		})
		.join("|");
}

function broadcast(clients: Set<ServerResponse>, payload: string) {
	for (const client of clients) {
		client.write(`data: ${payload}\n\n`);
	}
}

function openUrl(url: string) {
	if (process.platform === "darwin") {
		spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		return;
	}

	if (process.platform === "win32") {
		spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
		return;
	}

	spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function writeJson(response: ServerResponse, payload: unknown) {
	response.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store"
	});
	response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeText(response: ServerResponse, statusCode: number, body: string) {
	response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
	response.end(body);
}