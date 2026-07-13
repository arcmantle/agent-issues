import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindCloudProject } from "../cloud/cloud-binding.js";
import { saveDaemonState } from "../daemon/daemon-state.js";
import { saveDaemonToken, type RunCredentialCommand } from "../daemon/daemon-token.js";
import { HttpStore } from "./http-store.js";
import { LocalDaemonStore } from "../daemon/local-daemon-store.js";
import { openStorageDriver } from "./open-storage-driver.js";
import { resolveProjectIdentity } from "../cloud/project-identity.js";
import { saveAuthSession } from "../auth/auth-session.js";
import { SqliteStore } from "./sqlite-store.js";

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

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-storage-driver-home-"));
		// The local backend resolves its SQLite db path from the real OS home
		// directory (`resolveAgentIssuesHomeDirectory`), which only reads
		// `homedir()` - unlike cloudBindingOptions/authSessionOptions below, it
		// has no options-based override. Redirecting HOME is the only way to
		// keep the "local backend" cases in this file from writing real
		// entities into the developer's actual ~/.agent-issues/agent-issues.db.
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-storage-driver-project-"));
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { recursive: true, force: true });
		rmSync(projectDirectory, { recursive: true, force: true });
	});

	it("opens a direct SqliteStore when AGENT_ISSUES_NO_DAEMON=1 forces the escape hatch (ISS190)", async () => {
		const result = await openStorageDriver({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			cloudBindingOptions: { homeDirectory },
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
				cloudBindingOptions: { homeDirectory },
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
			const server = createServer((request, response) => {
				seenDbPath = request.headers["x-agent-issues-db-path"];
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
				cloudBindingOptions: { homeDirectory },
				env: {},
				localDaemon: { homeDirectory, credentialStoreOptions, spawn }
			});

			try {
				await result.store.listEntities("initiative");
				expect(seenDbPath).toBe(result.dbPath);
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
				cloudBindingOptions: { homeDirectory },
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

	it("opens an HttpStore when the project is cloud-bound and a valid session is cached", async () => {
		const { identity: projectIdentity } = resolveProjectIdentity(projectDirectory);
		const credentialStoreOptions = fakeCredentialStore();
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);
		await saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory, ...credentialStoreOptions }
		);

		const result = await openStorageDriver({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			cloudBindingOptions: { homeDirectory },
			authSessionOptions: { homeDirectory, ...credentialStoreOptions },
			env: {}
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

	it("throws a clear error directing to auth login when cloud-bound but no session is cached", async () => {
		const { identity: projectIdentity } = resolveProjectIdentity(projectDirectory);
		const credentialStoreOptions = fakeCredentialStore();
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);

		await expect(
			openStorageDriver({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				cloudBindingOptions: { homeDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions },
				env: {}
			})
		).rejects.toThrow(/auth login/);
	});

	it("throws the same clear error when the cached session for the bound tenant has expired", async () => {
		const { identity: projectIdentity } = resolveProjectIdentity(projectDirectory);
		const credentialStoreOptions = fakeCredentialStore();
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);
		await saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2000-01-01T00:00:00.000Z" },
			{ homeDirectory, ...credentialStoreOptions }
		);

		await expect(
			openStorageDriver({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				cloudBindingOptions: { homeDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions },
				env: {}
			})
		).rejects.toThrow(/auth login/);
	});

	it("an env var forcing local wins even when the project is cloud-bound", async () => {
		const { identity: projectIdentity } = resolveProjectIdentity(projectDirectory);
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);

		const result = await openStorageDriver({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			cloudBindingOptions: { homeDirectory },
			env: { AGENT_ISSUES_BACKEND: "local", AGENT_ISSUES_NO_DAEMON: "1" }
		});

		try {
			expect(result.backend).toBe("local");
		} finally {
			await result.store.close();
		}
	});
});
