import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installSkills, listSkills, uninstallSkills } from "./skill-installer.js";

let targetDir: string | null = null;

afterEach(() => {
	if (targetDir) {
		rmSync(targetDir, { force: true, recursive: true });
		targetDir = null;
	}
});

describe("skill installer", () => {
	it("installs and removes shared skill references", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		const installResult = installSkills({ targetDir });
		const installedDomainModeling = installResult.installed.find(
			({ installedName }) => installedName === "ai-domain-modeling"
		);
		const installedPlan = installResult.installed.find(({ installedName }) => installedName === "ai-plan");
		const installedNextWork = installResult.installed.find(({ installedName }) => installedName === "ai-next-work");
		expect(installedDomainModeling?.status).toBe("installed");
		expect(installedPlan?.status).toBe("installed");
		expect(installedNextWork?.status).toBe("installed");

		const languageFile = path.join(targetDir, "agent-issues-language.md");
		const operatingContractFile = path.join(targetDir, "agent-issues-operating-contract.md");
		expect(readFileSync(languageFile, "utf8")).toContain("# Language standard");
		expect(readFileSync(operatingContractFile, "utf8")).toContain("# Shared Skill Operating Contract");

		for (const { installedName: skillName } of listSkills({ targetDir }).skills) {
			const installedSkill = readFileSync(path.join(targetDir, skillName, "SKILL.md"), "utf8");

			expect(installedSkill).toContain("../agent-issues-language.md");
			expect(installedSkill).toContain("../agent-issues-operating-contract.md");
		}
		for (const composerName of ["ai-grill-with-docs", "ai-plan"]) {
			const composer = readFileSync(path.join(targetDir, composerName, "SKILL.md"), "utf8");

			expect(composer).toContain("`ai-domain-modeling` skill");
		}
			for (const callerName of ["ai-implement", "ai-prepare", "ai-start-work", "ai-tdd"]) {
			const caller = readFileSync(path.join(targetDir, callerName, "SKILL.md"), "utf8");

			expect(caller).toContain("`ai-next-work` skill");
		}

		const uninstallResult = uninstallSkills({ targetDir });
		const removedDomainModeling = uninstallResult.removed.find(
			({ installedName }) => installedName === "ai-domain-modeling"
		);
		const removedPlan = uninstallResult.removed.find(({ installedName }) => installedName === "ai-plan");
		expect(removedDomainModeling?.status).toBe("removed");
		expect(removedPlan?.status).toBe("removed");

		expect(existsSync(languageFile)).toBe(false);
		expect(existsSync(operatingContractFile)).toBe(false);
	});

	it("preserves existing shared files without force", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));
		const languageFile = path.join(targetDir, "agent-issues-language.md");
		const operatingContractFile = path.join(targetDir, "agent-issues-operating-contract.md");

		writeFileSync(languageFile, "custom language guidance");
		writeFileSync(operatingContractFile, "custom operating guidance");

		installSkills({ targetDir });

		expect(readFileSync(languageFile, "utf8")).toBe("custom language guidance");
		expect(readFileSync(operatingContractFile, "utf8")).toBe("custom operating guidance");

		uninstallSkills({ targetDir });

		expect(readFileSync(languageFile, "utf8")).toBe("custom language guidance");
		expect(readFileSync(operatingContractFile, "utf8")).toBe("custom operating guidance");
	});

	it("preserves identical pre-existing shared files without force", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));
		const languageFile = path.join(targetDir, "agent-issues-language.md");
		const operatingContractFile = path.join(targetDir, "agent-issues-operating-contract.md");

		writeFileSync(languageFile, readFileSync(path.join("skills", "agent-issues-language.md"), "utf8"));
		writeFileSync(
			operatingContractFile,
			readFileSync(path.join("skills", "agent-issues-operating-contract.md"), "utf8")
		);

		installSkills({ targetDir });
		uninstallSkills({ targetDir });

		expect(existsSync(languageFile)).toBe(true);
		expect(existsSync(operatingContractFile)).toBe(true);
	});

	it("preserves shared files when no packaged skill is installed", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));
		const languageFile = path.join(targetDir, "agent-issues-language.md");
		const operatingContractFile = path.join(targetDir, "agent-issues-operating-contract.md");

		writeFileSync(languageFile, "custom language guidance");
		writeFileSync(operatingContractFile, "custom operating guidance");

		uninstallSkills({ targetDir });

		expect(readFileSync(languageFile, "utf8")).toBe("custom language guidance");
		expect(readFileSync(operatingContractFile, "utf8")).toBe("custom operating guidance");
	});

	it("installs the operating contract with the generic handoff command", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });

		const operatingContract = readFileSync(path.join(targetDir, "agent-issues-operating-contract.md"), "utf8");
		expect(operatingContract).toContain("agent-issues create handoff");
		expect(operatingContract).not.toContain("agent-issues handoff");

			for (const skillName of ["ai-agent-issues", "ai-grill-with-docs", "ai-handoff", "ai-implement", "ai-prepare", "ai-start-work", "ai-tdd", "ai-to-issues"]) {
			const installedSkill = readFileSync(path.join(targetDir, skillName, "SKILL.md"), "utf8");

			expect(installedSkill).not.toContain("agent-issues handoff");
		}
	});

	it("installs narrow compact read guidance for agent workflows", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });

		const operatingContract = readFileSync(path.join(targetDir, "agent-issues-operating-contract.md"), "utf8");
		const toolingGuide = readFileSync(path.join(targetDir, "ai-agent-issues", "SKILL.md"), "utf8");
		const nextWork = readFileSync(path.join(targetDir, "ai-next-work", "SKILL.md"), "utf8");
		const installedGuidance = `${operatingContract}\n${toolingGuide}\n${nextWork}`;

		expect(installedGuidance).toContain("agent-issues list <kind> --json");
		expect(installedGuidance).toContain("agent-issues relations <id> --json");
		expect(installedGuidance).toContain("agent-issues show <id> --view full --json");
		expect(installedGuidance).not.toContain("compatibility default");
		expect(installedGuidance).toContain("reserve `bundle` for intentional initiative-wide reads");
		expect(installedGuidance).toContain("Routine `jq` projection indicates a missing CLI capability");
	});
});