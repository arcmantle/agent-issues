import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const SHARED_SKILL_FILES = ["agent-issues-language.md", "agent-issues-operating-contract.md"];
const RECIPES_DIR = "recipes";
const REQUIRED_SHARED_PATHS = [
	...SHARED_SKILL_FILES,
	path.join(RECIPES_DIR, "README.md")
];
const PLUGIN_FIELDS = new Set([
	"$schema",
	"name",
	"version",
	"description",
	"author",
	"homepage",
	"repository",
	"license",
	"keywords",
	"extensions"
]);

export function buildPlugin({ sourceDir, targetDir }) {
	const sourceRoot = path.resolve(sourceDir);
	const outputRoot = path.resolve(targetDir);
	const sourceSkillsDir = path.join(sourceRoot, "skills");
	const sourcePluginReadme = path.join(sourceRoot, "plugin", "README.md");
	const sourceClaudeAgent = path.join(sourceRoot, ".github", "agents", "agent-issues.claude.md");
	const sourceCopilotAgent = path.join(sourceRoot, ".github", "agents", "agent-issues.agent.md");
	const packageJsonPath = path.join(sourceRoot, "package.json");

	assertFile(packageJsonPath);
	assertFile(sourcePluginReadme);
	assertFile(sourceClaudeAgent);
	assertFile(sourceCopilotAgent);
	if (!existsSync(sourceSkillsDir)) {
		throw new Error(`Canonical skills directory not found: ${sourceSkillsDir}`);
	}
	for (const relativePath of REQUIRED_SHARED_PATHS) {
		assertFile(path.join(sourceSkillsDir, relativePath));
	}

	const skillNames = readdirSync(sourceSkillsDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(path.join(sourceSkillsDir, entry.name, "SKILL.md"))
		)
		.map((entry) => entry.name)
		.sort();
	if (skillNames.length === 0) {
		throw new Error(`No Agent Issues skills found in: ${sourceSkillsDir}`);
	}

	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
		throw new Error(`Package version not found in: ${packageJsonPath}`);
	}

	rmSync(outputRoot, { force: true, recursive: true });
	cpSync(sourcePluginReadme, path.join(outputRoot, "README.md"));
	const outputSkillsDir = path.join(outputRoot, "skills");
	mkdirSync(outputSkillsDir, { recursive: true });
	for (const skillName of skillNames) {
		cpSync(path.join(sourceSkillsDir, skillName), path.join(outputSkillsDir, skillName), { recursive: true });
	}
	for (const sharedPath of SHARED_SKILL_FILES) {
		cpSync(path.join(sourceSkillsDir, sharedPath), path.join(outputSkillsDir, sharedPath), { recursive: true });
	}
	cpSync(path.join(sourceSkillsDir, RECIPES_DIR), path.join(outputSkillsDir, RECIPES_DIR), { recursive: true });
	const pluginManifest = {
		$schema: PLUGIN_SCHEMA,
		name: "agent-issues",
		version: packageJson.version,
		description: "Agent Issues workflow skills and MCP tools.",
		author: { name: "Agent Issues contributors" },
		repository: "https://github.com/arcmantle/agent-issues",
		license: "MIT",
		keywords: ["agent-issues", "issue-tracking", "mcp"]
	};
	const mcpConfiguration = {
		$schema: MCP_SCHEMA,
		mcpServers: {
			"agent-issues": {
				type: "stdio",
				command: "agent-issues-mcp",
				args: []
			}
		}
	};
	writeJson(path.join(outputRoot, "plugin.json"), pluginManifest);
	writeJson(path.join(outputRoot, "mcp.json"), mcpConfiguration);
	mkdirSync(path.join(outputRoot, ".claude-plugin"), { recursive: true });
	writeJson(path.join(outputRoot, ".claude-plugin", "plugin.json"), pluginManifest);
	writeJson(path.join(outputRoot, ".claude-plugin", "marketplace.json"), {
		name: "agent-issues",
		description: "Agent Issues plugins for agent integrations.",
		owner: { name: "Agent Issues contributors" },
		plugins: [{ name: "agent-issues", source: "./", version: packageJson.version }]
	});
	mkdirSync(path.join(outputRoot, ".plugin"), { recursive: true });
	writeJson(path.join(outputRoot, ".plugin", "plugin.json"), {
		...pluginManifest,
		agents: "agents/copilot/"
	});
	mkdirSync(path.join(outputRoot, ".github", "plugin"), { recursive: true });
	writeJson(path.join(outputRoot, ".github", "plugin", "marketplace.json"), {
		name: "agent-issues",
		owner: { name: "Agent Issues contributors" },
		metadata: { description: "Agent Issues plugins for agent integrations." },
		plugins: [{ name: "agent-issues", source: "./", version: packageJson.version }]
	});
	writeJson(path.join(outputRoot, ".mcp.json"), mcpConfiguration);
	mkdirSync(path.join(outputRoot, "agents"), { recursive: true });
	mkdirSync(path.join(outputRoot, "agents", "copilot"), { recursive: true });
	mkdirSync(path.join(outputRoot, "com.github.copilot", "agents"), { recursive: true });
	const sourceClaudeAgentContent = readFileSync(sourceClaudeAgent, "utf8");
	const packagedClaudeAgentContent = sourceClaudeAgentContent.replace(
		"(../../skills/agent-issues-language.md)",
		"(../skills/agent-issues-language.md)"
	);
	if (packagedClaudeAgentContent === sourceClaudeAgentContent) {
		throw new Error(`Claude agent language standard link not found: ${sourceClaudeAgent}`);
	}
	writeFileSync(path.join(outputRoot, "agents", "agent-issues.md"), packagedClaudeAgentContent);
	const sourceCopilotAgentContent = readFileSync(sourceCopilotAgent, "utf8");
	const packagedCopilotAgentContent = sourceCopilotAgentContent;
	writeFileSync(
		path.join(outputRoot, "agents", "copilot", "agent-issues.agent.md"),
		packagedCopilotAgentContent
	);
	writeFileSync(
		path.join(outputRoot, "com.github.copilot", "agents", "agent-issues.agent.md"),
		packagedCopilotAgentContent
	);
	validatePlugin(outputRoot);

	return { outputRoot, skillNames, version: packageJson.version };
}

export function validatePlugin(pluginDir) {
	const pluginRoot = path.resolve(pluginDir);
	const manifest = readJsonObject(path.join(pluginRoot, "plugin.json"));
	assertExactValue(manifest.$schema, PLUGIN_SCHEMA, "plugin.json $schema");
	assertExactValue(manifest.name, "agent-issues", "plugin.json name");
	if (typeof manifest.version !== "string" || manifest.version.length === 0) {
		throw new Error("plugin.json version must be a non-empty string");
	}
	for (const field of Object.keys(manifest)) {
		if (!PLUGIN_FIELDS.has(field)) {
			throw new Error(`plugin.json contains unsupported portable field: ${field}`);
		}
	}

	const skillsDir = path.join(pluginRoot, "skills");
	assertFile(path.join(pluginRoot, "README.md"));
	assertFile(path.join(pluginRoot, "com.github.copilot", "agents", "agent-issues.agent.md"));
	for (const relativePath of REQUIRED_SHARED_PATHS) {
		assertFile(path.join(skillsDir, relativePath));
	}
	const skillNames = readdirSync(skillsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(path.join(skillsDir, entry.name, "SKILL.md")))
		.map((entry) => entry.name);
	if (skillNames.length === 0) {
		throw new Error(`No packaged Agent Issues skills found in: ${skillsDir}`);
	}

	const mcpConfiguration = readJsonObject(path.join(pluginRoot, "mcp.json"));
	assertExactValue(mcpConfiguration.$schema, MCP_SCHEMA, "mcp.json $schema");
	if (!isObject(mcpConfiguration.mcpServers)) {
		throw new Error("mcp.json mcpServers must be an object");
	}
	const server = mcpConfiguration.mcpServers["agent-issues"];
	if (!isObject(server)) {
		throw new Error("mcp.json must define the agent-issues server");
	}
	assertExactValue(server.type, "stdio", "agent-issues MCP server type");
	assertExactValue(server.command, "agent-issues-mcp", "agent-issues MCP server command");
	if (!Array.isArray(server.args) || server.args.length !== 0) {
		throw new Error("agent-issues MCP server must not have arguments");
	}

	return { pluginRoot, skillNames: skillNames.sort(), version: manifest.version };
}

function assertFile(filePath) {
	if (!existsSync(filePath)) {
		throw new Error(`Required plugin asset not found: ${filePath}`);
	}
}

function writeJson(filePath, value) {
	writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

function readJsonObject(filePath) {
	assertFile(filePath);
	const value = JSON.parse(readFileSync(filePath, "utf8"));
	if (!isObject(value)) {
		throw new Error(`JSON file must contain an object: ${filePath}`);
	}
	return value;
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactValue(actual, expected, label) {
	if (actual !== expected) {
		throw new Error(`${label} must be ${expected}`);
	}
}

function readArgument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1]) {
		throw new Error(`Missing required argument: ${name}`);
	}
	return process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--validate-dir")) {
		validatePlugin(readArgument("--validate-dir"));
	} else {
		buildPlugin({
			sourceDir: readArgument("--source-dir"),
			targetDir: readArgument("--target-dir")
		});
	}
}