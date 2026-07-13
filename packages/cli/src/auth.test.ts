import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { performLogin, type DeviceCodeLoginFn } from "./cli/commands/auth.js";
import { getCurrentAuthSession, saveAuthSession, type AuthSessionStoreOptions } from "./auth-session.js";
import type { RunCredentialCommand } from "@agent-issues/core";

/** Fake in-memory credential store, mirroring `daemon-token.test.ts`'s helper, so this suite never shells out to a real native OS credential tool. */
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

function fakeDeviceCodeLogin(result: {
	tenantId: string;
	userId: string;
	displayName?: string;
	accessToken: string;
	expiresAt: string;
}): DeviceCodeLoginFn {
	return async () => result;
}

describe("performLogin", () => {
	it("runs the device-code flow, prompts the user, and persists the resulting session as current", async () => {
		const homeDirectory = `/tmp/does-not-matter-${Math.random()}`;
		const options: AuthSessionStoreOptions = { homeDirectory, ...fakeCredentialStore() };
		const prompts: string[] = [];

		const session = await performLogin(
			{ tenantId: "tenant-a", clientId: "client-a" },
			fakeDeviceCodeLogin({
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			}),
			(message) => prompts.push(message),
			options
		);

		expect(session).toEqual({
			tenantId: "tenant-a",
			userId: "user-1",
			displayName: "Ada Lovelace",
			accessToken: "token-a",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});
		await expect(getCurrentAuthSession(options)).resolves.toEqual(session);
	});

	it("forwards the device-code prompt message to the caller", async () => {
		const homeDirectory = `/tmp/does-not-matter-${Math.random()}`;
		const options: AuthSessionStoreOptions = { homeDirectory, ...fakeCredentialStore() };
		const prompts: string[] = [];

		const deviceCodeLogin: DeviceCodeLoginFn = async ({ onDeviceCode }) => {
			onDeviceCode("To sign in, visit https://microsoft.com/devicelogin and enter code ABCD-EFGH.");
			return {
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			};
		};

		await performLogin({ tenantId: "tenant-a", clientId: "client-a" }, deviceCodeLogin, (message) => prompts.push(message), options);

		expect(prompts).toEqual(["To sign in, visit https://microsoft.com/devicelogin and enter code ABCD-EFGH."]);
	});
});

function createCapture() {
	const stream = new PassThrough();
	let text = "";
	stream.on("data", (chunk) => {
		text += chunk.toString();
	});
	return { stream, read: () => text };
}

describe("auth CLI commands", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let credentialStoreOptions: AuthSessionStoreOptions;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auth-cli-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		credentialStoreOptions = fakeCredentialStore();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { force: true, recursive: true });
	});

	it("reports not logged in when no session has been saved", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "status"], { stdout: stdout.stream, stderr: stderr.stream, credentialStoreOptions });

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("Not logged in.");
	});

	it("reports the current session's status without leaking the accessToken", async () => {
		await saveAuthSession(
			{
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				accessToken: "super-secret-token",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);

		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "status", "--json"], { stdout: stdout.stream, stderr: stderr.stream, credentialStoreOptions });

		expect(exitCode).toBe(0);
		expect(stdout.read()).not.toContain("super-secret-token");
		expect(JSON.parse(stdout.read())).toEqual({
			command: "auth-status",
			loggedIn: true,
			session: {
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				expiresAt: "2099-01-01T00:00:00.000Z"
			}
		});
	});

	it("switches to an already-cached tenant", async () => {
		await saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			credentialStoreOptions
		);
		await saveAuthSession(
			{ tenantId: "tenant-b", userId: "user-2", accessToken: "token-b", expiresAt: "2099-01-01T00:00:00.000Z" },
			credentialStoreOptions
		);

		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "switch", "tenant-a"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("Switched to tenant tenant-a");
		await expect(getCurrentAuthSession(credentialStoreOptions)).resolves.toMatchObject({ tenantId: "tenant-a" });
	});

	it("throws a helpful error when switching to a tenant with no cached session", async () => {
		await expect(runCli(["auth", "switch", "tenant-unknown"], { credentialStoreOptions })).rejects.toThrow(/No cached auth session/);
	});

	it("logs out of the current tenant", async () => {
		await saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			credentialStoreOptions
		);

		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "logout"], { stdout: stdout.stream, stderr: stderr.stream, credentialStoreOptions });

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("Logged out of tenant tenant-a");
		await expect(getCurrentAuthSession(credentialStoreOptions)).resolves.toBeUndefined();
	});

	it("requires --tenant-id and --client-id before attempting a real device-code login", async () => {
		await expect(runCli(["auth", "login"], { credentialStoreOptions })).rejects.toThrow(/--tenant-id/);
		await expect(runCli(["auth", "login", "--tenant-id", "tenant-a"], { credentialStoreOptions })).rejects.toThrow(/--client-id/);
	});

	it("logs in locally with --local, issuing and caching a real dev session without any Azure tenant", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "login", "--local", "--user-id", "dev-user", "--secret", "test-secret"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("local-dev");
		const current = await getCurrentAuthSession(credentialStoreOptions);
		expect(current?.tenantId).toBe("local-dev");
		expect(current?.userId).toBe("dev-user");
		expect(typeof current?.accessToken).toBe("string");
	});

	it("requires --secret before attempting a local dev login", async () => {
		await expect(runCli(["auth", "login", "--local"], { credentialStoreOptions })).rejects.toThrow(/--secret/);
	});
});
