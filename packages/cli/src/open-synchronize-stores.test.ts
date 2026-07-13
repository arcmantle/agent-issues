import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpStore, type RunCredentialCommand } from "@agent-issues/core";
import { SqliteStore } from "@agent-issues/api-local";
import { saveAuthSession } from "./auth-session.js";
import { bindCloudProject } from "./cloud-binding.js";
import { openSynchronizeStores } from "./open-synchronize-stores.js";
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

describe("openSynchronizeStores (ISS59/ADR13, ADR18)", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let projectDirectory: string;
	let credentialStoreOptions: ReturnType<typeof fakeCredentialStore>;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-sync-stores-home-"));
		// See the identical comment in open-storage-driver.test.ts: the local
		// backend's SQLite db path only respects HOME, not
		// cloudBindingOptions/authSessionOptions, so it must be redirected here
		// too or the "opens a local SqliteStore..." case below pollutes the
		// developer's real ~/.agent-issues/agent-issues.db.
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-sync-stores-project-"));
		credentialStoreOptions = fakeCredentialStore();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { recursive: true, force: true });
		rmSync(projectDirectory, { recursive: true, force: true });
	});

	it("opens a local SqliteStore and a cloud HttpStore simultaneously when bound and a valid session is cached", async () => {
		const { identity: projectIdentity } = resolveProjectIdentity(projectDirectory);
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);
		await saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory, ...credentialStoreOptions }
		);

		const { local, cloud, binding } = await openSynchronizeStores({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			cloudBindingOptions: { homeDirectory },
			authSessionOptions: { homeDirectory, ...credentialStoreOptions },
			env: {}
		});

		try {
			expect(local).toBeInstanceOf(SqliteStore);
			expect(cloud).toBeInstanceOf(HttpStore);
			expect(cloud.tenantId).toBe("tenant-a");
			expect(binding).toEqual({ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" });
		} finally {
			await local.close();
			await cloud.close();
		}
	});

	it("throws the same clear error openStorageDriver uses when the project has no cloud binding", async () => {
		await expect(
			openSynchronizeStores({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				cloudBindingOptions: { homeDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions },
				env: {}
			})
		).rejects.toThrow(/cloud bind/);
	});

	it("throws the same clear error openStorageDriver uses when cloud-bound but no session is cached", async () => {
		const { identity: projectIdentity } = resolveProjectIdentity(projectDirectory);
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);

		await expect(
			openSynchronizeStores({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				cloudBindingOptions: { homeDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions },
				env: {}
			})
		).rejects.toThrow(/auth login/);
	});

	it("throws the same clear error openStorageDriver uses when the cached session has expired", async () => {
		const { identity: projectIdentity } = resolveProjectIdentity(projectDirectory);
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);
		await saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2000-01-01T00:00:00.000Z" },
			{ homeDirectory, ...credentialStoreOptions }
		);

		await expect(
			openSynchronizeStores({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				cloudBindingOptions: { homeDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions },
				env: {}
			})
		).rejects.toThrow(/auth login/);
	});
});
