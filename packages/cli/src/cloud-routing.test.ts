import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindCloudProject, saveAuthSession } from "@agent-issues/core";

import { runCli } from "./cli.js";

function createCapture() {
	const stream = new PassThrough();
	let text = "";
	stream.on("data", (chunk) => {
		text += chunk.toString();
	});
	return { stream, read: () => text };
}

type RpcRequestLog = { method: string; params: unknown; authorization: string | undefined };

/** A minimal fake JSON-RPC gate, standing in for the real cloud API (proven separately in packages/api/src/http-store-contract.test.ts) so this suite can verify CLI-level plumbing without a Postgres dependency. */
function startFakeRpcGate(handleMethod: (method: string, params: unknown) => unknown): {
	requests: RpcRequestLog[];
	server: Server;
	url: string;
} {
	const requests: RpcRequestLog[] = [];

	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: unknown };
			requests.push({ authorization: request.headers.authorization, method: body.method, params: body.params });

			try {
				const result = handleMethod(body.method, body.params);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", result }));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { code: -32000, message }, id: body.id, jsonrpc: "2.0" }));
			}
		});
	});

	server.listen(0);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return { requests, server, url: `http://127.0.0.1:${port}` };
}

/**
 * Proves the seam ISS55 wires up: an ordinary command (not `cloud status`)
 * routes through `withStore` -> `openStorageDriver` -> `HttpStore` and hits
 * a real HTTP endpoint once a project is cloud-bound with a cached session,
 * with no behavior change to the command itself.
 */
describe("CLI commands route through the cloud backend once bound", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let projectDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-routing-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-routing-project-"));
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { force: true, recursive: true });
		rmSync(projectDirectory, { force: true, recursive: true });
	});

	it("creates an entity against the cloud API when bound with a valid session", async () => {
		const gate = startFakeRpcGate((method, params) => {
			expect(method).toBe("createEntity");
			expect(params).toEqual({ kind: "initiative", title: "Ship it" });
			return {
				body: "",
				bodySource: "manual",
				createdAt: "2024-01-01T00:00:00.000Z",
				id: "iss-1",
				kind: "initiative",
				status: "open",
				title: "Ship it",
				updatedAt: "2024-01-01T00:00:00.000Z"
			};
		});

		try {
			bindCloudProject(
				{ cloudApiUrl: gate.url, projectIdentity: path.basename(projectDirectory).toLowerCase(), tenantId: "tenant-a" }
			);
			saveAuthSession({
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z",
				tenantId: "tenant-a",
				userId: "user-1"
			});

			const stdout = createCapture();
			const stderr = createCapture();
			const exitCode = await runCli(["create", "initiative", "--title", "Ship it", "--json"], {
				cwd: projectDirectory,
				stderr: stderr.stream,
				stdout: stdout.stream
			});

			expect(stderr.read()).toBe("");
			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout.read())).toMatchObject({ id: "iss-1", kind: "initiative", title: "Ship it" });
			expect(gate.requests).toHaveLength(1);
			expect(gate.requests[0]?.authorization).toBe("Bearer token-a");
		} finally {
			gate.server.close();
		}
	});

	it("surfaces a clear auth-login error instead of a raw HTTP failure when no session is cached", async () => {
		const gate = startFakeRpcGate(() => ({}));

		try {
			bindCloudProject(
				{ cloudApiUrl: gate.url, projectIdentity: path.basename(projectDirectory).toLowerCase(), tenantId: "tenant-a" }
			);

			await expect(
				runCli(["create", "initiative", "--title", "Ship it"], { cwd: projectDirectory })
			).rejects.toThrow(/auth login/);
			expect(gate.requests).toHaveLength(0);
		} finally {
			gate.server.close();
		}
	});
});
