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

			expect(skill).toContain("**Entity Read** recipe for the active initiative");
			expect(skill).toContain("**Entity Create And Edit** recipe to create one initiative-owned Plan");
			expect(skill).toContain("If the user gives an explicit Plan reference, resume that Plan instead.");
			expect(skill).toContain("Do not infer a Plan to resume or create a duplicate Plan.");
			expect(skill).toContain("**Plan Entry Write** recipe");
			expect(skill).toContain("before asking it");
			expect(skill).toContain("before continuing");
			expect(skill).toContain("supersedes the question reference");
			expect(skill).toContain("durable fact from code or tool output");
		}
			for (const callerName of ["ai-implement", "ai-prepare", "ai-start-work", "ai-tdd"]) {
			const caller = readFileSync(path.join(targetDir, callerName, "SKILL.md"), "utf8");

			expect(caller).toContain("`ai-next-work` skill");
		}
			for (const implementerName of ["ai-implement", "ai-tdd"]) {
				const implementer = readFileSync(path.join(targetDir, implementerName, "SKILL.md"), "utf8");

				expect(implementer).toContain("Read every linked `planEntries` item returned by the issue");
				expect(implementer).toContain("its current body can contain implementation decisions and constraints");
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
		expect(skill).toContain("**Plan Entry Issue Link** recipe to create the non-structural Plan `informs` PRD provenance relation");
		expect(skill).toContain("tombstone: true");
		expect(skill).toContain("supersededEntryIds");
		expect(skill).toContain("direct body text");
	});

	it("installs typed Wayfinder Plan workflow guidance", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });
		const skill = readFileSync(path.join(targetDir, "ai-wayfinder", "SKILL.md"), "utf8");

		expect(skill).toContain("**Entity Create And Edit** recipe to create the map as a `wayfinder-map` issue");
		expect(skill).toContain("each ticket as a `wayfinder-ticket` child");
		expect(skill).toContain("**Entity Create And Edit** recipe to create an initiative-owned Plan");
		expect(skill).toContain("resumes only an explicit Plan reference");
		expect(skill).toContain("**Plan Entry Write** recipe to link back to the ticket reference");
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

	it("installs the operating contract with MCP-first handoff guidance", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });

		const operatingContract = readFileSync(path.join(targetDir, "agent-issues-operating-contract.md"), "utf8");
		expect(operatingContract).toContain("## Operation Recipes");
		expect(operatingContract).toContain("MCP: `entity_next_work({ scopeId })`");
		expect(operatingContract).toContain("CLI fallback: `agent-issues next-work <initiativeOrDescendantId> --json`");
		expect(operatingContract).toContain("MCP: `entity_create({ kind: \"handoff\"");

			for (const skillName of ["ai-agent-issues", "ai-grill-with-docs", "ai-handoff", "ai-implement", "ai-prepare", "ai-start-work", "ai-tdd", "ai-to-issues"]) {
			const installedSkill = readFileSync(path.join(targetDir, skillName, "SKILL.md"), "utf8");

			expect(installedSkill).not.toContain("agent-issues create handoff");
		}
	});

	it("installs MCP-first read guidance for agent workflows", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });

		const operatingContract = readFileSync(path.join(targetDir, "agent-issues-operating-contract.md"), "utf8");
		const toolingGuide = readFileSync(path.join(targetDir, "ai-agent-issues", "SKILL.md"), "utf8");
		const nextWork = readFileSync(path.join(targetDir, "ai-next-work", "SKILL.md"), "utf8");
		const installedGuidance = `${operatingContract}\n${toolingGuide}\n${nextWork}`;

		expect(installedGuidance).toContain("Every tracker operation uses one of these recipes");
		expect(installedGuidance).toContain("MCP: `entity_list({ kind, statuses?, parentId?, limit? })`");
		expect(installedGuidance).toContain("CLI fallback: `agent-issues relations <entityId>");
		expect(nextWork).toContain("**Next Work** recipe");
		expect(installedGuidance).toContain("MCP: `initiative_bundle({ initiativeId })`");
		expect(installedGuidance).toContain("exact CLI fallback");
	});

	it("installs explicit MCP and CLI fallback recipes for tracker operations", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-skills-"));

		installSkills({ targetDir });
		const operatingContract = readFileSync(path.join(targetDir, "agent-issues-operating-contract.md"), "utf8");
		const recipes = [
			["### Entity Read", "**Kind:** Read.", "MCP: `entity_show({ reference })`", "CLI fallback: `agent-issues show <reference> --json`"],
			["### Entity List", "**Kind:** Read.", "MCP: `entity_list({ kind, statuses?, parentId?, limit? })`", "CLI fallback: `agent-issues list <kind>"],
			["### Relation Query", "**Kind:** Read.", "MCP: `relation_query({ entityId, direction?, types? })`", "CLI fallback: `agent-issues relations <entityId>"],
			["### Initiative Read", "**Kind:** Read.", "MCP: `initiative_bundle({ initiativeId })`", "CLI fallback: `agent-issues show <initiativeId> --json`"],
			["### Next Work", "**Kind:** Read.", "MCP: `entity_next_work({ scopeId })`", "CLI fallback: `agent-issues next-work <initiativeOrDescendantId> --json`"],
			["### Context Read", "**Kind:** Read.", "MCP: `context_show({ scopeRef? })`", "CLI fallback: `agent-issues context show [<scope>] --json`"],
			["### Context Write", "**Kind:** Write.", "MCP: `context_set({ scopeRef?, title, summary", "CLI fallback: `agent-issues context set --scope <scope>"],
			["### Entity Create And Edit", "**Kind:** Write.", "MCP create: `entity_create({ kind, title, body?", "CLI fallback: `agent-issues create <kind>"],
			["### Entity State And Structure", "**Kind:** Write.", "MCP: `entity_status({ entityId, status })`", "CLI fallback: `agent-issues status <entityId> <status> --json`"],
			["### Entity Relations", "**Kind:** Write.", "MCP: `relation_link({ fromId, relationType, toId })`", "CLI fallback: `agent-issues link <fromId> <relationType> <toId> --json`"],
			["### Plan Entry Read", "**Kind:** Read.", "MCP: `plan_entry_list({ planId })`", "CLI fallback: `agent-issues plan-entry list <planId> --json`"],
			["### Plan Entry Write", "**Kind:** Write.", "MCP: `plan_entry_create({ planId, role, body", "CLI fallback: `agent-issues plan-entry add <planId>"],
			["### Plan Entry Issue Link", "**Kind:** Write.", "MCP: `plan_entry_issue_link({ entryId, issueId })`", "CLI fallback: `agent-issues link <planEntryId> informs <issueId> --json`"],
			["### Issue Comment Read", "**Kind:** Read.", "MCP: `comment_list({ issueId, before?, all? })`", "CLI fallback: `agent-issues comment list <issueId>"],
			["### Issue Comment Write", "**Kind:** Write.", "MCP: `comment_create({ issueId, body", "CLI fallback: `agent-issues comment add <issueId>"],
			["### Revision Read", "**Kind:** Read.", "MCP: `entity_history({ entityId, revision })`", "CLI fallback: `agent-issues history <entityId> --revision <revision> --json`"],
			["### Entity Restore", "**Kind:** Destructive write.", "MCP: first call `entity_restore_inspect({ entityId, revision })`", "CLI fallback: `agent-issues restore <entityId> --revision <revision> --json`"],
			["### Context Restore", "**Kind:** Destructive write.", "MCP: unavailable.", "CLI fallback: `agent-issues restore --context <scope> --revision <revision> --json`"],
			["### Handoff Read", "**Kind:** Read.", "MCP: `entity_list({ kind: \"handoff\" })`", "CLI fallback: `agent-issues list handoff --json`"],
			["### Handoff Write", "**Kind:** Write.", "MCP: `entity_create({ kind: \"handoff\"", "CLI fallback: `agent-issues create handoff --title \"<title>\" --body-file - --link handsOff <focusId> --json`"],
			["### Host Operations", "**Kind:** Host.", "These operations have no MCP equivalent.", "Use the CLI: `install-mcp`"]
		];

		for (const [heading, kind, mcp, cliFallback] of recipes) {
			expect(operatingContract).toContain(heading);
			expect(operatingContract).toContain(kind);
			expect(operatingContract).toContain(mcp);
			expect(operatingContract).toContain(cliFallback);
		}

		for (const handoffReadStep of [
			"`entity_list({ kind: \"handoff\" })`",
			"`relation_query({ entityId: handoffId, direction: \"outgoing\", types: [\"handsOff\"] })`",
			"`entity_show({ reference: handoffId })`",
			"`agent-issues list handoff --json`",
			"`agent-issues relations <handoffId> --direction outgoing --type handsOff --json`",
			"`agent-issues show <handoffId> --json`"
		]) {
			expect(operatingContract).toContain(handoffReadStep);
		}
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