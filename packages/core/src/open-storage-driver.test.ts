import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindCloudProject } from "./cloud-binding.js";
import { HttpStore } from "./http-store.js";
import { openStorageDriver } from "./open-storage-driver.js";
import { resolveProjectIdentity } from "./project-identity.js";
import { saveAuthSession } from "./auth-session.js";
import { SqliteStore } from "./sqlite-store.js";

describe("openStorageDriver (ADR13, ADR18)", () => {
	let homeDirectory: string;
	let projectDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-storage-driver-home-"));
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-storage-driver-project-"));
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
		rmSync(projectDirectory, { recursive: true, force: true });
	});

	it("opens a SqliteStore when the project has no cloud binding", async () => {
		const result = await openStorageDriver({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			cloudBindingOptions: { homeDirectory },
			env: {}
		});

		try {
			expect(result.backend).toBe("local");
			expect(result.store).toBeInstanceOf(SqliteStore);
			expect(result.dbPath).toBeTruthy();
			expect(result.cloudConnection).toBeUndefined();
		} finally {
			await result.store.close();
		}
	});

	it("opens an HttpStore when the project is cloud-bound and a valid session is cached", async () => {
		const { identity: projectIdentity } = resolveProjectIdentity(projectDirectory);
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);
		saveAuthSession(
			{ tenantId: "tenant-a", userId: "user-1", accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z" },
			{ homeDirectory }
		);

		const result = await openStorageDriver({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			cloudBindingOptions: { homeDirectory },
			authSessionOptions: { homeDirectory },
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
		bindCloudProject(
			{ projectIdentity, cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" },
			{ homeDirectory }
		);

		await expect(
			openStorageDriver({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				cloudBindingOptions: { homeDirectory },
				authSessionOptions: { homeDirectory },
				env: {}
			})
		).rejects.toThrow(/auth login/);
	});

	it("throws the same clear error when the cached session for the bound tenant has expired", async () => {
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
			openStorageDriver({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				cloudBindingOptions: { homeDirectory },
				authSessionOptions: { homeDirectory },
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
			env: { AGENT_ISSUES_BACKEND: "local" }
		});

		try {
			expect(result.backend).toBe("local");
		} finally {
			await result.store.close();
		}
	});
});
