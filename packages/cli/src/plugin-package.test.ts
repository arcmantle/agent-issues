import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let targetDir: string | null = null;

afterEach(() => {
	if (targetDir) {
		rmSync(targetDir, { force: true, recursive: true });
		targetDir = null;
	}
});

describe("portable plugin package", () => {
	it("assembles every canonical skill with portable metadata and a pinned MCP server", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");
		mkdirSync(pluginDir);

		buildPlugin(pluginDir);

		const sourceSkills = readdirSync("skills", { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					entry.name.startsWith("ai-") &&
					existsSync(path.join("skills", entry.name, "SKILL.md"))
			)
			.map((entry) => entry.name)
			.sort();
		const packagedSkills = readdirSync(path.join(pluginDir, "skills"), { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					existsSync(path.join(pluginDir, "skills", entry.name, "SKILL.md"))
			)
			.map((entry) => entry.name)
			.sort();

		expect(packagedSkills).toEqual(sourceSkills);
		expect(readFileSync(path.join(pluginDir, "skills", "agent-issues-language.md"), "utf8")).toContain(
			"# Language standard"
		);
		expect(readFileSync(path.join(pluginDir, "skills", "agent-issues-operating-contract.md"), "utf8")).toContain(
			"# Shared Skill Operating Contract"
		);
		const operatingContract = readFileSync(
			path.join(pluginDir, "skills", "agent-issues-operating-contract.md"),
			"utf8"
		);
		for (const removedCommand of ["install-vscode", "update-vscode", "list-vscode", "uninstall-vscode"]) {
			expect(operatingContract).not.toContain(removedCommand);
		}
		expect(readFileSync(path.join(pluginDir, "skills", "recipes", "README.md"), "utf8")).toContain(
			"# Record Body Recipe Catalog"
		);
		const sourceRecipes = readdirSync(path.join("skills", "recipes")).sort();
		const packagedRecipes = readdirSync(path.join(pluginDir, "skills", "recipes")).sort();
		expect(packagedRecipes).toEqual(sourceRecipes);

		const manifest = JSON.parse(readFileSync(path.join(pluginDir, "plugin.json"), "utf8")) as {
			$schema?: unknown;
			name?: unknown;
			agents?: unknown;
		};
		expect(manifest).toMatchObject({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: "agent-issues"
		});
		expect(manifest.agents).toBeUndefined();

		const mcpConfiguration = JSON.parse(readFileSync(path.join(pluginDir, "mcp.json"), "utf8")) as {
			$schema?: unknown;
			mcpServers?: Record<string, { type?: unknown; command?: unknown; args?: unknown }>;
		};
		expect(mcpConfiguration.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
		expect(mcpConfiguration.mcpServers?.["agent-issues"]).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "agent-issues-mcp@0.1.1"]
		});
	});

	it("adds the Claude Code manifest, agent, and MCP adapter", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");

		buildPlugin(pluginDir);

		const manifest = JSON.parse(
			readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")
		) as { name?: unknown; agents?: unknown };
		expect(manifest.name).toBe("agent-issues");
		expect(manifest.agents).toBeUndefined();
		expect(readFileSync(path.join(pluginDir, ".mcp.json"), "utf8")).toBe(
			readFileSync(path.join(pluginDir, "mcp.json"), "utf8")
		);
		const agentPath = path.join(pluginDir, "agents", "agent-issues.md");
		const agentContent = readFileSync(agentPath, "utf8");
		expect(agentContent).toContain(
			"You are the issue-first implementation agent for this workspace."
		);
		expect(agentContent).toContain("[language standard](../skills/agent-issues-language.md)");
		expect(existsSync(path.resolve(path.dirname(agentPath), "../skills/agent-issues-language.md"))).toBe(true);
	});

	it("adds a Claude marketplace that installs the package root", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");

		buildPlugin(pluginDir);

		const marketplace = JSON.parse(
			readFileSync(path.join(pluginDir, ".claude-plugin", "marketplace.json"), "utf8")
		) as {
			name?: unknown;
			plugins?: unknown;
		};
		expect(marketplace).toMatchObject({
			name: "agent-issues",
			plugins: [{ name: "agent-issues", source: "./" }]
		});
	});

	it("adds the Copilot agent and marketplace adapter", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");

		buildPlugin(pluginDir);

		const copilotManifest = JSON.parse(
			readFileSync(path.join(pluginDir, ".plugin", "plugin.json"), "utf8")
		) as { name?: unknown; agents?: unknown };
		expect(copilotManifest).toMatchObject({
			name: "agent-issues",
			agents: "agents/copilot/"
		});
		const { agents, ...copilotPortableFields } = copilotManifest;
		const portableManifest = JSON.parse(
			readFileSync(path.join(pluginDir, "plugin.json"), "utf8")
		) as Record<string, unknown>;
		expect(agents).toBe("agents/copilot/");
		expect(copilotPortableFields).toEqual(portableManifest);
		const agentPath = path.join(pluginDir, "agents", "copilot", "agent-issues.agent.md");
		const agentContent = readFileSync(agentPath, "utf8");
		expect(agentContent).toContain(
			"You are the issue-first implementation agent for this workspace."
		);
		expect(agentContent).toContain("[language standard](../../skills/agent-issues-language.md)");
		expect(existsSync(path.resolve(path.dirname(agentPath), "../../skills/agent-issues-language.md"))).toBe(true);
		const portableCopilotAgentPath = path.join(
			pluginDir,
			"com.github.copilot",
			"agents",
			"agent-issues.agent.md"
		);
		expect(readFileSync(portableCopilotAgentPath, "utf8")).toBe(agentContent);
		expect(
			existsSync(path.resolve(path.dirname(portableCopilotAgentPath), "../../skills/agent-issues-language.md"))
		).toBe(true);

		const marketplace = JSON.parse(
			readFileSync(path.join(pluginDir, ".github", "plugin", "marketplace.json"), "utf8")
		) as {
			name?: unknown;
			plugins?: unknown;
		};
		const manifest = JSON.parse(readFileSync(path.join(pluginDir, "plugin.json"), "utf8")) as {
			version?: unknown;
		};
		expect(marketplace).toMatchObject({
			name: "agent-issues",
			plugins: [{ name: "agent-issues", source: "./", version: manifest.version }]
		});
	});

	it("rejects an unpinned MCP package", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");
		buildPlugin(pluginDir);
		const mcpPath = path.join(pluginDir, "mcp.json");
		const mcpConfiguration = JSON.parse(readFileSync(mcpPath, "utf8")) as {
			mcpServers: Record<string, { args: string[] }>;
		};
		mcpConfiguration.mcpServers["agent-issues"].args = ["-y", "agent-issues-mcp"];
		writeFileSync(mcpPath, JSON.stringify(mcpConfiguration));

		const validation = spawnSync(
			process.execPath,
			["scripts/build-plugin.mjs", "--validate-dir", pluginDir],
			{ encoding: "utf8" }
		);

		expect(validation.status).toBe(1);
		expect(validation.stderr).toContain("must pin agent-issues-mcp to an explicit version");
	});

	it("rejects a missing canonical shared asset", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const sourceDir = path.join(targetDir, "source");
		const pluginDir = path.join(targetDir, "plugin");
		mkdirSync(sourceDir);
		cpSync("skills", path.join(sourceDir, "skills"), { recursive: true });
		cpSync("package.json", path.join(sourceDir, "package.json"));
		rmSync(path.join(sourceDir, "skills", "agent-issues-operating-contract.md"));

		const build = spawnSync(
			process.execPath,
			[
				"scripts/build-plugin.mjs",
				"--source-dir",
				sourceDir,
				"--target-dir",
				pluginDir
			],
			{ encoding: "utf8" }
		);

		expect(build.status).toBe(1);
		expect(build.stderr).toContain("Required plugin asset not found");
		expect(existsSync(pluginDir)).toBe(false);
	});

	it("rejects a field outside the portable manifest schema", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");
		buildPlugin(pluginDir);
		const manifestPath = path.join(pluginDir, "plugin.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.skills = "./skills/";
		writeFileSync(manifestPath, JSON.stringify(manifest));

		const validation = spawnSync(
			process.execPath,
			["scripts/build-plugin.mjs", "--validate-dir", pluginDir],
			{ encoding: "utf8" }
		);

		expect(validation.status).toBe(1);
		expect(validation.stderr).toContain("unsupported portable field: skills");
	});

	it("pins the published MCP package version independently of the plugin version", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const sourceDir = path.join(targetDir, "source");
		const pluginDir = path.join(targetDir, "plugin");
		const mcpPackagePath = path.join(targetDir, "mcp-package.json");
		mkdirSync(sourceDir);
		cpSync("skills", path.join(sourceDir, "skills"), { recursive: true });
		mkdirSync(path.join(sourceDir, ".github", "agents"), { recursive: true });
		cpSync(
			path.join(".github", "agents", "agent-issues.claude.md"),
			path.join(sourceDir, ".github", "agents", "agent-issues.claude.md")
		);
		cpSync(
			path.join(".github", "agents", "agent-issues.agent.md"),
			path.join(sourceDir, ".github", "agents", "agent-issues.agent.md")
		);
		writeFileSync(path.join(sourceDir, "package.json"), JSON.stringify({ version: "2.0.0" }));
		writeFileSync(mcpPackagePath, JSON.stringify({ version: "1.4.0" }));

		execFileSync(
			process.execPath,
			[
				"scripts/build-plugin.mjs",
				"--source-dir",
				sourceDir,
				"--target-dir",
				pluginDir,
				"--mcp-package-json",
				mcpPackagePath
			],
			{ stdio: "pipe" }
		);

		const manifest = JSON.parse(readFileSync(path.join(pluginDir, "plugin.json"), "utf8")) as {
			version: string;
		};
		const mcpConfiguration = JSON.parse(readFileSync(path.join(pluginDir, "mcp.json"), "utf8")) as {
			mcpServers: Record<string, { args: string[] }>;
		};
		expect(manifest.version).toBe("2.0.0");
		expect(mcpConfiguration.mcpServers["agent-issues"].args).toContain("agent-issues-mcp@1.4.0");
	});
});

function buildPlugin(pluginDir: string): void {
	execFileSync(
		process.execPath,
		[
			"scripts/build-plugin.mjs",
			"--source-dir",
			process.cwd(),
			"--target-dir",
			pluginDir
		],
		{ stdio: "pipe" }
	);
}