import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_FILE_NAME = "agent-issues.agent.md";
const CLAUDE_AGENT_FILE_NAME = "agent-issues.md";
const HOOK_FILE_NAME = "agent-issues-enforcer.mjs";
const LANGUAGE_FILE_NAME = "agent-issues-language.md";
const RECIPES_DIRECTORY_NAME = "recipes";
const AGENT_FILES_MANIFEST = ".agent-issues-agent-files.json";
const INSTALLED_AGENT_NAME = "agent-issues";

type AgentHost = "claude" | "copilot" | "vscode";

type AgentInstallRecord = {
	installedName: string;
	agentFile: string;
	hookFile: string;
};

type AgentInstallation = AgentInstallRecord & {
	host: AgentHost;
	targetDir: string;
};

type AgentTarget = {
	host: AgentHost;
	targetDir: string;
	agentFileName: string;
};

export type InstallAgentResult = {
	targetDir: string;
	installed: AgentInstallRecord & { status: "installed" | "updated" | "skipped" };
	additionalInstalled: Array<AgentInstallation & { status: "installed" | "updated" | "skipped" }>;
};

export type UninstallAgentResult = {
	targetDir: string;
	removed: AgentInstallRecord & { status: "removed" | "missing" };
	additionalRemoved: Array<AgentInstallation & { status: "removed" | "missing" }>;
};

export type ListAgentResult = {
	targetDir: string;
	agent: AgentInstallRecord & { status: "installed" | "partial" | "missing" };
	additionalAgents: Array<AgentInstallation & { status: "installed" | "partial" | "missing" }>;
};

function getVsCodeUserDir(): string {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");

		return path.join(appData, "Code", "User");
	}

	if (process.platform === "darwin")
		return path.join(homedir(), "Library", "Application Support", "Code", "User");

	const configHome = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");

	return path.join(configHome, "Code", "User");
}

export function getDefaultAgentInstallDir(): string {
	return getDefaultAgentInstallDirs().vscode;
}

export function getDefaultAgentInstallDirs(): Record<AgentHost, string> {
	return {
		claude: path.join(homedir(), ".claude", "agents"),
		copilot: path.join(homedir(), ".copilot", "agents"),
		vscode: path.join(getVsCodeUserDir(), "prompts")
	};
}

export function installAgent(input: { targetDir?: string; force?: boolean }): InstallAgentResult {
	const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".github");
	const [primaryTarget, ...additionalTargets] = getAgentTargets(input.targetDir);
	const installed = installAgentAtTarget(primaryTarget, sourceRoot, Boolean(input.force));
	const additionalInstalled = additionalTargets.map((target) => ({
		...installAgentAtTarget(target, sourceRoot, Boolean(input.force)),
		host: target.host,
		targetDir: target.targetDir
	}));

	return {
		targetDir: primaryTarget.targetDir,
		installed,
		additionalInstalled
	};
}

export function uninstallAgent(input: { targetDir?: string }): UninstallAgentResult {
	const [primaryTarget, ...additionalTargets] = getAgentTargets(input.targetDir);
	const removed = uninstallAgentAtTarget(primaryTarget);
	const additionalRemoved = additionalTargets.map((target) => ({
		...uninstallAgentAtTarget(target),
		host: target.host,
		targetDir: target.targetDir
	}));

	return {
		targetDir: primaryTarget.targetDir,
		removed,
		additionalRemoved
	};
}

export function listAgent(input: { targetDir?: string }): ListAgentResult {
	const [primaryTarget, ...additionalTargets] = getAgentTargets(input.targetDir);
	const agent = listAgentAtTarget(primaryTarget);
	const additionalAgents = additionalTargets.map((target) => ({
		...listAgentAtTarget(target),
		host: target.host,
		targetDir: target.targetDir
	}));

	return {
		targetDir: primaryTarget.targetDir,
		agent,
		additionalAgents
	};
}

function getAgentTargets(targetDir?: string): AgentTarget[] {
	if (targetDir) {
		return [{ host: "vscode", targetDir: path.resolve(targetDir), agentFileName: AGENT_FILE_NAME }];
	}

	const targetDirs = getDefaultAgentInstallDirs();
	return [
		{ host: "vscode", targetDir: targetDirs.vscode, agentFileName: AGENT_FILE_NAME },
		{ host: "copilot", targetDir: targetDirs.copilot, agentFileName: AGENT_FILE_NAME },
		{ host: "claude", targetDir: targetDirs.claude, agentFileName: CLAUDE_AGENT_FILE_NAME }
	];
}

function installAgentAtTarget(
	target: AgentTarget,
	sourceRoot: string,
	force: boolean
): AgentInstallRecord & { status: "installed" | "updated" | "skipped" } {
	const sourceAgentFile = path.join(sourceRoot, "agents", target.host === "claude" ? "agent-issues.claude.md" : AGENT_FILE_NAME);
	const sourceHookFile = path.join(sourceRoot, "hooks", HOOK_FILE_NAME);
	const sourceLanguageFile = path.join(sourceRoot, "..", "skills", LANGUAGE_FILE_NAME);
	const sourceRecipesDirectory = path.join(sourceRoot, "..", "skills", RECIPES_DIRECTORY_NAME);
	const destinationAgentFile = path.join(target.targetDir, target.agentFileName);
	const destinationHookFile = path.join(target.targetDir, HOOK_FILE_NAME);
	const destinationLanguageFile = path.join(target.targetDir, LANGUAGE_FILE_NAME);
	const destinationRecipesDirectory = path.join(target.targetDir, RECIPES_DIRECTORY_NAME);
	const existed = existsSync(destinationAgentFile) || existsSync(destinationHookFile);

	if (!existsSync(sourceAgentFile) || !existsSync(sourceHookFile) || !existsSync(sourceLanguageFile) || !existsSync(sourceRecipesDirectory)) {
		throw new Error(`Packaged agent assets not found under ${sourceRoot}`);
	}

	mkdirSync(target.targetDir, { recursive: true });

	if (existed && !force) {
		return {
			installedName: INSTALLED_AGENT_NAME,
			agentFile: destinationAgentFile,
			hookFile: destinationHookFile,
			status: "skipped"
		};
	}

	cpSync(sourceAgentFile, destinationAgentFile);
	cpSync(sourceHookFile, destinationHookFile);
	cpSync(sourceLanguageFile, destinationLanguageFile);
	if (force || !existsSync(destinationRecipesDirectory)) {
		if (existsSync(destinationRecipesDirectory)) {
			rmSync(destinationRecipesDirectory, { force: true, recursive: true });
		}
		cpSync(sourceRecipesDirectory, destinationRecipesDirectory, { recursive: true });
		writeOwnedRecipeCatalog(target.targetDir);
	}
	rewriteInstalledAgentHooks(destinationAgentFile, destinationHookFile, target.host);

	return {
		installedName: INSTALLED_AGENT_NAME,
		agentFile: destinationAgentFile,
		hookFile: destinationHookFile,
		status: existed ? "updated" : "installed"
	};
}

function uninstallAgentAtTarget(target: AgentTarget): AgentInstallRecord & { status: "removed" | "missing" } {
	const destinationAgentFile = path.join(target.targetDir, target.agentFileName);
	const destinationHookFile = path.join(target.targetDir, HOOK_FILE_NAME);
	const destinationLanguageFile = path.join(target.targetDir, LANGUAGE_FILE_NAME);
	const destinationRecipesDirectory = path.join(target.targetDir, RECIPES_DIRECTORY_NAME);
	const existed = existsSync(destinationAgentFile) || existsSync(destinationHookFile);

	for (const destinationFile of [destinationAgentFile, destinationHookFile, destinationLanguageFile]) {
		if (existsSync(destinationFile)) {
			rmSync(destinationFile, { force: true });
		}
	}

	if (hasOwnedRecipeCatalog(target.targetDir) && existsSync(destinationRecipesDirectory)) {
		rmSync(destinationRecipesDirectory, { force: true, recursive: true });
	}
	rmSync(path.join(target.targetDir, AGENT_FILES_MANIFEST), { force: true });

	return {
		installedName: INSTALLED_AGENT_NAME,
		agentFile: destinationAgentFile,
		hookFile: destinationHookFile,
		status: existed ? "removed" : "missing"
	};
}

function listAgentAtTarget(target: AgentTarget): AgentInstallRecord & { status: "installed" | "partial" | "missing" } {
	const destinationAgentFile = path.join(target.targetDir, target.agentFileName);
	const destinationHookFile = path.join(target.targetDir, HOOK_FILE_NAME);
	const destinationRecipesDirectory = path.join(target.targetDir, RECIPES_DIRECTORY_NAME);
	const agentExists = existsSync(destinationAgentFile);
	const hookExists = existsSync(destinationHookFile);
	const recipesExist = existsSync(destinationRecipesDirectory);
	const ownsRecipeCatalog = hasOwnedRecipeCatalog(target.targetDir);

	return {
		installedName: INSTALLED_AGENT_NAME,
		agentFile: destinationAgentFile,
		hookFile: destinationHookFile,
		status: agentExists && hookExists && recipesExist && ownsRecipeCatalog ? "installed" : agentExists || hookExists || recipesExist ? "partial" : "missing"
	};
}

function rewriteInstalledAgentHooks(agentFilePath: string, hookFilePath: string, host: AgentHost): void {
	const current = readFileSync(agentFilePath, "utf8");
	const hookCommand = JSON.stringify(`node \"${hookFilePath}\"`);
	const updated = host === "claude"
		? current.replaceAll("{{AGENT_ISSUES_HOOK_COMMAND}}", hookCommand)
		: current.replace(
			/^hooks:\s+\{.*\}$/m,
			`hooks: { UserPromptSubmit: [{ type: command, command: ${hookCommand}, cwd: ".", timeout: 10 }], PreToolUse: [{ type: command, command: ${hookCommand}, cwd: ".", timeout: 10 }] }`
		);
	writeFileSync(agentFilePath, updated, "utf8");
}

function hasOwnedRecipeCatalog(targetDir: string): boolean {
	const manifestPath = path.join(targetDir, AGENT_FILES_MANIFEST);
	if (!existsSync(manifestPath)) {
		return false;
	}

	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { recipeCatalog?: unknown };
		return parsed.recipeCatalog === true;
	} catch {
		return false;
	}
}

function writeOwnedRecipeCatalog(targetDir: string): void {
	writeFileSync(
		path.join(targetDir, AGENT_FILES_MANIFEST),
		`${JSON.stringify({ recipeCatalog: true }, null, "\t")}\n`
	);
}