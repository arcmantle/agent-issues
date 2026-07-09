import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installAgent, listAgent, uninstallAgent } from "./agent-installer.js";

let tempDir: string | null = null;

function createTargetDir(): string {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-agent-install-"));
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("agent installer", () => {
	it("installs the packaged custom agent and rewrites the hook path for the target directory", () => {
		const targetDir = createTargetDir();
		const result = installAgent({ targetDir });
		const installedAgent = readFileSync(result.installed.agentFile, "utf8");
		const expectedHookCommand = JSON.stringify(`node \"${result.installed.hookFile}\"`);

		expect(result.installed.status).toBe("installed");
		expect(existsSync(result.installed.agentFile)).toBe(true);
		expect(existsSync(result.installed.hookFile)).toBe(true);
		expect(installedAgent).toContain(`command: ${expectedHookCommand}`);
		expect(installedAgent).not.toContain("node .github/hooks/agent-issues-enforcer.mjs");
	});

	it("reports a partial install when only one installed file exists", () => {
		const targetDir = createTargetDir();
		const result = installAgent({ targetDir });
		rmSync(result.installed.hookFile, { force: true });

		expect(listAgent({ targetDir }).agent.status).toBe("partial");
	});

	it("uninstalls both installed files", () => {
		const targetDir = createTargetDir();
		const result = installAgent({ targetDir });
		const removed = uninstallAgent({ targetDir });

		expect(removed.removed.status).toBe("removed");
		expect(existsSync(result.installed.agentFile)).toBe(false);
		expect(existsSync(result.installed.hookFile)).toBe(false);
		expect(listAgent({ targetDir }).agent.status).toBe("missing");
	});
});