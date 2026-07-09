import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindCloudProject, getCloudBinding, listCloudBindings, unbindCloudProject } from "./cloud-binding.js";

describe("cloud-binding storage", () => {
	let homeDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-binding-"));
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("returns undefined for a project with no binding", () => {
		expect(getCloudBinding("my-project", { homeDirectory })).toBeUndefined();
	});

	it("binds a project and reads the binding back, keyed by project identity", () => {
		bindCloudProject({ projectIdentity: "my-project", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }, { homeDirectory });

		expect(getCloudBinding("my-project", { homeDirectory })).toEqual({
			projectIdentity: "my-project",
			cloudApiUrl: "https://api.example.com",
			tenantId: "tenant-a"
		});
	});

	it("keeps bindings for different projects independent", () => {
		bindCloudProject({ projectIdentity: "project-a", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }, { homeDirectory });
		bindCloudProject({ projectIdentity: "project-b", cloudApiUrl: "https://api.example.com", tenantId: "tenant-b" }, { homeDirectory });

		expect(getCloudBinding("project-a", { homeDirectory })?.tenantId).toBe("tenant-a");
		expect(getCloudBinding("project-b", { homeDirectory })?.tenantId).toBe("tenant-b");
	});

	it("re-binding a project overwrites its previous binding", () => {
		bindCloudProject({ projectIdentity: "my-project", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }, { homeDirectory });
		bindCloudProject({ projectIdentity: "my-project", cloudApiUrl: "https://api2.example.com", tenantId: "tenant-b" }, { homeDirectory });

		expect(getCloudBinding("my-project", { homeDirectory })).toEqual({
			projectIdentity: "my-project",
			cloudApiUrl: "https://api2.example.com",
			tenantId: "tenant-b"
		});
	});

	it("unbinds a project, leaving it with no binding again", () => {
		bindCloudProject({ projectIdentity: "my-project", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }, { homeDirectory });

		unbindCloudProject("my-project", { homeDirectory });

		expect(getCloudBinding("my-project", { homeDirectory })).toBeUndefined();
	});

	it("unbinding a project with no binding is a harmless no-op", () => {
		expect(() => unbindCloudProject("never-bound", { homeDirectory })).not.toThrow();
	});

	it("lists every bound project", () => {
		bindCloudProject({ projectIdentity: "project-a", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }, { homeDirectory });
		bindCloudProject({ projectIdentity: "project-b", cloudApiUrl: "https://api.example.com", tenantId: "tenant-b" }, { homeDirectory });

		expect(listCloudBindings({ homeDirectory }).map((binding) => binding.projectIdentity).sort()).toEqual(["project-a", "project-b"]);
	});
});
