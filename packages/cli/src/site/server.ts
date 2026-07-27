import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request as sendRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { readBuildContentHash, resolveDatabasePath, resolveTenantSlug } from "@agent-issues/api-local";
import { getBuiltSiteAssetPath, getContentType } from "./assets.js";
import { subscribeToCloudEvents } from "./cloud-events-relay.js";
import { withStore } from "../cli/shared.js";
import type { SavedLoginStoreOptions } from "../auth-session.js";
import { openStorageDriver } from "../open-storage-driver.js";

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

export type StopLiveSiteResult = {
	host: string;
	port: number;
	url: string;
	reachable: boolean;
	stopped: boolean;
};

const LIVE_SITE_STOP_PATH = "/__agent_issues/stop";

export async function startLiveSite(input: {
	dbPath?: string;
	host?: string;
	port?: number;
	openInBrowser?: boolean;
	tenant?: string;
	currentWorkingDirectory?: string;
	/** Overrides the local-mode snapshot-signature poll interval; defaults to 1000ms. Test-only knob. */
	pollIntervalMs?: number;
	/**
	 * Overrides how `auth-session.ts` reaches the native OS credential store
	 * (ISS185, ADR46) for the remote saved-login lookup. Production
	 * never sets this - the real OS tool is used. Tests inject an
	 * in-memory fake so a remote-routed site server never shells out to the
	 * real credential store.
	 */
	credentialStoreOptions?: SavedLoginStoreOptions;
}): Promise<LiveSiteHandle> {
	const currentWorkingDirectory = input.currentWorkingDirectory;
	const credentialStoreOptions = input.credentialStoreOptions;
	const defaultTenant = resolveTenantSlug({ currentWorkingDirectory, tenant: input.tenant });
	const dbPath = resolveDatabasePath(input.dbPath, { tenant: input.tenant });
	const host = input.host ?? "127.0.0.1";
	const port = input.port ?? 4173;
	const pollIntervalMs = input.pollIntervalMs ?? 1000;
	const info: LiveSiteInfo = {
		dbPath,
		defaultTenant,
		host,
		port,
		url: `http://${host}:${port}`,
		openInBrowser: input.openInBrowser ?? false
	};
	const clients = new Set<ServerResponse>();

	// Resolved once at startup (ADR13, ADR18): decides whether live-refresh
	// polls the local file or relays the cloud API's own SSE channel (ISS56).
	// Snapshot/site-config reads re-resolve per request through `withStore`
	// instead, since a long-lived cloud session could expire mid-run.
	const opened = await openStorageDriver({
		dbPath: input.dbPath,
		databaseOptions: { currentWorkingDirectory, tenant: input.tenant },
		authSessionOptions: credentialStoreOptions,
		localDaemon: { buildHash: readBuildContentHash() }
	});
	await opened.store.close();

	if (opened.daemonFallbackWarning) {
		process.stderr.write(`Warning: ${opened.daemonFallbackWarning}\n`);
	}

	let databaseSignature =
		opened.backend === "local"
			? await readSnapshotSignature(dbPath, defaultTenant, currentWorkingDirectory, credentialStoreOptions)
			: undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let pollingStopped = false;
	let stopCloudEventsRelay: (() => void) | undefined;

	const server = createServer((request, response) => {
		void handleRequest({ request, response, dbPath, clients, currentWorkingDirectory, defaultTenant, server, credentialStoreOptions });
	});

	if (opened.backend === "local") {
		// A self-rescheduling `setTimeout` (rather than `setInterval`) so a
		// slow tick through the storage-driver seam can never overlap with
		// the next one - the next poll is only scheduled once the current
		// one's `getSnapshotSignature()` call has resolved (ISS191).
		const scheduleNextPoll = () => {
			if (pollingStopped) {
				return;
			}

			pollTimer = setTimeout(() => {
				void readSnapshotSignature(dbPath, defaultTenant, currentWorkingDirectory, credentialStoreOptions).then((nextSignature) => {
					if (nextSignature !== databaseSignature) {
						databaseSignature = nextSignature;
						broadcast(clients, JSON.stringify({ type: "snapshot-changed", at: new Date().toISOString() }));
					}

					scheduleNextPoll();
				});
			}, pollIntervalMs);
		};

		scheduleNextPoll();
	} else if (opened.cloudConnection) {
		stopCloudEventsRelay = subscribeToCloudEvents(opened.cloudConnection, (event) => {
			broadcast(clients, JSON.stringify(event));
		});
	}

	server.on("close", () => {
		pollingStopped = true;
		if (pollTimer) {
			clearTimeout(pollTimer);
		}
		stopCloudEventsRelay?.();
		for (const client of clients) {
			client.end();
		}
		clients.clear();
	});

	server.on("error", () => {
		pollingStopped = true;
		if (pollTimer) {
			clearTimeout(pollTimer);
		}
		stopCloudEventsRelay?.();
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

export async function stopLiveSite(input: { host?: string; port?: number }): Promise<StopLiveSiteResult> {
	const host = input.host ?? "127.0.0.1";
	const port = input.port ?? 4173;
	const url = `http://${host}:${port}`;

	return await new Promise<StopLiveSiteResult>((resolve, reject) => {
		let timedOut = false;
		const request = sendRequest(
			{
				host,
				method: "POST",
				path: LIVE_SITE_STOP_PATH,
				port
			},
			(response) => {
				response.resume();
				response.once("end", () => {
					resolve({
						host,
						port,
						reachable: true,
						url,
						stopped: response.statusCode === 200
					});
				});
			}
		);

		request.setTimeout(500, () => {
			timedOut = true;
			request.destroy(new Error("Timed out waiting for the live site stop response."));
		});

		request.once("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			if (timedOut) {
				resolve({ host, port, reachable: true, url, stopped: false });
				return;
			}

			if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
				resolve({ host, port, reachable: false, url, stopped: false });
				return;
			}

			reject(error);
		});

		request.end();
	});
}

async function handleRequest(input: {
	request: IncomingMessage;
	response: ServerResponse;
	dbPath: string;
	clients: Set<ServerResponse>;
	currentWorkingDirectory: string | undefined;
	defaultTenant: string;
	server: Server;
	credentialStoreOptions: SavedLoginStoreOptions | undefined;
}) {
	const requestUrl = new URL(input.request.url ?? "/", "http://127.0.0.1");
	const requestedTenant = requestUrl.searchParams.get("tenant")?.trim() || input.defaultTenant;

	if (requestUrl.pathname === LIVE_SITE_STOP_PATH) {
		if (input.request.method !== "POST") {
			writeText(input.response, 405, "Method Not Allowed");
			return;
		}

		writeText(input.response, 200, "Stopping live site");
		setImmediate(() => {
			input.server.close();
		});
		return;
	}

	if (input.request.method !== "GET") {
		writeText(input.response, 405, "Method Not Allowed");
		return;
	}

	if (requestUrl.pathname === "/site-config.json") {
		writeJson(
			input.response,
			await readSiteConfig(input.dbPath, input.defaultTenant, input.currentWorkingDirectory, input.credentialStoreOptions)
		);
		return;
	}

	if (requestUrl.pathname === "/api/snapshot") {
		writeJson(
			input.response,
			await readSnapshot(
				input.dbPath,
				requestedTenant,
				input.defaultTenant,
				input.currentWorkingDirectory,
				input.credentialStoreOptions,
				requestUrl.searchParams.get("project")?.trim() || undefined
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/projects") {
		writeJson(
			input.response,
			await readProjectDiscovery(
				input.dbPath,
				requestedTenant,
				input.defaultTenant,
				input.currentWorkingDirectory,
				input.credentialStoreOptions,
				requestUrl.searchParams.get("project")?.trim() || undefined
			)
		);
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

async function readSiteConfig(
	dbPath: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined
) {
	return withStore(
		dbPath,
		{ credentialStoreOptions, currentWorkingDirectory, tenant: defaultTenant },
		async (store, resolvedDbPath) => {
			const availableTenants = await store.listTenants();
			const currentTenant = availableTenants.some((tenant) => tenant.id === defaultTenant)
				? defaultTenant
				: (availableTenants[0]?.id ?? defaultTenant);

			return {
				availableTenants,
				currentTenant,
				dbPath: resolvedDbPath
			};
		}
	);
}

async function readSnapshot(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	projectId: string | undefined
) {
	if (!projectId) {
		return { kind: "unavailable" } as const;
	}

	if (tenant !== defaultTenant) {
		const availableTenants = await withStore(
			dbPath,
			{ credentialStoreOptions, currentWorkingDirectory, tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" } as const;
		}
	}

	return withStore(dbPath, { credentialStoreOptions, currentWorkingDirectory, tenant }, (store) => store.getDatabaseSnapshot({ projectId }));
}

async function readProjectDiscovery(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	projectId: string | undefined
) {
	if (tenant !== defaultTenant) {
		const availableTenants = await withStore(
			dbPath,
			{ credentialStoreOptions, currentWorkingDirectory, tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" } as const;
		}
	}

	return withStore(
		dbPath,
		{ credentialStoreOptions, currentWorkingDirectory, tenant },
		(store) => store.getProjectDiscovery(projectId ? { projectId } : undefined)
	);
}

async function readSnapshotSignature(
	dbPath: string,
	tenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined
) {
	return withStore(dbPath, { credentialStoreOptions, currentWorkingDirectory, tenant }, (store) => store.getSnapshotSignature());
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
	response.end(`${JSON.stringify(payload)}\n`);
}

function writeText(response: ServerResponse, statusCode: number, body: string) {
	response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
	response.end(body);
}