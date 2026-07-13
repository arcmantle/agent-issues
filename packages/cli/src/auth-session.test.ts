import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getCurrentAuthSession,
	listAuthSessions,
	removeAuthSession,
	saveAuthSession,
	switchAuthSession,
	toAuthSessionView,
	type AuthSessionStoreOptions
} from "./auth-session.js";
import { setCredential, type CredentialCommand, type RunCredentialCommand } from "@agent-issues/core";

/** Fake in-memory credential store standing in for a real OS credential tool, keyed the same way `os-credential-store.ts` addresses a real one (mirrors `daemon-token.test.ts`'s helper). */
function fakeCredentialStore(): { runCommand: RunCredentialCommand } {
	const store = new Map<string, string>();

	const runCommand: RunCredentialCommand = async (command: CredentialCommand) => {
		const [, account, , service] = command.args; // "-a" <account> "-s" <service> ...
		const key = `${service}:${account}`;

		if (command.args[0] === "add-generic-password") {
			store.set(key, command.args[6]);
			return { stdout: "", exitCode: 0 };
		}
		if (command.args[0] === "find-generic-password") {
			const value = store.get(key);
			return value === undefined ? { stdout: "", exitCode: 44 } : { stdout: `${value}\n`, exitCode: 0 };
		}
		// delete-generic-password
		const existed = store.delete(key);
		return { stdout: "", exitCode: existed ? 0 : 44 };
	};

	return { runCommand };
}

describe("auth-session storage (ISS185)", () => {
	let homeDirectory: string;
	let options: AuthSessionStoreOptions;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auth-session-"));
		options = { homeDirectory, platform: "darwin", ...fakeCredentialStore() };
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("saves a session and reads it back as the current session", async () => {
		await saveAuthSession(
			{
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			options
		);

		const current = await getCurrentAuthSession(options);

		expect(current).toEqual({
			tenantId: "tenant-a",
			userId: "user-1",
			displayName: "Ada Lovelace",
			accessToken: "token-a",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});
	});

	it("returns undefined when no session has ever been saved", async () => {
		await expect(getCurrentAuthSession(options)).resolves.toBeUndefined();
	});

	it("lists every cached session, regardless of which is current", async () => {
		await saveAuthSession({ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" }, options);
		await saveAuthSession({ tenantId: "tenant-b", userId: "user-2", accessToken: "token-b", expiresAt: "2099-01-01T00:00:00.000Z" }, options);

		const sessions = await listAuthSessions(options);

		expect(sessions.map((session) => session.tenantId).sort()).toEqual(["tenant-a", "tenant-b"]);
	});

	it("switches the current tenant to an already-cached session without touching its accessToken", async () => {
		await saveAuthSession({ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" }, options);
		await saveAuthSession({ tenantId: "tenant-b", userId: "user-2", accessToken: "token-b", expiresAt: "2099-01-01T00:00:00.000Z" }, options);

		const switched = await switchAuthSession("tenant-a", options);

		expect(switched).toEqual({
			tenantId: "tenant-a",
			userId: "user-1",
			accessToken: "token-a",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});
		await expect(getCurrentAuthSession(options)).resolves.toMatchObject({ tenantId: "tenant-a" });
	});

	it("throws when switching to a tenant with no cached session", async () => {
		await expect(switchAuthSession("tenant-unknown", options)).rejects.toThrow(/No cached auth session/);
	});

	it("removes a session and clears the current pointer if it was current", async () => {
		await saveAuthSession({ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" }, options);

		await removeAuthSession("tenant-a", options);

		await expect(getCurrentAuthSession(options)).resolves.toBeUndefined();
		await expect(listAuthSessions(options)).resolves.toEqual([]);
	});

	it("removes a non-current session without disturbing the current pointer", async () => {
		await saveAuthSession({ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" }, options);
		await saveAuthSession({ tenantId: "tenant-b", userId: "user-2", accessToken: "token-b", expiresAt: "2099-01-01T00:00:00.000Z" }, options);

		await removeAuthSession("tenant-a", options);

		await expect(getCurrentAuthSession(options)).resolves.toMatchObject({ tenantId: "tenant-b" });
		const remaining = await listAuthSessions(options);
		expect(remaining.map((session) => session.tenantId)).toEqual(["tenant-b"]);
	});

	it("treats no cached credential as empty rather than throwing", async () => {
		await expect(listAuthSessions(options)).resolves.toEqual([]);
		await expect(getCurrentAuthSession(options)).resolves.toBeUndefined();
	});

	it("treats a corrupt cached credential as empty rather than throwing", async () => {
		await setCredential("agent-issues-auth", "sessions", "{ not valid json", options);

		await expect(listAuthSessions(options)).resolves.toEqual([]);
		await expect(getCurrentAuthSession(options)).resolves.toBeUndefined();
	});

	it("redacts the accessToken from a session view", () => {
		const view = toAuthSessionView({
			tenantId: "tenant-a",
			userId: "user-1",
			displayName: "Ada Lovelace",
			accessToken: "super-secret-token",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});

		expect(view).toEqual({
			tenantId: "tenant-a",
			userId: "user-1",
			displayName: "Ada Lovelace",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});
		expect(view).not.toHaveProperty("accessToken");
	});

	describe("migrating a pre-ISS185 plain-file session cache", () => {
		it("imports an existing plain-file cache into the credential store on first read, then deletes the plain file", async () => {
			mkdirSync(homeDirectory, { recursive: true });
			const legacyFilePath = path.join(homeDirectory, "auth.json");
			writeFileSync(
				legacyFilePath,
				JSON.stringify({
					currentTenantId: "tenant-a",
					sessions: {
						"tenant-a": { tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" }
					}
				}),
				"utf8"
			);

			const current = await getCurrentAuthSession(options);

			expect(current).toEqual({
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			});
			expect(existsSync(legacyFilePath)).toBe(false);

			// Second read must come from the credential store, not require the (now-deleted) plain file.
			await expect(getCurrentAuthSession(options)).resolves.toMatchObject({ tenantId: "tenant-a" });
		});

		it("does not touch the credential store when there is no legacy plain file", async () => {
			await expect(getCurrentAuthSession(options)).resolves.toBeUndefined();
		});
	});
});
