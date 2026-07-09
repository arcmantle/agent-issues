import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The packaged skill folders under `skills/` are named identically to their
// installed names. Keeping a single name per skill makes drift between the
// source folder and the installed skill impossible.
const SKILL_NAMES = [
	"ai-agent-issues",
	"ai-grill-with-docs",
	"ai-handoff",
	"ai-migrate-docs",
	"ai-start-work",
	"ai-tdd",
	"ai-to-issues",
	"ai-to-prd"
] as const;

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

	if (!existsSync(sourceRoot)) {
		throw new Error(`Packaged skills directory not found: ${sourceRoot}`);
	}

	mkdirSync(targetDir, { recursive: true });

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

	const removed = SKILL_INSTALLS.map((skill) => {
		const destinationDir = path.join(targetDir, skill.installedName);
		const existed = existsSync(destinationDir);

		if (existed) {
			rmSync(destinationDir, { recursive: true, force: true });
		}

		return {
			sourceDir: skill.sourceDir,
			installedName: skill.installedName,
			destinationDir,
			status: existed ? ("removed" as const) : ("missing" as const)
		};
	});

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