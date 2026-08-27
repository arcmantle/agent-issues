import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MCP_SERVER_NAME = "agent-issues";
const MCP_COMMAND = "agent-issues-mcp";
const MCP_MANIFEST_FILE_NAME = ".agent-issues-mcp.json";

type McpConfiguration = {
	servers?: Record<string, unknown>;
};

export type InstallMcpResult = {
	targetFile: string;
	server: {
		name: string;
		status: "installed" | "updated" | "skipped";
	};
};

export type UninstallMcpResult = {
	targetFile: string;
	server: {
		name: string;
		status: "removed" | "missing";
	};
};

export type ListMcpResult = {
	targetFile: string;
	server: {
		name: string;
		status: "installed" | "partial" | "missing";
	};
};

export function getDefaultMcpConfigFile(): string {
	return path.join(getVsCodeUserDirectory(), "mcp.json");
}

export function installMcp(input: { targetFile?: string; force?: boolean }): InstallMcpResult {
	const targetFile = path.resolve(input.targetFile ?? getDefaultMcpConfigFile());
	const configuration = readMcpConfiguration(targetFile);
	const servers = configuration.servers ?? {};
	const existing = servers[MCP_SERVER_NAME];

	if (existing !== undefined && !input.force) {
		return { targetFile, server: { name: MCP_SERVER_NAME, status: "skipped" } };
	}

	servers[MCP_SERVER_NAME] = createMcpServerConfiguration();
	configuration.servers = servers;

	mkdirSync(path.dirname(targetFile), { recursive: true });
	writeFileSync(targetFile, `${JSON.stringify(configuration, null, "\t")}\n`);
	writeMcpManifest(targetFile);

	return { targetFile, server: { name: MCP_SERVER_NAME, status: existing === undefined ? "installed" : "updated" } };
}

export function uninstallMcp(input: { targetFile?: string }): UninstallMcpResult {
	const targetFile = path.resolve(input.targetFile ?? getDefaultMcpConfigFile());
	const configuration = readMcpConfiguration(targetFile);
	const servers = configuration.servers ?? {};

	if (servers[MCP_SERVER_NAME] === undefined || !hasOwnedMcpServer(targetFile)) {
		return { targetFile, server: { name: MCP_SERVER_NAME, status: "missing" } };
	}

	delete servers[MCP_SERVER_NAME];
	configuration.servers = servers;
	writeFileSync(targetFile, `${JSON.stringify(configuration, null, "\t")}\n`);
	rmSync(getMcpManifestFile(targetFile), { force: true });

	return { targetFile, server: { name: MCP_SERVER_NAME, status: "removed" } };
}

export function listMcp(input: { targetFile?: string }): ListMcpResult {
	const targetFile = path.resolve(input.targetFile ?? getDefaultMcpConfigFile());
	const configuration = readMcpConfiguration(targetFile);
	const server = configuration.servers?.[MCP_SERVER_NAME];

	if (server === undefined) {
		return { targetFile, server: { name: MCP_SERVER_NAME, status: "missing" } };
	}

	return {
		targetFile,
		server: {
			name: MCP_SERVER_NAME,
			status: hasOwnedMcpServer(targetFile) && isInstalledMcpServer(server) ? "installed" : "partial"
		}
	};
}

function getVsCodeUserDirectory(): string {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
		return path.join(appData, "Code", "User");
	}

	if (process.platform === "darwin") {
		return path.join(homedir(), "Library", "Application Support", "Code", "User");
	}

	const configHome = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
	return path.join(configHome, "Code", "User");
}

function readMcpConfiguration(targetFile: string): McpConfiguration {
	if (!existsSync(targetFile)) {
		return {};
	}

	const parsed: unknown = JSON.parse(readFileSync(targetFile, "utf8"));
	if (!isJsonObject(parsed)) {
		throw new Error(`MCP configuration at ${targetFile} must be a JSON object.`);
	}
	if (!isMcpConfiguration(parsed)) {
		throw new Error(`MCP configuration at ${targetFile} must have an object servers value.`);
	}

	return parsed;
}

function isMcpConfiguration(value: unknown): value is McpConfiguration {
	if (!isJsonObject(value)) {
		return false;
	}

	return value.servers === undefined || isJsonObject(value.servers);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMcpManifestFile(targetFile: string): string {
	return path.join(path.dirname(targetFile), MCP_MANIFEST_FILE_NAME);
}

function hasOwnedMcpServer(targetFile: string): boolean {
	const manifestFile = getMcpManifestFile(targetFile);
	if (!existsSync(manifestFile)) {
		return false;
	}

	try {
		const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
		return typeof manifest === "object" && manifest !== null && (manifest as { server?: unknown }).server === MCP_SERVER_NAME;
	} catch {
		return false;
	}
}

function writeMcpManifest(targetFile: string): void {
	writeFileSync(getMcpManifestFile(targetFile), `${JSON.stringify({ server: MCP_SERVER_NAME }, null, "\t")}\n`);
}

function createMcpServerConfiguration(): Record<string, unknown> {
	return {
		command: MCP_COMMAND,
		cwd: "${workspaceFolder}",
		env: {
			AGENT_ISSUES_PROJECT_IDENTITY: "${config:agentIssues.projectIdentity}"
		},
		type: "stdio"
	};
}

function isInstalledMcpServer(server: unknown): boolean {
	return JSON.stringify(server) === JSON.stringify(createMcpServerConfiguration());
}