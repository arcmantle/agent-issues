import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindCloudProject, saveAuthSession } from "@agent-issues/core";

import { startLiveSite, type LiveSiteHandle } from "./index.js";

type RpcRequestLog = { authorization: string | undefined; method: string; params: unknown };

/** A minimal fake cloud gate exposing both /rpc and /events, standing in for the real one (proven in packages/api/src/http-store-contract.test.ts and the cloud API's own SSE route). */
function startFakeCloudGate(handleMethod: (method: string, params: unknown) => unknown): {
	push: (tenantEvent: unknown) => void;
	requests: RpcRequestLog[];
	server: Server;
	url: string;
} {
	const requests: RpcRequestLog[] = [];
	const eventClients = new Set<ServerResponse>();

	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

		if (requestUrl.pathname === "/events") {
			response.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive"
			});
			response.write(`data: ${JSON.stringify({ type: "connected", at: new Date().toISOString() })}\n\n`);
			eventClients.add(response);
			request.on("close", () => eventClients.delete(response));
			return;
		}

		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: unknown };
			requests.push({ authorization: request.headers.authorization, method: body.method, params: body.params });
			const result = handleMethod(body.method, body.params);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", result }));
		});
	});

	server.listen(0);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		push: (tenantEvent: unknown) => {
			const payload = `data: ${JSON.stringify(tenantEvent)}\n\n`;
			for (const client of eventClients) client.write(payload);
		},
		requests,
		server,
		url: `http://127.0.0.1:${port}`
	};
}

function waitForSnapshotChangedEvent(url: string): { event: Promise<unknown>; stop: () => void } {
	let resolveEvent: (value: unknown) => void;
	const promise = new Promise<unknown>((resolve) => {
		resolveEvent = resolve;
	});

	const controller = new AbortController();
	void (async () => {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.body) return;
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const rawEvent = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
					if (dataLine) {
						const parsed = JSON.parse(dataLine.slice("data:".length).trim());
						if (parsed.type === "snapshot-changed") {
							resolveEvent(parsed);
						}
					}
					boundary = buffer.indexOf("\n\n");
				}
			}
		} catch {
			// aborted
		}
	})();

	return { event: promise, stop: () => controller.abort() };
}

describe("site server follows the seam in cloud mode (ISS56)", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let projectDirectory: string;
	let handle: LiveSiteHandle | undefined;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-site-cloud-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-site-cloud-project-"));
	});

	afterEach(async () => {
		if (handle?.server.listening) {
			await new Promise<void>((resolve) => {
				handle?.server.once("close", () => resolve());
				handle?.close();
			});
		}
		handle = undefined;
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { force: true, recursive: true });
		rmSync(projectDirectory, { force: true, recursive: true });
	});

	it("serves snapshot/site-config through HttpStore once bound, with no site-specific branching", async () => {
		const gate = startFakeCloudGate((method) => {
			if (method === "listTenants") {
				return [{ id: "tenant-a", displayName: "tenant-a", counts: { entities: 0, relations: 0, contexts: 0, contextTerms: 0, handoffs: 0, historyEntries: 0 } }];
			}
			if (method === "getDatabaseSnapshot") {
				return { entities: [{ id: "iss-1", kind: "initiative", title: "Cloud Viewer" }], relations: [] };
			}
			return {};
		});

		try {
			bindCloudProject({ cloudApiUrl: gate.url, projectIdentity: path.basename(projectDirectory).toLowerCase(), tenantId: "tenant-a" });
			saveAuthSession({ accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z", tenantId: "tenant-a", userId: "user-1" });

			handle = await startLiveSite({ currentWorkingDirectory: projectDirectory, port: 0, tenant: "tenant-a" });
			await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

			const address = handle.server.address();
			const port = typeof address === "object" && address ? address.port : 0;

			const configResponse = await fetch(`http://127.0.0.1:${port}/site-config.json`);
			const config = await configResponse.json();
			expect(config.dbPath).toBe(gate.url);
			expect(config.currentTenant).toBe("tenant-a");

			const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
			const snapshot = await snapshotResponse.json();
			expect(snapshot.entities.map((entity: { id: string }) => entity.id)).toContain("iss-1");

			expect(gate.requests.every((request) => request.authorization === "Bearer token-a")).toBe(true);
		} finally {
			gate.server.close();
		}
	});

	it("relays cloud snapshot-changed events to the site's own /events clients", async () => {
		const gate = startFakeCloudGate(() => ({}));

		try {
			bindCloudProject({ cloudApiUrl: gate.url, projectIdentity: path.basename(projectDirectory).toLowerCase(), tenantId: "tenant-a" });
			saveAuthSession({ accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z", tenantId: "tenant-a", userId: "user-1" });

			handle = await startLiveSite({ currentWorkingDirectory: projectDirectory, port: 0, tenant: "tenant-a" });
			await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

			const address = handle.server.address();
			const port = typeof address === "object" && address ? address.port : 0;

			const listener = waitForSnapshotChangedEvent(`http://127.0.0.1:${port}/events`);
			await new Promise((resolve) => setTimeout(resolve, 100));

			gate.push({ type: "snapshot-changed", at: "2024-01-01T00:00:00.000Z" });

			const event = await Promise.race([
				listener.event,
				new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out waiting for relayed event")), 2000))
			]);

			listener.stop();
			expect(event).toEqual({ type: "snapshot-changed", at: "2024-01-01T00:00:00.000Z" });
		} finally {
			gate.server.close();
		}
	});
});
