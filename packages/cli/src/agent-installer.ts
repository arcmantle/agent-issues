import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_FILE_NAME = "agent-issues.agent.md";
const HOOK_FILE_NAME = "agent-issues-enforcer.mjs";
const LANGUAGE_FILE_NAME = "agent-issues-language.md";
const RECIPES_DIRECTORY_NAME = "recipes";
const AGENT_FILES_MANIFEST = ".agent-issues-agent-files.json";
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
	return path.join(getVsCodeUserDir(), "prompts");
}

export function installAgent(input: { targetDir?: string; force?: boolean }): InstallAgentResult {
	const targetDir = path.resolve(input.targetDir ?? getDefaultAgentInstallDir());
	const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".github");
	const sourceAgentFile = path.join(sourceRoot, "agents", AGENT_FILE_NAME);
	const sourceHookFile = path.join(sourceRoot, "hooks", HOOK_FILE_NAME);
	const sourceLanguageFile = path.join(sourceRoot, "..", "skills", LANGUAGE_FILE_NAME);
	const sourceRecipesDirectory = path.join(sourceRoot, "..", "skills", RECIPES_DIRECTORY_NAME);
	const destinationAgentFile = path.join(targetDir, AGENT_FILE_NAME);
	const destinationHookFile = path.join(targetDir, HOOK_FILE_NAME);
	const destinationLanguageFile = path.join(targetDir, LANGUAGE_FILE_NAME);
	const destinationRecipesDirectory = path.join(targetDir, RECIPES_DIRECTORY_NAME);
	const existed = existsSync(destinationAgentFile) || existsSync(destinationHookFile);

	if (!existsSync(sourceAgentFile) || !existsSync(sourceHookFile) || !existsSync(sourceLanguageFile) || !existsSync(sourceRecipesDirectory)) {
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
	cpSync(sourceLanguageFile, destinationLanguageFile);
	if (input.force || !existsSync(destinationRecipesDirectory)) {
		if (existsSync(destinationRecipesDirectory)) {
			rmSync(destinationRecipesDirectory, { force: true, recursive: true });
		}
		cpSync(sourceRecipesDirectory, destinationRecipesDirectory, { recursive: true });
		writeOwnedRecipeCatalog(targetDir);
	}
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
	const destinationLanguageFile = path.join(targetDir, LANGUAGE_FILE_NAME);
	const destinationRecipesDirectory = path.join(targetDir, RECIPES_DIRECTORY_NAME);
	const existed = existsSync(destinationAgentFile) || existsSync(destinationHookFile);

	if (existsSync(destinationAgentFile)) {
		rmSync(destinationAgentFile, { force: true });
	}

	if (existsSync(destinationHookFile)) {
		rmSync(destinationHookFile, { force: true });
	}

	if (existsSync(destinationLanguageFile)) {
		rmSync(destinationLanguageFile, { force: true });
	}

	if (hasOwnedRecipeCatalog(targetDir) && existsSync(destinationRecipesDirectory)) {
		rmSync(destinationRecipesDirectory, { force: true, recursive: true });
	}
	rmSync(path.join(targetDir, AGENT_FILES_MANIFEST), { force: true });

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
	const destinationRecipesDirectory = path.join(targetDir, RECIPES_DIRECTORY_NAME);
	const agentExists = existsSync(destinationAgentFile);
	const hookExists = existsSync(destinationHookFile);
	const recipesExist = existsSync(destinationRecipesDirectory);
	const ownsRecipeCatalog = hasOwnedRecipeCatalog(targetDir);

	return {
		targetDir,
		agent: {
			installedName: INSTALLED_AGENT_NAME,
			agentFile: destinationAgentFile,
			hookFile: destinationHookFile,
			status: agentExists && hookExists && recipesExist && ownsRecipeCatalog ? "installed" : agentExists || hookExists || recipesExist ? "partial" : "missing"
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