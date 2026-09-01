import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The packaged skill folders under `skills/` are named identically to their
// installed names. Keeping a single name per skill makes drift between the
// source folder and the installed skill impossible.
const SKILL_NAMES = [
	"ai-agent-issues",
	"ai-domain-modeling",
	"ai-grill-with-docs",
	"ai-handoff",
	"ai-implement",
	"ai-migrate-docs",
	"ai-next-work",
	"ai-plan",
	"ai-prepare",
	"ai-prototype",
	"ai-recipe-migration",
	"ai-start-work",
	"ai-tdd",
	"ai-to-issues",
	"ai-to-prd",
	"ai-pioneer"
] as const;

const SHARED_SKILL_FILES = ["agent-issues-language.md", "agent-issues-operating-contract.md"] as const;
const SHARED_FILES_MANIFEST = ".agent-issues-shared-files.json";
const RECIPES_DIRECTORY_NAME = "recipes";
const LEGACY_PIONEER_SKILL_NAME = "ai-wayfinder";

const SKILL_INSTALLS = SKILL_NAMES.map((name) => ({ sourceDir: name, installedName: name }));

type SkillInstallRecord = {
	sourceDir: string;
	installedName: string;
	destinationDir: string;
};

export type InstallSkillsResult = {
	targetDir: string;
	installed: Array<SkillInstallRecord & { status: "installed" | "updated" | "skipped" }>;
};

export type UninstallSkillsResult = {
	targetDir: string;
	removed: Array<SkillInstallRecord & { status: "removed" | "missing" }>;
};

export type ListSkillsResult = {
	targetDir: string;
	skills: Array<SkillInstallRecord & { status: "installed" | "missing" }>;
};

export function getDefaultSkillsInstallDir(): string {
	return path.join(homedir(), ".agents", "skills");
}

export function installSkills(input: { targetDir?: string; force?: boolean }): InstallSkillsResult {
	const targetDir = path.resolve(input.targetDir ?? getDefaultSkillsInstallDir());
	const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
	const sourceRecipesDirectory = path.join(sourceRoot, RECIPES_DIRECTORY_NAME);
	const destinationRecipesDirectory = path.join(targetDir, RECIPES_DIRECTORY_NAME);

	if (!existsSync(sourceRoot) || !existsSync(sourceRecipesDirectory)) {
		throw new Error(`Packaged skills directory not found: ${sourceRoot}`);
	}

	mkdirSync(targetDir, { recursive: true });
	const legacyPioneerSkillDirectory = path.join(targetDir, LEGACY_PIONEER_SKILL_NAME);
	const isPioneerRenameUpgrade = existsSync(path.join(legacyPioneerSkillDirectory, "SKILL.md"));
	if (isPioneerRenameUpgrade) {
		rmSync(legacyPioneerSkillDirectory, { force: true, recursive: true });
	}
	const ownedSharedFiles = readOwnedSharedFiles(targetDir);
	for (const fileName of SHARED_SKILL_FILES) {
		const destinationFile = path.join(targetDir, fileName);
		if (input.force || isPioneerRenameUpgrade || !existsSync(destinationFile)) {
			cpSync(path.join(sourceRoot, fileName), destinationFile);
			ownedSharedFiles.add(fileName);
		}
	}
	writeOwnedSharedFiles(targetDir, ownedSharedFiles);
	if (input.force || isPioneerRenameUpgrade || !existsSync(destinationRecipesDirectory)) {
		if (existsSync(destinationRecipesDirectory)) {
			rmSync(destinationRecipesDirectory, { force: true, recursive: true });
		}
		cpSync(sourceRecipesDirectory, destinationRecipesDirectory, { recursive: true });
		writeOwnedRecipeCatalog(targetDir);
	}

	const installed = SKILL_INSTALLS.map((skill) => {
		const sourceDir = path.join(sourceRoot, skill.sourceDir);
		const destinationDir = path.join(targetDir, skill.installedName);
		const existed = existsSync(destinationDir);

		if (existed && !input.force) {
			return {
				sourceDir: skill.sourceDir,
				installedName: skill.installedName,
				destinationDir,
				status: "skipped" as const
			};
		}

		if (existed) {
			rmSync(destinationDir, { recursive: true, force: true });
		}

		cpSync(sourceDir, destinationDir, { recursive: true });
		rewriteSkillName(path.join(destinationDir, "SKILL.md"), skill.installedName);

		return {
			sourceDir: skill.sourceDir,
			installedName: skill.installedName,
			destinationDir,
			status: existed ? ("updated" as const) : ("installed" as const)
		};
	});

	return {
		targetDir,
		installed
	};
}

export function uninstallSkills(input: { targetDir?: string }): UninstallSkillsResult {
	const targetDir = path.resolve(input.targetDir ?? getDefaultSkillsInstallDir());
	const ownedSharedFiles = readOwnedSharedFiles(targetDir);
	const destinationRecipesDirectory = path.join(targetDir, RECIPES_DIRECTORY_NAME);
	let removedInstalledSkill = false;

	const removed = SKILL_INSTALLS.map((skill) => {
		const destinationDir = path.join(targetDir, skill.installedName);
		const existed = existsSync(destinationDir);

		if (existed) {
			rmSync(destinationDir, { recursive: true, force: true });
			removedInstalledSkill = true;
		}

		return {
			sourceDir: skill.sourceDir,
			installedName: skill.installedName,
			destinationDir,
			status: existed ? ("removed" as const) : ("missing" as const)
		};
	});
	if (removedInstalledSkill) {
		for (const fileName of ownedSharedFiles) {
			rmSync(path.join(targetDir, fileName), { force: true });
		}
		if (hasOwnedRecipeCatalog(targetDir) && existsSync(destinationRecipesDirectory)) {
			rmSync(destinationRecipesDirectory, { force: true, recursive: true });
		}
		rmSync(path.join(targetDir, SHARED_FILES_MANIFEST), { force: true });
	}

	return {
		targetDir,
		removed
	};
}

export function listSkills(input: { targetDir?: string }): ListSkillsResult {
	const targetDir = path.resolve(input.targetDir ?? getDefaultSkillsInstallDir());

	return {
		targetDir,
		skills: SKILL_INSTALLS.map((skill) => {
			const destinationDir = path.join(targetDir, skill.installedName);

			return {
				sourceDir: skill.sourceDir,
				installedName: skill.installedName,
				destinationDir,
				status: existsSync(destinationDir) ? ("installed" as const) : ("missing" as const)
			};
		})
	};
}

function rewriteSkillName(skillFilePath: string, installedName: string): void {
	const current = readFileSync(skillFilePath, "utf8");
	const updated = current.replace(/^name:\s+.+$/m, `name: ${installedName}`);
	writeFileSync(skillFilePath, updated, "utf8");
}

function readOwnedSharedFiles(targetDir: string): Set<string> {
	const manifestPath = path.join(targetDir, SHARED_FILES_MANIFEST);
	if (!existsSync(manifestPath)) {
		return new Set();
	}

	const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { sharedFiles?: unknown };
	if (!Array.isArray(parsed.sharedFiles)) {
		return new Set();
	}

	return new Set(parsed.sharedFiles.filter((fileName): fileName is string => typeof fileName === "string"));
}

function writeOwnedSharedFiles(targetDir: string, sharedFiles: Set<string>): void {
	writeFileSync(
		path.join(targetDir, SHARED_FILES_MANIFEST),
		`${JSON.stringify({ sharedFiles: [...sharedFiles].sort() }, null, "\t")}\n`
	);
}

function hasOwnedRecipeCatalog(targetDir: string): boolean {
	const manifestPath = path.join(targetDir, SHARED_FILES_MANIFEST);
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
	const manifestPath = path.join(targetDir, SHARED_FILES_MANIFEST);
	const parsed = existsSync(manifestPath)
		? JSON.parse(readFileSync(manifestPath, "utf8")) as { sharedFiles?: unknown }
		: {};
	writeFileSync(
		manifestPath,
		`${JSON.stringify({ ...parsed, recipeCatalog: true }, null, "\t")}\n`
	);
}