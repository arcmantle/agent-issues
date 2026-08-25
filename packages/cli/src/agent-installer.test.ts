import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getDefaultAgentInstallDir, getDefaultAgentInstallDirs, installAgent, listAgent, uninstallAgent } from "./agent-installer.js";

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
	it("uses the conventional user directories for VS Code, Copilot, and Claude", () => {
		expect(getDefaultAgentInstallDirs()).toEqual({
			claude: path.join(homedir(), ".claude", "agents"),
			copilot: path.join(homedir(), ".copilot", "agents"),
			vscode: getDefaultAgentInstallDir()
		});
	});

	it("installs default agents for Copilot and Claude", () => {
		const previousHome = process.env.HOME;
		const homeDirectory = createTargetDir();
		process.env.HOME = homeDirectory;

		try {
			const result = installAgent({});
			const copilotAgentFile = path.join(homeDirectory, ".copilot", "agents", "agent-issues.agent.md");
			const claudeAgentFile = path.join(homeDirectory, ".claude", "agents", "agent-issues.md");
			const refreshed = installAgent({ force: true });
			const installed = listAgent({});

			expect(result.additionalInstalled.map((item) => item.host)).toEqual(["copilot", "claude"]);
			expect(existsSync(copilotAgentFile)).toBe(true);
			expect(existsSync(claudeAgentFile)).toBe(true);
			expect(readFileSync(claudeAgentFile, "utf8")).toContain(
				"Follow the shared [language standard](./agent-issues-language.md)."
			);
			expect(readFileSync(claudeAgentFile, "utf8")).toContain(
				"Do not preserve obsolete code, features, compatibility paths, or public APIs solely because an old test expects them."
			);
			expect(readFileSync(claudeAgentFile, "utf8")).toContain(
				"- any remaining gap between the current code and the issue scope"
			);
			expect(refreshed.additionalInstalled.map((item) => item.status)).toEqual(["updated", "updated"]);
			expect(installed.agent.status).toBe("installed");
			expect(installed.additionalAgents.map((item) => item.status)).toEqual(["installed", "installed"]);
			const removed = uninstallAgent({});
			expect(removed.additionalRemoved.map((item) => item.status)).toEqual(["removed", "removed"]);
			expect(existsSync(copilotAgentFile)).toBe(false);
			expect(existsSync(claudeAgentFile)).toBe(false);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});

	it("installs the packaged custom agent for the target directory", () => {
		const targetDir = createTargetDir();
		const result = installAgent({ targetDir });
		const installedAgent = readFileSync(result.installed.agentFile, "utf8");
		const languageFile = path.join(targetDir, "agent-issues-language.md");
		const recipesDirectory = path.join(targetDir, "recipes");

		expect(result.installed.status).toBe("installed");
		expect(existsSync(result.installed.agentFile)).toBe(true);
		expect(existsSync(path.join(recipesDirectory, "README.md"))).toBe(true);
		expect(existsSync(path.join(recipesDirectory, "user-story.md"))).toBe(true);
		expect(installedAgent).toContain("agent");
		expect(installedAgent).toContain("web");
		expect(installedAgent).toContain("./agent-issues-language.md");
		expect(readFileSync(languageFile, "utf8")).toContain("# Language standard");
	});

	it("removes a stale hook file when it force-updates an agent", () => {
		const targetDir = createTargetDir();
		const result = installAgent({ targetDir });
		const legacyHookFile = path.join(targetDir, "agent-issues-enforcer.mjs");
		writeFileSync(legacyHookFile, "legacy hook");

		installAgent({ targetDir, force: true });

		expect(existsSync(result.installed.agentFile)).toBe(true);
		expect(existsSync(legacyHookFile)).toBe(false);
	});

	it("reports a partial install when the recipe catalog is missing", () => {
		const targetDir = createTargetDir();
		const result = installAgent({ targetDir });
		rmSync(path.join(targetDir, "recipes"), { force: true, recursive: true });

		expect(listAgent({ targetDir }).agent.status).toBe("partial");
	});

	it("uninstalls both installed files", () => {
		const targetDir = createTargetDir();
		const result = installAgent({ targetDir });
		const legacyHookFile = path.join(targetDir, "agent-issues-enforcer.mjs");
		writeFileSync(legacyHookFile, "legacy hook");
		const removed = uninstallAgent({ targetDir });

		expect(removed.removed.status).toBe("removed");
		expect(existsSync(result.installed.agentFile)).toBe(false);
		expect(existsSync(legacyHookFile)).toBe(false);
		expect(existsSync(path.join(targetDir, "agent-issues-language.md"))).toBe(false);
		expect(existsSync(path.join(targetDir, "recipes"))).toBe(false);
		expect(listAgent({ targetDir }).agent.status).toBe("missing");
	});

	it("preserves a pre-existing recipe catalog that it does not own", () => {
		const targetDir = createTargetDir();
		const recipesDirectory = path.join(targetDir, "recipes");
		const customRecipe = path.join(recipesDirectory, "custom.md");
		mkdirSync(recipesDirectory);
		writeFileSync(customRecipe, "custom recipe");

		installAgent({ targetDir });
		expect(listAgent({ targetDir }).agent.status).toBe("partial");
		uninstallAgent({ targetDir });

		expect(readFileSync(customRecipe, "utf8")).toBe("custom recipe");
		expect(existsSync(path.join(recipesDirectory, "README.md"))).toBe(false);
	});

	it("updates an installer-owned recipe catalog with force", () => {
		const targetDir = createTargetDir();
		const recipesDirectory = path.join(targetDir, "recipes");
		installAgent({ targetDir });
		writeFileSync(path.join(recipesDirectory, "custom.md"), "temporary recipe");

		const result = installAgent({ targetDir, force: true });

		expect(result.installed.status).toBe("updated");
		expect(existsSync(path.join(recipesDirectory, "README.md"))).toBe(true);
		expect(existsSync(path.join(recipesDirectory, "custom.md"))).toBe(false);
	});

	it("treats a malformed recipe catalog ownership marker as unowned", () => {
		const targetDir = createTargetDir();
		const recipesDirectory = path.join(targetDir, "recipes");
		installAgent({ targetDir });
		writeFileSync(path.join(targetDir, ".agent-issues-agent-files.json"), "not JSON");

		expect(listAgent({ targetDir }).agent.status).toBe("partial");
		uninstallAgent({ targetDir });
		expect(existsSync(recipesDirectory)).toBe(true);
	});
});