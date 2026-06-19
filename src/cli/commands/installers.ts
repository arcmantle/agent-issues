import { installAgent, listAgent, uninstallAgent } from "../../agent-installer.js";
import { installSkills, listSkills, uninstallSkills } from "../../skill-installer.js";

import {
	renderInstallAgent,
	renderInstallSkills,
	renderListAgent,
	renderListSkills,
	renderUninstallAgent,
	renderUninstallSkills
} from "../renderers.js";
import { TargetCommand } from "../shared.js";

export class InstallSkillsCommand extends TargetCommand {
	public static paths = [["install-skills"]];

	public async execute(): Promise<number> {
		const result = installSkills({ targetDir: this.target, force: this.force });
		this.print(result, renderInstallSkills(result));
		return 0;
	}
}

export class InstallAgentCommand extends TargetCommand {
	public static paths = [["install-agent"]];

	public async execute(): Promise<number> {
		const result = installAgent({ targetDir: this.target, force: this.force });
		this.print(result, renderInstallAgent(result));
		return 0;
	}
}

export class ListSkillsCommand extends TargetCommand {
	public static paths = [["list-skills"]];

	public async execute(): Promise<number> {
		const result = listSkills({ targetDir: this.target });
		this.print(result, renderListSkills(result));
		return 0;
	}
}

export class ListAgentCommand extends TargetCommand {
	public static paths = [["list-agent"]];

	public async execute(): Promise<number> {
		const result = listAgent({ targetDir: this.target });
		this.print(result, renderListAgent(result));
		return 0;
	}
}

export class UninstallSkillsCommand extends TargetCommand {
	public static paths = [["uninstall-skills"]];

	public async execute(): Promise<number> {
		const result = uninstallSkills({ targetDir: this.target });
		this.print(result, renderUninstallSkills(result));
		return 0;
	}
}

export class UninstallAgentCommand extends TargetCommand {
	public static paths = [["uninstall-agent"]];

	public async execute(): Promise<number> {
		const result = uninstallAgent({ targetDir: this.target });
		this.print(result, renderUninstallAgent(result));
		return 0;
	}
}
