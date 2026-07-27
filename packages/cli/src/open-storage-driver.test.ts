import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpStore, type RunCredentialCommand } from "@agent-issues/core";
import { saveDaemonState, saveDaemonToken, SqliteStore } from "@agent-issues/api-local";
import { saveSavedLogin, setActiveSavedLogin } from "./auth-session.js";
import { LocalDaemonStore } from "./daemon/local-daemon-store.js";
import { assertNoDaemonAllowed, openStorageDriver } from "./open-storage-driver.js";
import { resolveProjectIdentity } from "./project-identity.js";

/** Fake in-memory OS credential store, mirroring `daemon-token.test.ts`'s helper, so this suite never shells out to a real native tool. */
function fakeCredentialStore(): { platform: "darwin"; runCommand: RunCredentialCommand } {
	const store = new Map<string, string>();

	const runCommand: RunCredentialCommand = async (command) => {
		const [action, , account, , service] = command.args;
		const key = `${service}:${account}`;

		if (action === "add-generic-password") {
			store.set(key, command.args[6]);
			return { stdout: "", exitCode: 0 };
		}
		if (action === "find-generic-password") {
			const value = store.get(key);
			return value === undefined ? { stdout: "", exitCode: 44 } : { stdout: `${value}\n`, exitCode: 0 };
		}
		const existed = store.delete(key);
		return { stdout: "", exitCode: existed ? 0 : 44 };
	};

	return { platform: "darwin", runCommand };
}

describe("openStorageDriver (ADR13, ADR18)", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let projectDirectory: string;
	let projectRoot: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-storage-driver-home-"));
		// The local backend resolves its SQLite db path from the real OS home
		// directory (`resolveAgentIssuesHomeDirectory`), which only reads
		// `homedir()` and has no options-based override. Redirecting HOME is the only way to
		// keep the "local backend" cases in this file from writing real
		// entities into the developer's actual ~/.agent-issues/agent-issues.db.
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-open-storage-driver-project-"));
		projectDirectory = path.join(projectRoot, "default-project");
		mkdirSync(projectDirectory);
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { recursive: true, force: true });
		rmSync(projectRoot, { recursive: true, force: true });
	});

	it("rejects AGENT_ISSUES_NO_DAEMON in a production build", () => {
		expect(() => assertNoDaemonAllowed({ AGENT_ISSUES_NO_DAEMON: "1" }, "production")).toThrow(
			"AGENT_ISSUES_NO_DAEMON is only available in development builds"
		);
	});

	it("opens a direct SqliteStore when AGENT_ISSUES_NO_DAEMON=1 forces the escape hatch (ISS190)", async () => {
		const result = await openStorageDriver({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			authSessionOptions: { homeDirectory, ...fakeCredentialStore() },
			env: { AGENT_ISSUES_NO_DAEMON: "1" }
		});

		try {
			expect(result.backend).toBe("local");
			expect(result.store).toBeInstanceOf(SqliteStore);
			expect(result.dbPath).toBeTruthy();
			expect(result.cloudConnection).toBeUndefined();
			expect(result.daemonFallbackWarning).toBeUndefined();
		} finally {
			await result.store.close();
		}
	});

	describe("local mode routes through the daemon by default (ISS190, ADR44)", () => {
		let credentialStoreOptions: ReturnType<typeof fakeCredentialStore>;
		let servers: Server[];

		function listenFakeDaemon(): Promise<number> {
			const server = createServer((request, response) => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: [] }));
			});
			servers.push(server);
			return new Promise((resolve) => {
				server.listen(0, "127.0.0.1", () => {
					const address = server.address();
					resolve(typeof address === "object" && address !== null ? address.port : 0);
				});
			});
		}

		beforeEach(() => {
			credentialStoreOptions = fakeCredentialStore();
			servers = [];
		});

		afterEach(async () => {
			for (const server of servers) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		});

		it("returns a daemon-routed store when the daemon is reachable, without ever calling spawn", async () => {
			await saveDaemonToken("real-token", credentialStoreOptions);
			const port = await listenFakeDaemon();
			saveDaemonState({ pid: process.pid, port }, { homeDirectory });
			const spawn = vi.fn();

			const result = await openStorageDriver({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions },
				env: {},
				localDaemon: { homeDirectory, credentialStoreOptions, spawn }
			});

			try {
				expect(result.backend).toBe("local");
				expect(result.store).toBeInstanceOf(LocalDaemonStore);
				expect(result.dbPath).toBeTruthy();
				expect(result.daemonFallbackWarning).toBeUndefined();
				expect(spawn).not.toHaveBeenCalled();
			} finally {
				await result.store.close();
			}
		});

		it("passes its own resolved db path through to the daemon store (ISS190)", async () => {
			await saveDaemonToken("real-token", credentialStoreOptions);
			let seenDbPath: string | string[] | undefined;
			let seenProjectIdentity: string | string[] | undefined;
			const server = createServer((request, response) => {
				seenDbPath = request.headers["x-agent-issues-db-path"];
				seenProjectIdentity = request.headers["x-agent-issues-project-identity"];
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: [] }));
			});
			servers.push(server);
			const port = await new Promise<number>((resolve) => {
				server.listen(0, "127.0.0.1", () => {
					const address = server.address();
					resolve(typeof address === "object" && address !== null ? address.port : 0);
				});
			});
			saveDaemonState({ pid: process.pid, port }, { homeDirectory });
			const spawn = vi.fn();

			const result = await openStorageDriver({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions },
				env: {},
				localDaemon: { homeDirectory, credentialStoreOptions, spawn }
			});

			try {
				await result.store.listEntities("initiative");
				expect(seenDbPath).toBe(result.dbPath);
				expect(seenProjectIdentity).toBe(resolveProjectIdentity(projectDirectory).identity);
			} finally {
				await result.store.close();
			}
		});

		it("falls back to a direct SqliteStore with a visible warning when the daemon cannot be spawned", async () => {
			const spawn = vi.fn(() => {
				throw new Error("spawn agent-issues ENOENT");
			});

			const result = await openStorageDriver({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions },
				env: {},
				localDaemon: { homeDirectory, credentialStoreOptions, spawn, waitTimeoutMs: 50, pollIntervalMs: 5 }
			});

			try {
				expect(result.backend).toBe("local");
				expect(result.store).toBeInstanceOf(SqliteStore);
				expect(result.daemonFallbackWarning).toMatch(/ENOENT/);
			} finally {
				await result.store.close();
			}
		});
	});

	it("opens an HttpStore for the active remote saved login", async () => {
		const credentialStoreOptions = fakeCredentialStore();
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://api.example.com",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			{ homeDirectory, ...credentialStoreOptions }
		);

		const result = await openStorageDriver({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			authSessionOptions: { homeDirectory, ...credentialStoreOptions },
			env: { AGENT_ISSUES_NO_DAEMON: "1" }
		});

		try {
			expect(result.backend).toBe("cloud");
			expect(result.store).toBeInstanceOf(HttpStore);
			expect(result.store.tenantId).toBe("tenant-a");
			expect(result.dbPath).toBe("https://api.example.com");
			expect(result.cloudConnection).toEqual({
				baseUrl: "https://api.example.com",
				bearerToken: "token-a",
				tenantId: "tenant-a"
			});
		} finally {
			await result.store.close();
		}
	});

	it("switching the active saved login controls routing and AGENT_ISSUES_BACKEND is ignored", async () => {
		const credentialStoreOptions = fakeCredentialStore();
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.com",
				tenantId: "tenant-work",
				userId: "user-1",
				accessToken: "token-work",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			{ homeDirectory, ...credentialStoreOptions }
		);
		await saveSavedLogin(
			{
				name: "personal",
				kind: "remote",
				serviceUrl: "https://personal.example.com",
				tenantId: "tenant-personal",
				userId: "user-1",
				accessToken: "token-personal",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			{ homeDirectory, ...credentialStoreOptions }
		);

		const personal = await openStorageDriver({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			authSessionOptions: { homeDirectory, ...credentialStoreOptions },
			env: { AGENT_ISSUES_BACKEND: "local" }
		});
		await setActiveSavedLogin("work", { homeDirectory, ...credentialStoreOptions });
		const work = await openStorageDriver({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			authSessionOptions: { homeDirectory, ...credentialStoreOptions },
			env: { AGENT_ISSUES_BACKEND: "local" }
		});

		try {
			expect(personal.backend).toBe("cloud");
			expect(personal.dbPath).toBe("https://personal.example.com");
			expect(personal.cloudConnection).toEqual({
				baseUrl: "https://personal.example.com",
				bearerToken: "token-personal",
				tenantId: "tenant-personal"
			});
			expect(work.backend).toBe("cloud");
			expect(work.dbPath).toBe("https://work.example.com");
			expect(work.cloudConnection).toEqual({
				baseUrl: "https://work.example.com",
				bearerToken: "token-work",
				tenantId: "tenant-work"
			});
		} finally {
			await personal.store.close();
			await work.store.close();
		}
	});
});
