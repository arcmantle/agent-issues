import { readFileSync } from "node:fs";
import { createServer, request as sendRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { readBuildContentHash, resolveDatabasePath, resolveTenantSlug } from "@agent-issues/api-local";
import { ENTITY_KINDS, mergeProjectChangeEventDetails, projectChangeEventForWrite, rpcMethods, writeMethods, type InitiativeTab, type ProjectChangeEvent, type SearchRequest, type SearchSourceType, type StorageDriver } from "@agent-issues/core";
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
const INITIATIVE_TABS: InitiativeTab[] = ["overview", "issues", "plans", "prds", "adrs", "context", "userStories", "debt", "graph"];
const PROJECT_MUTATION_METHODS = new Set([
	"applyRelations",
	"archiveEntity",
	"createEntity",
	"createIssueComment",
	"createPlanEntry",
	"defineContextTerm",
	"deleteEntity",
	"deleteIssueComment",
	"deletePlanEntry",
	"forgetContextTerm",
	"linkEntities",
	"linkPlanEntryIssue",
	"moveEntity",
	"restoreContextRevision",
	"restoreContextTermRevision",
	"restoreEntityRevision",
	"setEntityBody",
	"unlinkEntities",
	"unlinkPlanEntryIssue",
	"updateEntity",
	"updateEntityStatus",
	"updateIssueComment",
	"updatePlanEntry",
	"upsertContext"
]);

function isInitiativeTab(value: string | null): value is InitiativeTab {
	return typeof value === "string" && INITIATIVE_TABS.includes(value as InitiativeTab);
}

export async function startLiveSite(input: {
	dbPath?: string;
	host?: string;
	port?: number;
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
		url: `http://${host}:${port}`
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

	let databaseSignature =
		opened.backend === "local"
			? await readSnapshotSignature(dbPath, defaultTenant, currentWorkingDirectory, credentialStoreOptions)
			: undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let pollingStopped = false;
	let stopCloudEventsRelay: (() => void) | undefined;
	let stopServer: () => void;

	const server = createServer((request, response) => {
		void handleRequest({
			request,
			response,
			dbPath,
			clients,
			currentWorkingDirectory,
			defaultTenant,
			credentialStoreOptions,
			stopServer,
			onLocalMutation: (event, signature) => {
				databaseSignature = signature;
				broadcast(clients, JSON.stringify(event));
			}
		}).catch((error) => {
			process.stderr.write(`Live site request failed: ${error instanceof Error ? error.message : String(error)}\n`);
			if (response.writableEnded) {
				return;
			}
			if (response.headersSent) {
				response.end();
				return;
			}
			writeText(response, 500, "Internal Server Error");
		});
	});
	const stopBackgroundWork = () => {
		pollingStopped = true;
		if (pollTimer) {
			clearTimeout(pollTimer);
		}
		stopCloudEventsRelay?.();
	};
	const closeClients = () => {
		for (const client of clients) {
			client.end();
		}
		clients.clear();
	};
	stopServer = () => {
		stopBackgroundWork();
		closeClients();
		server.close();
	};

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
				void readSnapshotSignature(dbPath, defaultTenant, currentWorkingDirectory, credentialStoreOptions)
					.then((nextSignature) => {
						if (nextSignature !== databaseSignature) {
							databaseSignature = nextSignature;
							broadcast(clients, JSON.stringify({ type: "snapshot-changed", at: new Date().toISOString(), category: "unknown" }));
						}
					})
					.catch((error) => {
						process.stderr.write(`Live site change poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
					})
					.finally(scheduleNextPoll);
			}, pollIntervalMs);
		};

		scheduleNextPoll();
	} else if (opened.cloudConnection) {
		stopCloudEventsRelay = subscribeToCloudEvents(opened.cloudConnection, (event) => {
			broadcast(clients, JSON.stringify(event));
		});
	}

	server.on("close", () => {
		stopBackgroundWork();
		closeClients();
	});

	server.on("error", () => {
		stopBackgroundWork();
		closeClients();
	});

	server.listen(port, host);

	return {
		info,
		server,
		close: stopServer
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
	credentialStoreOptions: SavedLoginStoreOptions | undefined;
	stopServer: () => void;
	onLocalMutation: (event: ProjectChangeEvent, signature: string) => void;
}) {
	const requestUrl = new URL(input.request.url ?? "/", "http://127.0.0.1");
	const requestedTenant = requestUrl.searchParams.get("tenant")?.trim() || input.defaultTenant;
	const requestedProjectIdentity = requestUrl.searchParams.get("project")?.trim() || undefined;

	if (requestUrl.pathname === LIVE_SITE_STOP_PATH) {
		if (input.request.method !== "POST") {
			writeText(input.response, 405, "Method Not Allowed");
			return;
		}

		writeText(input.response, 200, "Stopping live site");
		setImmediate(() => {
			input.stopServer();
		});
		return;
	}

	if (requestUrl.pathname === "/api/project-mutation") {
		if (input.request.method !== "POST") {
			writeText(input.response, 405, "Method Not Allowed");
			return;
		}

		let mutation: ProjectMutationRequest;
		try {
			mutation = await readProjectMutationRequest(input.request);
		} catch (error) {
			writeText(input.response, 400, error instanceof Error ? error.message : "Invalid project mutation request.");
			return;
		}

		try {
			writeJson(input.response, await executeProjectMutation({
				credentialStoreOptions: input.credentialStoreOptions,
				currentWorkingDirectory: input.currentWorkingDirectory,
				dbPath: input.dbPath,
				mutation,
				onLocalMutation: input.onLocalMutation,
				projectId: requestedProjectIdentity,
				tenant: requestedTenant
			}));
		} catch (error) {
			writeText(input.response, 500, error instanceof Error ? error.message : "Project mutation failed.");
		}
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
				requestedProjectIdentity
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/project-summary") {
		const startedAt = performance.now();
		const projectSummary = await readProjectSummary(
			input.dbPath,
			requestedTenant,
			input.defaultTenant,
			input.currentWorkingDirectory,
			input.credentialStoreOptions,
			requestedProjectIdentity
		);
		writeJson(
			input.response,
			projectSummary,
			{ durationMs: performance.now() - startedAt, metricName: "project-summary" }
		);
		return;
	}

	if (requestUrl.pathname === "/api/entity-detail") {
		const entityId = requestUrl.searchParams.get("entity")?.trim();
		if (!entityId) {
			writeText(input.response, 400, "Invalid entity detail request.");
			return;
		}

		writeJson(
			input.response,
			await readEntityDetails(
				input.dbPath,
				requestedTenant,
				input.defaultTenant,
				input.currentWorkingDirectory,
				input.credentialStoreOptions,
				entityId,
				requestedProjectIdentity
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/entity-relations") {
		const entityId = requestUrl.searchParams.get("entity")?.trim();
		if (!entityId) {
			writeText(input.response, 400, "Invalid entity relations request.");
			return;
		}

		writeJson(input.response, await readEntityRelations(input.dbPath, requestedTenant, input.defaultTenant, input.currentWorkingDirectory, input.credentialStoreOptions, entityId, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/issue-comments") {
		const issueId = requestUrl.searchParams.get("issue")?.trim();
		if (!issueId) {
			writeText(input.response, 400, "Invalid issue comments request.");
			return;
		}

		const before = requestUrl.searchParams.get("before")?.trim();
		const all = requestUrl.searchParams.get("all") === "true";
		writeJson(input.response, await readIssueComments(input.dbPath, requestedTenant, input.defaultTenant, input.currentWorkingDirectory, input.credentialStoreOptions, requestedProjectIdentity, { issueId, ...(before ? { before } : {}), ...(all ? { all } : {}) }));
		return;
	}

	if (requestUrl.pathname === "/api/plan-entries") {
		const planId = requestUrl.searchParams.get("plan")?.trim();
		if (!planId) {
			writeText(input.response, 400, "Invalid Plan entries request.");
			return;
		}

		const before = requestUrl.searchParams.get("before")?.trim();
		const all = requestUrl.searchParams.get("all") === "true";
		writeJson(input.response, await readPlanEntryPage(input.dbPath, requestedTenant, input.defaultTenant, input.currentWorkingDirectory, input.credentialStoreOptions, requestedProjectIdentity, { planId, ...(before ? { before } : {}), ...(all ? { all } : {}) }));
		return;
	}

	if (requestUrl.pathname === "/api/project-adrs") {
		writeJson(input.response, await readProjectAdrs(input.dbPath, requestedTenant, input.defaultTenant, input.currentWorkingDirectory, input.credentialStoreOptions, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/project-debt") {
		writeJson(input.response, await readProjectDebt(input.dbPath, requestedTenant, input.defaultTenant, input.currentWorkingDirectory, input.credentialStoreOptions, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/project-context") {
		writeJson(input.response, await readProjectContext(input.dbPath, requestedTenant, input.defaultTenant, input.currentWorkingDirectory, input.credentialStoreOptions, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/project-graph") {
		writeJson(input.response, await readProjectGraph(input.dbPath, requestedTenant, input.defaultTenant, input.currentWorkingDirectory, input.credentialStoreOptions, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/initiative-tab") {
		const initiativeId = requestUrl.searchParams.get("initiative")?.trim();
		const tab = requestUrl.searchParams.get("tab");
		if (!initiativeId || !isInitiativeTab(tab)) {
			writeText(input.response, 400, "Invalid initiative tab request.");
			return;
		}

		writeJson(
			input.response,
			await readInitiativeTab(
				input.dbPath,
				requestedTenant,
				input.defaultTenant,
				input.currentWorkingDirectory,
				input.credentialStoreOptions,
				initiativeId,
				tab,
				requestedProjectIdentity
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/initiative-detail") {
		const initiativeId = requestUrl.searchParams.get("initiative")?.trim();
		if (!initiativeId) {
			writeText(input.response, 400, "Invalid initiative detail request.");
			return;
		}

		writeJson(
			input.response,
			await readInitiativeDetail(
				input.dbPath,
				requestedTenant,
				input.defaultTenant,
				input.currentWorkingDirectory,
				input.credentialStoreOptions,
				initiativeId,
				requestedProjectIdentity
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
				requestedProjectIdentity
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/search/capability") {
		writeJson(
			input.response,
			await readSearchCapability(
				input.dbPath,
				requestedTenant,
				input.defaultTenant,
				input.currentWorkingDirectory,
				input.credentialStoreOptions
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/search") {
		const searchRequest = parseSearchRequest(requestUrl);
		if (!searchRequest) {
			writeText(input.response, 400, "Invalid search request.");
			return;
		}

		writeJson(
			input.response,
			await readSearch(
				input.dbPath,
				requestedTenant,
				input.defaultTenant,
				input.currentWorkingDirectory,
				input.credentialStoreOptions,
				searchRequest
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

async function readTenantScoped<T>(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	projectIdentity: string | undefined,
	read: (store: StorageDriver) => Promise<T>
): Promise<T | { kind: "unavailable" }> {
	if (tenant !== defaultTenant) {
		const availableTenants = await withStore(
			dbPath,
			{ credentialStoreOptions, currentWorkingDirectory, tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" };
		}
	}

	return withStore(dbPath, { credentialStoreOptions, currentWorkingDirectory, projectIdentity, tenant }, read);
}

async function readEntityRelations(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	entityId: string,
	projectIdentity: string | undefined
) {
	return readTenantScoped(dbPath, tenant, defaultTenant, currentWorkingDirectory, credentialStoreOptions, projectIdentity, async (store) => {
		const relations = await store.queryEntityRelations({ entityId });
		return await hasSelectedProjectEntity(store, relations.entity.kind, relations.entity.id)
			? relations
			: { kind: "unavailable" as const };
	});
}

async function readIssueComments(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	projectIdentity: string | undefined,
	input: { issueId: string; before?: string; all?: boolean }
) {
	return readTenantScoped(dbPath, tenant, defaultTenant, currentWorkingDirectory, credentialStoreOptions, projectIdentity, (store) => store.listIssueComments(input));
}

async function readPlanEntryPage(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	projectIdentity: string | undefined,
	input: { planId: string; before?: string; all?: boolean }
) {
	return readTenantScoped(dbPath, tenant, defaultTenant, currentWorkingDirectory, credentialStoreOptions, projectIdentity, (store) => store.listPlanEntryPage(input));
}

async function readProjectAdrs(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	projectIdentity: string | undefined
) {
	return readTenantScoped(dbPath, tenant, defaultTenant, currentWorkingDirectory, credentialStoreOptions, projectIdentity, async (store) => {
		const [projectAdrs, initiatives] = await Promise.all([
			store.listProjectAdrs(),
			store.listEntities("initiative")
		]);
		const initiativeAdrs = await Promise.all(initiatives.map(async (initiative) => ({
			adrs: (await store.getInitiativeTab({ initiativeId: initiative.id, tab: "adrs" })).records,
			initiative
		})));
		return { initiativeAdrs, projectAdrs };
	});
}

async function readProjectDebt(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	projectIdentity: string | undefined
) {
	return readTenantScoped(dbPath, tenant, defaultTenant, currentWorkingDirectory, credentialStoreOptions, projectIdentity, async (store) => {
		const result = await store.queryEntities({ kind: "debt" });
		return { records: result.entities, relations: [] };
	});
}

async function readProjectContext(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	projectIdentity: string | undefined
) {
	return readTenantScoped(dbPath, tenant, defaultTenant, currentWorkingDirectory, credentialStoreOptions, projectIdentity, (store) => store.getContextDirectory());
}

async function readProjectGraph(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	projectIdentity: string | undefined
) {
	return readTenantScoped(dbPath, tenant, defaultTenant, currentWorkingDirectory, credentialStoreOptions, projectIdentity, async (store) => {
		const records = [...new Map((await Promise.all(ENTITY_KINDS.map((kind) => store.listEntities(kind)))).flat().map((record) => [record.id, record])).values()];
		const recordIds = new Set(records.map((record) => record.id));
		const relations = (await store.listAllRelations()).filter((relation) => recordIds.has(relation.fromId) && recordIds.has(relation.toId));
		return { records, relations };
	});
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

async function readProjectSummary(
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

	return withStore(
		dbPath,
		{ credentialStoreOptions, currentWorkingDirectory, tenant },
		(store) => store.getProjectSummary({ projectId })
	);
}

async function readEntityDetails(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	entityId: string,
	projectIdentity: string | undefined
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
		{ credentialStoreOptions, currentWorkingDirectory, projectIdentity, tenant },
		async (store) => {
			const details = await store.getEntityDetails(entityId);
			return await hasSelectedProjectEntity(store, details.entity.kind, details.entity.id)
				? details
				: { kind: "unavailable" as const };
		}
	);
}

async function readInitiativeTab(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	initiativeId: string,
	tab: InitiativeTab,
	projectIdentity: string | undefined
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
		{ credentialStoreOptions, currentWorkingDirectory, projectIdentity, tenant },
		async (store) => await hasSelectedProjectEntity(store, "initiative", initiativeId)
			? store.getInitiativeTab({ initiativeId, tab })
			: { kind: "unavailable" as const }
	);
}

async function readInitiativeDetail(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	initiativeId: string,
	projectIdentity: string | undefined
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
		{ credentialStoreOptions, currentWorkingDirectory, projectIdentity, tenant },
		async (store) => await hasSelectedProjectEntity(store, "initiative", initiativeId)
			? store.getInitiativeDetail({ initiativeId })
			: { kind: "unavailable" as const }
	);
}

async function hasSelectedProjectEntity(store: StorageDriver, kind: string, entityIdentity: string): Promise<boolean> {
	return (await store.listEntities(kind)).some((entity) =>
		entity.id === entityIdentity || entity.reference === entityIdentity || entity.shortReference === entityIdentity
	);
}

async function readSearchCapability(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined
) {
	if (tenant !== defaultTenant) {
		const availableTenants = await withStore(
			dbPath,
			{ credentialStoreOptions, currentWorkingDirectory, tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { state: "unsupported" } as const;
		}
	}

	return withStore(
		dbPath,
		{ credentialStoreOptions, currentWorkingDirectory, tenant },
		(store) => store.getSearchCapability()
	);
}

async function readSearch(
	dbPath: string,
	tenant: string,
	defaultTenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined,
	searchRequest: SearchRequest
) {
	if (tenant !== defaultTenant) {
		const availableTenants = await withStore(
			dbPath,
			{ credentialStoreOptions, currentWorkingDirectory, tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { state: "unsupported" } as const;
		}
	}

	return withStore(
		dbPath,
		{ credentialStoreOptions, currentWorkingDirectory, tenant },
		(store) => store.search(searchRequest)
	);
}

function parseSearchRequest(requestUrl: URL): SearchRequest | null {
	const query = requestUrl.searchParams.get("query")?.trim();
	const scope = requestUrl.searchParams.get("scope");
	const projectId = requestUrl.searchParams.get("project")?.trim();
	const sourceTypes = parseSearchSourceTypes(requestUrl.searchParams.get("sourceTypes"));
	const limit = parseSearchLimit(requestUrl.searchParams.get("limit"));
	if (!query || !scope || sourceTypes === null || limit === null) {
		return null;
	}

	const filters = sourceTypes.length > 0 ? { sourceTypes } : undefined;
	if (scope === "all-projects") {
		return { filters, limit: limit ?? undefined, query, scope: { type: "all-projects" } };
	}
	if (scope === "current-project" && projectId) {
		return { filters, limit: limit ?? undefined, query, scope: { projectId, type: "current-project" } };
	}

	return null;
}

function parseSearchSourceTypes(value: string | null): SearchSourceType[] | null {
	if (!value) {
		return [];
	}

	const validSourceTypes: SearchSourceType[] = ["entity", "context", "context-term", "issue-comment", "plan-entry"];
	const sourceTypes = value.split(",").map((sourceType) => sourceType.trim()).filter(Boolean);
	return sourceTypes.every((sourceType): sourceType is SearchSourceType => validSourceTypes.includes(sourceType as SearchSourceType))
		? [...new Set(sourceTypes)]
		: null;
}

function parseSearchLimit(value: string | null): number | null | undefined {
	if (value === null) {
		return undefined;
	}

	if (!/^\d+$/.test(value)) {
		return null;
	}

	const limit = Number(value);
	return limit > 0 && limit <= 100 ? limit : null;
}

async function readSnapshotSignature(
	dbPath: string,
	tenant: string,
	currentWorkingDirectory: string | undefined,
	credentialStoreOptions: SavedLoginStoreOptions | undefined
) {
	return withStore(dbPath, { credentialStoreOptions, currentWorkingDirectory, tenant }, (store) => store.getSnapshotSignature());
}

type ProjectMutationRequest = {
	correlationId: string;
	method: string;
	params?: unknown;
};

async function readProjectMutationRequest(request: IncomingMessage): Promise<ProjectMutationRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ProjectMutationRequest>;
	if (
		typeof value.correlationId !== "string" ||
		value.correlationId.length === 0 ||
		typeof value.method !== "string" ||
		!writeMethods.has(value.method) ||
		!PROJECT_MUTATION_METHODS.has(value.method) ||
		!rpcMethods[value.method]
	) {
		throw new Error("Invalid project mutation request.");
	}
	return { correlationId: value.correlationId, method: value.method, params: value.params };
}

async function executeProjectMutation(input: {
	dbPath: string;
	currentWorkingDirectory: string | undefined;
	credentialStoreOptions: SavedLoginStoreOptions | undefined;
	mutation: ProjectMutationRequest;
	onLocalMutation: (event: ProjectChangeEvent, signature: string) => void;
	projectId: string | undefined;
	tenant: string;
}): Promise<{ event: ProjectChangeEvent; result: unknown }> {
	const opened = await openStorageDriver({
		authSessionOptions: input.credentialStoreOptions,
		correlationId: input.mutation.correlationId,
		databaseOptions: { currentWorkingDirectory: input.currentWorkingDirectory, projectIdentity: input.projectId, tenant: input.tenant },
		dbPath: input.dbPath,
		localDaemon: { buildHash: readBuildContentHash() }
	});
	const handler = rpcMethods[input.mutation.method]!;

	try {
		const before = await projectChangeEventForWrite(opened.store, input.mutation.method, input.projectId, input.mutation.params, undefined, input.mutation.correlationId);
		const result = await handler(opened.store, input.mutation.params);
		const after = await projectChangeEventForWrite(opened.store, input.mutation.method, input.projectId, input.mutation.params, result, input.mutation.correlationId);
		const event: ProjectChangeEvent = {
			...mergeProjectChangeEventDetails(before, after),
			at: new Date().toISOString(),
			type: "snapshot-changed"
		};
		if (opened.backend === "local") {
			input.onLocalMutation(event, await opened.store.getSnapshotSignature());
		}
		return { event, result };
	} finally {
		await opened.store.close();
	}
}

function broadcast(clients: Set<ServerResponse>, payload: string) {
	for (const client of clients) {
		client.write(`data: ${payload}\n\n`);
	}
}

function writeJson(
	response: ServerResponse,
	payload: unknown,
	diagnostics?: { durationMs: number; metricName: string }
) {
	const body = `${JSON.stringify(payload)}\n`;
	const payloadBytes = Buffer.byteLength(body);
	response.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		...(diagnostics ? {
			"Server-Timing": `${diagnostics.metricName};dur=${diagnostics.durationMs.toFixed(3)}`,
			"X-Agent-Issues-Payload-Bytes": String(payloadBytes),
			"X-Agent-Issues-Response-Duration-Ms": String(diagnostics.durationMs)
		} : {})
	});
	response.end(body);
}

function writeText(response: ServerResponse, statusCode: number, body: string) {
	response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
	response.end(body);
}