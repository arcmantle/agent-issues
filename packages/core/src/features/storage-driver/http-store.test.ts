import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { SynchronizeConflictError } from "../synchronize/canonical-chain.js";
import { IssueCommentConflictError } from "./issue-comment-store.js";
import { DaemonDbPathMismatchError, DaemonHandshakeMismatchError, DaemonVersionMismatchError, HttpStore } from "./http-store.js";

describe("HttpStore synchronize conflict transport (ISS267/ADR55)", () => {
	it("recreates a typed conflict with current record metadata", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "1",
					error: {
						code: -32603,
						message: "Cannot synchronize divergent or stale context-term project:tenant: current revision is 3.",
						data: { recordKind: "context-term", recordId: "project:tenant", currentRevision: 3, currentContentHash: "current-hash" }
					}
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await expect(client.importCanonicalChains({ entities: [], contexts: [], contextTerms: [], issueComments: [], users: [] })).rejects.toMatchObject({
			name: "SynchronizeConflictError",
			recordKind: "context-term",
			recordId: "project:tenant",
			currentRevision: 3,
			currentContentHash: "current-hash"
		} satisfies Partial<SynchronizeConflictError>);
	});

	it("recreates a typed issue-comment conflict with current record metadata", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "1",
					error: {
						code: -32603,
						message: "Stale edit for issue comment comment-id: current revision is 3.",
						data: { commentId: "comment-id", currentRevision: 3, currentContentHash: "current-hash" }
					}
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await expect(client.updateIssueComment({
			commentId: "comment-id",
			body: "Updated comment.",
			expectedRevision: 1,
			expectedContentHash: "stale-hash"
		})).rejects.toMatchObject({
			name: "IssueCommentConflictError",
			commentId: "comment-id",
			currentRevision: 3,
			currentContentHash: "current-hash"
		} satisfies Partial<IssueCommentConflictError>);
	});
});

/**
 * `HttpStore`'s full behavioral contract runs against a real gate elsewhere
 * (`http-store-contract.test.ts`, `storage-driver-contract.test.ts`). This
 * file only covers the build-hash version-handshake header/error handling
 * (ISS188, ADR45), which needs no `StorageDriver`/Postgres at all - a bare
 * fake HTTP server standing in for the daemon's `/rpc` route is enough.
 */
describe("HttpStore build-hash version handshake (ISS188, ADR45)", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	async function listenWithHandler(handler: (headers: Record<string, string | string[] | undefined>) => void): Promise<string> {
		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				handler(request.headers);
				response.writeHead(409, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "Daemon build-hash mismatch.", code: "daemon-version-mismatch", expectedBuildHash: "hash-v2", receivedBuildHash: "hash-v1" }));
			});
		});
		const port = await new Promise<number>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		return `http://127.0.0.1:${port}`;
	}

	it("sends the configured build hash on every request when supplied", async () => {
		let seenHeader: string | string[] | undefined;
		const baseUrl = await listenWithHandler((headers) => {
			seenHeader = headers["x-agent-issues-build-hash"];
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", buildHash: "hash-v1" });
		await client.listEntities("initiative").catch(() => undefined);

		expect(seenHeader).toBe("hash-v1");
	});

	it("sends no build-hash header when none is configured (cloud mode, unaffected)", async () => {
		let sawHeader = false;
		const baseUrl = await listenWithHandler((headers) => {
			sawHeader = "x-agent-issues-build-hash" in headers;
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1" });
		await client.listEntities("initiative").catch(() => undefined);

		expect(sawHeader).toBe(false);
	});

	it("throws a DaemonVersionMismatchError carrying both hashes on a 409 mismatch response", async () => {
		const baseUrl = await listenWithHandler(() => undefined);
		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", buildHash: "hash-v1" });

		await expect(client.listEntities("initiative")).rejects.toThrow(DaemonVersionMismatchError);
		try {
			await client.listEntities("initiative");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DaemonVersionMismatchError);
			expect((error as DaemonVersionMismatchError).expectedBuildHash).toBe("hash-v2");
			expect((error as DaemonVersionMismatchError).receivedBuildHash).toBe("hash-v1");
		}
	});
});

/**
 * ISS190's daemon-restart-on-different-db mechanism: mirrors the build-hash
 * handshake above but keyed on the requested db path instead.
 */
describe("HttpStore db-path handshake (ISS190)", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	async function listenWithHandler(handler: (headers: Record<string, string | string[] | undefined>) => void): Promise<string> {
		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				handler(request.headers);
				response.writeHead(409, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "Daemon db-path mismatch.", code: "daemon-db-mismatch", expectedDbPath: "/tmp/current.db", receivedDbPath: "/tmp/other.db" }));
			});
		});
		const port = await new Promise<number>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		return `http://127.0.0.1:${port}`;
	}

	it("sends the configured db path on every request when supplied", async () => {
		let seenHeader: string | string[] | undefined;
		const baseUrl = await listenWithHandler((headers) => {
			seenHeader = headers["x-agent-issues-db-path"];
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", dbPath: "/tmp/other.db" });
		await client.listEntities("initiative").catch(() => undefined);

		expect(seenHeader).toBe("/tmp/other.db");
	});

	it("sends no db-path header when none is configured (cloud mode, unaffected)", async () => {
		let sawHeader = false;
		const baseUrl = await listenWithHandler((headers) => {
			sawHeader = "x-agent-issues-db-path" in headers;
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1" });
		await client.listEntities("initiative").catch(() => undefined);

		expect(sawHeader).toBe(false);
	});

	it("throws a DaemonDbPathMismatchError carrying both paths on a 409 db-mismatch response", async () => {
		const baseUrl = await listenWithHandler(() => undefined);
		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", dbPath: "/tmp/other.db" });

		try {
			await client.listEntities("initiative");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DaemonDbPathMismatchError);
			expect((error as DaemonDbPathMismatchError).expectedDbPath).toBe("/tmp/current.db");
			expect((error as DaemonDbPathMismatchError).receivedDbPath).toBe("/tmp/other.db");
		}
	});

	it("is also a DaemonHandshakeMismatchError, like DaemonVersionMismatchError", async () => {
		const baseUrl = await listenWithHandler(() => undefined);
		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", dbPath: "/tmp/other.db" });

		await expect(client.listEntities("initiative")).rejects.toThrow(DaemonHandshakeMismatchError);
	});
});

/**
 * ISS183's project-scoping seam: unlike build-hash/db-path, there is no
 * mismatch/error concept here - the header just carries the client's
 * already-resolved project identity onward to the cloud gate, which uses
 * it to scope a bare `context` command to that project's own glossary.
 */
describe("HttpStore project-identity header (ISS183)", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	async function listenWithHandler(handler: (headers: Record<string, string | string[] | undefined>) => void): Promise<string> {
		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				handler(request.headers);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: [] }));
			});
		});
		const port = await new Promise<number>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		return `http://127.0.0.1:${port}`;
	}

	it("sends the configured project identity on every request when supplied", async () => {
		let seenHeader: string | string[] | undefined;
		const baseUrl = await listenWithHandler((headers) => {
			seenHeader = headers["x-agent-issues-project-identity"];
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", projectIdentity: "repo-a" });
		await client.listEntities("initiative");

		expect(seenHeader).toBe("repo-a");
	});

	it("sends no project-identity header when none is configured", async () => {
		let sawHeader = false;
		const baseUrl = await listenWithHandler((headers) => {
			sawHeader = "x-agent-issues-project-identity" in headers;
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1" });
		await client.listEntities("initiative");

		expect(sawHeader).toBe(false);
	});
});
