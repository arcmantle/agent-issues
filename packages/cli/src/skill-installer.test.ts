import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		const installedPrototype = installResult.installed.find(({ installedName }) => installedName === "ai-prototype");
		const installedWayfinder = installResult.installed.find(({ installedName }) => installedName === "ai-wayfinder");
		expect(installedDomainModeling?.status).toBe("installed");
		expect(installedPlan?.status).toBe("installed");
		expect(installedNextWork?.status).toBe("installed");
		expect(installedPrototype?.status).toBe("installed");
		expect(installedWayfinder?.status).toBe("installed");

		const languageFile = path.join(targetDir, "agent-issues-language.md");
		const operatingContractFile = path.join(targetDir, "agent-issues-operating-contract.md");
		const recipeCatalog = path.join(targetDir, "recipes", "README.md");
		expect(readFileSync(languageFile, "utf8")).toContain("# Language standard");
		expect(readFileSync(operatingContractFile, "utf8")).toContain("# Shared Skill Operating Contract");
		expect(existsSync(recipeCatalog)).toBe(true);

		for (const { installedName: skillName } of listSkills({ targetDir }).skills) {
			const installedSkill = readFileSync(path.join(targetDir, skillName, "SKILL.md"), "utf8");

			expect(installedSkill).toContain("../agent-issues-language.md");
			expect(installedSkill).toContain("../agent-issues-operating-contract.md");
		}
		for (const composerName of ["ai-grill-with-docs", "ai-plan"]) {
			const composer = readFileSync(path.join(targetDir, composerName, "SKILL.md"), "utf8");

			expect(composer).toContain("`ai-domain-modeling` skill");
		}
		for (const skillName of ["ai-grill-with-docs", "ai-plan"]) {
			const skill = readFileSync(path.join(targetDir, skillName, "SKILL.md"), "utf8");

			expect(skill).toContain("`agent-issues show <initiative-reference> --view full --json`");
			expect(skill).toContain("`agent-issues create plan --title \"<Plan title>\" --parent <initiative-reference> --body-file - --json`");
			expect(skill).toContain("If the user gives an explicit Plan reference, resume that Plan instead.");
			expect(skill).toContain("Do not infer a Plan to resume or create a duplicate Plan.");
			expect(skill).toContain("`agent-issues plan-entry add`");
			expect(skill).toContain("before asking it");
			expect(skill).toContain("before continuing");
			expect(skill).toContain("--supersedes <question-reference>");
			expect(skill).toContain("durable fact from code or tool output");
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
		expect(existsSync(recipeCatalog)).toBe(false);
	});

	it("installs the preview-first Recipe migration skill", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		const installResult = installSkills({ targetDir });
		const installedMigration = installResult.installed.find(
			({ installedName }) => installedName === "ai-recipe-migration"
		);

		expect(installedMigration?.status).toBe("installed");
		expect(existsSync(path.join(targetDir, "ai-recipe-migration", "SKILL.md"))).toBe(true);
	});

	it("installs the ready-Plan PRD conversion workflow", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });
		const skill = readFileSync(path.join(targetDir, "ai-to-prd", "SKILL.md"), "utf8");

		expect(skill).toContain("explicit ready Plan reference");
		expect(skill).toContain("active Plan entries");
		expect(skill).toContain("Plan informs PRD");
		expect(skill).toContain("tombstone: true");
		expect(skill).toContain("supersededEntryIds");
		expect(skill).toContain("agent-issues link <plan-reference> informs <prd-reference> --json");
	});

	it("installs typed Wayfinder Plan workflow guidance", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });
		const skill = readFileSync(path.join(targetDir, "ai-wayfinder", "SKILL.md"), "utf8");

		expect(skill).toContain("--type wayfinder-map");
		expect(skill).toContain("--type wayfinder-ticket");
		expect(skill).toContain("agent-issues create plan --parent <initiativeReference>");
		expect(skill).toContain("resumes only an explicit Plan reference");
		expect(skill).toContain("--reference <ticket-reference>");
		expect(skill).toContain("canonical detailed resolution");
		expect(skill).toContain("does not inform a Wayfinder map");
		expect(skill).toContain("update only `## Resolution`");
	});

	it("installs a discoverable debt recipe", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });
		const catalog = readFileSync(path.join(targetDir, "recipes", "README.md"), "utf8");
		const recipe = readFileSync(path.join(targetDir, "recipes", "debt.md"), "utf8");

		expect(catalog).toContain("[Debt](./debt.md)");
		expect(recipe).toContain("# Debt Recipe");
	});

	it("installs debt model guidance", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });
		const toolingGuide = readFileSync(path.join(targetDir, "ai-agent-issues", "SKILL.md"), "utf8");

		expect(toolingGuide).toContain("Debt records are reference-only");
		expect(toolingGuide).toContain("open, resolved, and archived");
		expect(toolingGuide).toContain("project, epic, initiative, or issue");
	});

	it("installs Recipe migration guidance for preview approval and stale records", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });
		const skill = readFileSync(path.join(targetDir, "ai-recipe-migration", "SKILL.md"), "utf8");

		expect(skill).toContain("entity, initiative, shared context, or full project");
		expect(skill).toContain("per-record exclusions");
		expect(skill).toContain("explicit approval");
		expect(skill).toContain("skips it when the body changed after preview");
		expect(skill).toContain("updated, unchanged, excluded, and stale records");
	});

	it("preserves an unowned recipe catalog without force", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));
		const recipesDirectory = path.join(targetDir, "recipes");
		const customRecipe = path.join(recipesDirectory, "custom.md");
		mkdirSync(recipesDirectory);
		writeFileSync(customRecipe, "custom recipe");

		installSkills({ targetDir });
		uninstallSkills({ targetDir });

		expect(readFileSync(customRecipe, "utf8")).toBe("custom recipe");
		expect(existsSync(path.join(recipesDirectory, "README.md"))).toBe(false);
	});

	it("replaces an unowned recipe catalog only with force", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));
		const recipesDirectory = path.join(targetDir, "recipes");
		const customRecipe = path.join(recipesDirectory, "custom.md");
		mkdirSync(recipesDirectory);
		writeFileSync(customRecipe, "custom recipe");

		installSkills({ targetDir, force: true });

		expect(existsSync(path.join(recipesDirectory, "README.md"))).toBe(true);
		expect(existsSync(customRecipe)).toBe(false);
		uninstallSkills({ targetDir });
		expect(existsSync(recipesDirectory)).toBe(false);
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
		expect(nextWork).toContain("--status 'todo,in-progress,blocked'");
		expect(installedGuidance).not.toContain("compatibility default");
		expect(installedGuidance).toContain("Use `bundle` only for a planned initiative-wide read");
		expect(installedGuidance).toContain("Routine `jq` filtering shows a missing CLI feature");
	});

	it("installs the ADR lifecycle guidance without issue-derived status", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });

		const operatingContract = readFileSync(path.join(targetDir, "agent-issues-operating-contract.md"), "utf8");
		const adrFormat = readFileSync(path.join(targetDir, "ai-domain-modeling", "ADR-FORMAT.md"), "utf8");
		expect(operatingContract).toContain("Derive user story and PRD status from their linked issues");
		expect(operatingContract).toContain("An ADR is `current` unless it is `superseded` or `archived`");
		expect(operatingContract).not.toContain("Derive user story, PRD, and ADR status from their linked issues");
		expect(adrFormat).toContain("current | superseded | archived");
		expect(adrFormat).not.toContain("proposed | accepted");

		for (const { installedName: skillName } of listSkills({ targetDir }).skills) {
			const installedSkill = readFileSync(path.join(targetDir, skillName, "SKILL.md"), "utf8");

			expect(installedSkill).not.toContain("Derive user story, PRD, and ADR status from their linked issues");
			expect(installedSkill).not.toContain("derive ADR status from issue progress");
		}
	});
});