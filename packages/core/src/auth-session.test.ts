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
	toAuthSessionView
} from "./auth-session.js";

describe("auth-session storage", () => {
	let homeDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auth-session-"));
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("saves a session and reads it back as the current session", () => {
		saveAuthSession(
			{
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			{ homeDirectory }
		);

		const current = getCurrentAuthSession({ homeDirectory });

		expect(current).toEqual({
			tenantId: "tenant-a",
			userId: "user-1",
			displayName: "Ada Lovelace",
			accessToken: "token-a",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});
	});

	it("returns undefined when no session has ever been saved", () => {
		expect(getCurrentAuthSession({ homeDirectory })).toBeUndefined();
	});

	it("lists every cached session, regardless of which is current", () => {
		saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);
		saveAuthSession(
			{ tenantId: "tenant-b", userId: "user-2", accessToken: "token-b", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);

		const sessions = listAuthSessions({ homeDirectory });

		expect(sessions.map((session) => session.tenantId).sort()).toEqual(["tenant-a", "tenant-b"]);
	});

	it("switches the current tenant to an already-cached session without touching its accessToken", () => {
		saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);
		saveAuthSession(
			{ tenantId: "tenant-b", userId: "user-2", accessToken: "token-b", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);

		const switched = switchAuthSession("tenant-a", { homeDirectory });

		expect(switched).toEqual({
			tenantId: "tenant-a",
			userId: "user-1",
			accessToken: "token-a",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});
		expect(getCurrentAuthSession({ homeDirectory })?.tenantId).toBe("tenant-a");
	});

	it("throws when switching to a tenant with no cached session", () => {
		expect(() => switchAuthSession("tenant-unknown", { homeDirectory })).toThrow(/No cached auth session/);
	});

	it("removes a session and clears the current pointer if it was current", () => {
		saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);

		removeAuthSession("tenant-a", { homeDirectory });

		expect(getCurrentAuthSession({ homeDirectory })).toBeUndefined();
		expect(listAuthSessions({ homeDirectory })).toEqual([]);
	});

	it("removes a non-current session without disturbing the current pointer", () => {
		saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);
		saveAuthSession(
			{ tenantId: "tenant-b", userId: "user-2", accessToken: "token-b", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);

		removeAuthSession("tenant-a", { homeDirectory });

		expect(getCurrentAuthSession({ homeDirectory })?.tenantId).toBe("tenant-b");
		expect(listAuthSessions({ homeDirectory }).map((session) => session.tenantId)).toEqual(["tenant-b"]);
	});

	it("treats a missing session file as empty rather than throwing", () => {
		expect(listAuthSessions({ homeDirectory })).toEqual([]);
		expect(getCurrentAuthSession({ homeDirectory })).toBeUndefined();
	});

	it("treats a corrupt session file as empty rather than throwing", () => {
		mkdirSync(homeDirectory, { recursive: true });
		writeFileSync(path.join(homeDirectory, "auth.json"), "{ not valid json", "utf8");

		expect(listAuthSessions({ homeDirectory })).toEqual([]);
		expect(getCurrentAuthSession({ homeDirectory })).toBeUndefined();
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
});
