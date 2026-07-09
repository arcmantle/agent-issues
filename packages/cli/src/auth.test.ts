import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { performLogin, type DeviceCodeLoginFn } from "./cli/commands/auth.js";
import { getCurrentAuthSession, saveAuthSession, type AuthSessionStoreOptions } from "@agent-issues/core";

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
		const options: AuthSessionStoreOptions = { homeDirectory };
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
		expect(getCurrentAuthSession(options)).toEqual(session);
	});

	it("forwards the device-code prompt message to the caller", async () => {
		const homeDirectory = `/tmp/does-not-matter-${Math.random()}`;
		const options: AuthSessionStoreOptions = { homeDirectory };
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

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auth-cli-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { force: true, recursive: true });
	});

	it("reports not logged in when no session has been saved", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "status"], { stdout: stdout.stream, stderr: stderr.stream });

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("Not logged in.");
	});

	it("reports the current session's status without leaking the accessToken", async () => {
		saveAuthSession({
			tenantId: "tenant-a",
			userId: "user-1",
			displayName: "Ada Lovelace",
			accessToken: "super-secret-token",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});

		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "status", "--json"], { stdout: stdout.stream, stderr: stderr.stream });

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
		saveAuthSession({ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" });
		saveAuthSession({ tenantId: "tenant-b", userId: "user-2", accessToken: "token-b", expiresAt: "2099-01-01T00:00:00.000Z" });

		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "switch", "tenant-a"], { stdout: stdout.stream, stderr: stderr.stream });

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("Switched to tenant tenant-a");
		expect(getCurrentAuthSession()?.tenantId).toBe("tenant-a");
	});

	it("throws a helpful error when switching to a tenant with no cached session", async () => {
		await expect(runCli(["auth", "switch", "tenant-unknown"], {})).rejects.toThrow(/No cached auth session/);
	});

	it("logs out of the current tenant", async () => {
		saveAuthSession({ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" });

		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "logout"], { stdout: stdout.stream, stderr: stderr.stream });

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("Logged out of tenant tenant-a");
		expect(getCurrentAuthSession()).toBeUndefined();
	});

	it("requires --tenant-id and --client-id before attempting a real device-code login", async () => {
		await expect(runCli(["auth", "login"], {})).rejects.toThrow(/--tenant-id/);
		await expect(runCli(["auth", "login", "--tenant-id", "tenant-a"], {})).rejects.toThrow(/--client-id/);
	});
});
