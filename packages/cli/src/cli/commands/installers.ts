import { installAgent, listAgent, uninstallAgent } from "../../agent-installer.js";
import { installMcp, listMcp, uninstallMcp } from "../../mcp-installer.js";
import { installSkills, listSkills, uninstallSkills } from "../../skill-installer.js";

import {
	renderInstallAgent,
	renderInstallMcp,
	renderInstallSkills,
	renderListAgent,
	renderListMcp,
	renderListSkills,
	renderUninstallAgent,
	renderUninstallMcp,
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

export class InstallMcpCommand extends TargetCommand {
	public static paths = [["install-mcp"]];

	public async execute(): Promise<number> {
		const result = installMcp({ targetFile: this.target, force: this.force });
		this.print(result, renderInstallMcp(result));
		return 0;
	}
}

export class ListMcpCommand extends TargetCommand {
	public static paths = [["list-mcp"]];

	public async execute(): Promise<number> {
		const result = listMcp({ targetFile: this.target });
		this.print(result, renderListMcp(result));
		return 0;
	}
}

export class UninstallMcpCommand extends TargetCommand {
	public static paths = [["uninstall-mcp"]];

	public async execute(): Promise<number> {
		const result = uninstallMcp({ targetFile: this.target });
		this.print(result, renderUninstallMcp(result));
		return 0;
	}
}
