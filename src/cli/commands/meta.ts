import { Option } from "clipanion";

import { getCapabilitiesPayload, getHelpPayload, getSchemaPayload, renderHelp, renderSchema } from "../../help.js";
import { listSkills } from "../../skill-installer.js";

import { renderListSkills } from "../renderers.js";
import { BaseCommand, TargetCommand } from "../shared.js";

export class HelpCommand extends BaseCommand {
	public static paths = [["help"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		const payload = getHelpPayload(this.positionals[0]);
		this.print(payload, renderHelp(payload));
		return 0;
	}
}

export class SchemaCommand extends BaseCommand {
	public static paths = [["schema"]];

	public async execute(): Promise<number> {
		const payload = getSchemaPayload();
		this.print(payload, renderSchema(payload));
		return 0;
	}
}

export class CapabilitiesCommand extends TargetCommand {
	public static paths = [["capabilities"]];

	public async execute(): Promise<number> {
		const skills = listSkills({ targetDir: this.target });
		const capabilities = getCapabilitiesPayload(skills);
		this.print(
			capabilities,
			`${renderHelp(capabilities.help)}\n\n${renderSchema(capabilities.schema)}\n\n${renderListSkills(capabilities.skills)}`
		);
		return 0;
	}
}
