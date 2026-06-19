import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const AGENT_FILE_NAME = "agent-issues.agent.md";
const HOOK_FILE_NAME = "agent-issues-enforcer.mjs";
const INSTALLED_AGENT_NAME = "agent-issues";

type AgentInstallRecord = {
	installedName: string;
	agentFile: string;
	hookFile: string;
};

export type InstallAgentResult = {
	targetDir: string;
	installed: AgentInstallRecord & { status: "installed" | "updated" | "skipped" };
};

export type UninstallAgentResult = {
	targetDir: string;
	removed: AgentInstallRecord & { status: "removed" | "missing" };
};

export type ListAgentResult = {
	targetDir: string;
	agent: AgentInstallRecord & { status: "installed" | "partial" | "missing" };
};

export function getDefaultAgentInstallDir(): string {
	return path.join(homedir(), "Library", "Application Support", "Code", "User", "prompts");
}

export function installAgent(input: { targetDir?: string; force?: boolean }): InstallAgentResult {
	const targetDir = path.resolve(input.targetDir ?? getDefaultAgentInstallDir());
	const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".github");
	const sourceAgentFile = path.join(sourceRoot, "agents", AGENT_FILE_NAME);
	const sourceHookFile = path.join(sourceRoot, "hooks", HOOK_FILE_NAME);
	const destinationAgentFile = path.join(targetDir, AGENT_FILE_NAME);
	const destinationHookFile = path.join(targetDir, HOOK_FILE_NAME);
	const existed = existsSync(destinationAgentFile) || existsSync(destinationHookFile);

	if (!existsSync(sourceAgentFile) || !existsSync(sourceHookFile)) {
		throw new Error(`Packaged agent assets not found under ${sourceRoot}`);
	}

	mkdirSync(targetDir, { recursive: true });

	if (existed && !input.force) {
		return {
			targetDir,
			installed: {
				installedName: INSTALLED_AGENT_NAME,
				agentFile: destinationAgentFile,
				hookFile: destinationHookFile,
				status: "skipped"
			}
		};
	}

	cpSync(sourceAgentFile, destinationAgentFile);
	cpSync(sourceHookFile, destinationHookFile);
	rewriteInstalledAgentHooks(destinationAgentFile, destinationHookFile);

	return {
		targetDir,
		installed: {
			installedName: INSTALLED_AGENT_NAME,
			agentFile: destinationAgentFile,
			hookFile: destinationHookFile,
			status: existed ? "updated" : "installed"
		}
	};
}

export function uninstallAgent(input: { targetDir?: string }): UninstallAgentResult {
	const targetDir = path.resolve(input.targetDir ?? getDefaultAgentInstallDir());
	const destinationAgentFile = path.join(targetDir, AGENT_FILE_NAME);
	const destinationHookFile = path.join(targetDir, HOOK_FILE_NAME);
	const existed = existsSync(destinationAgentFile) || existsSync(destinationHookFile);

	if (existsSync(destinationAgentFile)) {
		rmSync(destinationAgentFile, { force: true });
	}

	if (existsSync(destinationHookFile)) {
		rmSync(destinationHookFile, { force: true });
	}

	return {
		targetDir,
		removed: {
			installedName: INSTALLED_AGENT_NAME,
			agentFile: destinationAgentFile,
			hookFile: destinationHookFile,
			status: existed ? "removed" : "missing"
		}
	};
}

export function listAgent(input: { targetDir?: string }): ListAgentResult {
	const targetDir = path.resolve(input.targetDir ?? getDefaultAgentInstallDir());
	const destinationAgentFile = path.join(targetDir, AGENT_FILE_NAME);
	const destinationHookFile = path.join(targetDir, HOOK_FILE_NAME);
	const agentExists = existsSync(destinationAgentFile);
	const hookExists = existsSync(destinationHookFile);

	return {
		targetDir,
		agent: {
			installedName: INSTALLED_AGENT_NAME,
			agentFile: destinationAgentFile,
			hookFile: destinationHookFile,
			status: agentExists && hookExists ? "installed" : agentExists || hookExists ? "partial" : "missing"
		}
	};
}

function rewriteInstalledAgentHooks(agentFilePath: string, hookFilePath: string): void {
	const current = readFileSync(agentFilePath, "utf8");
	const hookCommand = JSON.stringify(`node \"${hookFilePath}\"`);
	const updated = current.replace(
		/^hooks:\s+\{.*\}$/m,
		`hooks: { UserPromptSubmit: [{ type: command, command: ${hookCommand}, cwd: ".", timeout: 10 }], PreToolUse: [{ type: command, command: ${hookCommand}, cwd: ".", timeout: 10 }] }`
	);
	writeFileSync(agentFilePath, updated, "utf8");
	}