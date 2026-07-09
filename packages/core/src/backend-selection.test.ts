import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindCloudProject } from "./cloud-binding.js";
import { resolveBackendSelection } from "./backend-selection.js";

describe("backend-selection precedence (ADR18)", () => {
	let homeDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-backend-selection-"));
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("defaults to local when nothing is configured", () => {
		const selection = resolveBackendSelection({ projectIdentity: "my-project", env: {}, homeDirectory });

		expect(selection).toEqual({ backend: "local" });
	});

	it("resolves cloud from a per-project user-local binding", () => {
		bindCloudProject({ projectIdentity: "my-project", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }, { homeDirectory });

		const selection = resolveBackendSelection({ projectIdentity: "my-project", env: {}, homeDirectory });

		expect(selection).toEqual({
			backend: "cloud",
			binding: { projectIdentity: "my-project", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }
		});
	});

	it("an env var overrides a bound project back to local", () => {
		bindCloudProject({ projectIdentity: "my-project", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }, { homeDirectory });

		const selection = resolveBackendSelection({
			projectIdentity: "my-project",
			env: { AGENT_ISSUES_BACKEND: "local" },
			homeDirectory
		});

		expect(selection).toEqual({ backend: "local" });
	});

	it("an env var of cloud resolves cloud using the existing binding", () => {
		bindCloudProject({ projectIdentity: "my-project", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }, { homeDirectory });

		const selection = resolveBackendSelection({
			projectIdentity: "my-project",
			env: { AGENT_ISSUES_BACKEND: "cloud" },
			homeDirectory
		});

		expect(selection).toEqual({
			backend: "cloud",
			binding: { projectIdentity: "my-project", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }
		});
	});

	it("an explicit flag overrides both env var and binding", () => {
		bindCloudProject({ projectIdentity: "my-project", cloudApiUrl: "https://api.example.com", tenantId: "tenant-a" }, { homeDirectory });

		const selection = resolveBackendSelection({
			projectIdentity: "my-project",
			explicitBackend: "local",
			env: { AGENT_ISSUES_BACKEND: "cloud" },
			homeDirectory
		});

		expect(selection).toEqual({ backend: "local" });
	});

	it("rejects an explicit or env-forced cloud selection with no binding, naming the fix", () => {
		expect(() => resolveBackendSelection({ projectIdentity: "my-project", explicitBackend: "cloud", env: {}, homeDirectory })).toThrow(
			/cloud bind/
		);

		expect(() =>
			resolveBackendSelection({ projectIdentity: "my-project", env: { AGENT_ISSUES_BACKEND: "cloud" }, homeDirectory })
		).toThrow(/cloud bind/);
	});
});
