import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindCloudProject } from "./cloud-binding.js";
import { HttpStore } from "./http-store.js";
import { openSynchronizeStores } from "./open-synchronize-stores.js";
import { resolveProjectIdentity } from "./project-identity.js";
import { saveAuthSession } from "./auth-session.js";
import { SqliteStore } from "./sqlite-store.js";

describe("openSynchronizeStores (ISS59/ADR13, ADR18)", () => {
	let homeDirectory: string;
	let projectDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-sync-stores-home-"));
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-sync-stores-project-"));
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
		rmSync(projectDirectory, { recursive: true, force: true });
	});

	it("opens a local SqliteStore and a cloud HttpStore simultaneously when bound and a valid session is cached", async () => {
		const { identity: projectIdentity } = resolveProjectIdentity(projectDirectory);
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);
		saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);

		const { local, cloud, binding } = await openSynchronizeStores({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			cloudBindingOptions: { homeDirectory },
			authSessionOptions: { homeDirectory },
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
				authSessionOptions: { homeDirectory },
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
				authSessionOptions: { homeDirectory },
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
		saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2000-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);

		await expect(
			openSynchronizeStores({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				cloudBindingOptions: { homeDirectory },
				authSessionOptions: { homeDirectory },
				env: {}
			})
		).rejects.toThrow(/auth login/);
	});
});
