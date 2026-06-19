import { Cli } from "clipanion";

import { BackfillBodiesCommand } from "./commands/backfill.js";
import { ContextCommand } from "./commands/context.js";
import {
	ArchiveCommand,
	BundleCommand,
	CreateCommand,
	DeleteCommand,
	EditCommand,
	LinkCommand,
	ListCommand,
	MoveCommand,
	OrphansCommand,
	RelationsCommand,
	ShowCommand,
	StatusCommand,
	UnlinkCommand
} from "./commands/entities.js";
import { FallbackCommand } from "./commands/fallback.js";
import { HandoffCommand } from "./commands/handoff.js";
import {
	InstallAgentCommand,
	InstallSkillsCommand,
	ListAgentCommand,
	ListSkillsCommand,
	UninstallAgentCommand,
	UninstallSkillsCommand
} from "./commands/installers.js";
import { CapabilitiesCommand, HelpCommand, SchemaCommand } from "./commands/meta.js";
import { OpenSiteCommand, ServeSiteCommand } from "./commands/site.js";
import {
	CurrentTenantCommand,
	DeleteTenantCommand,
	InitCommand,
	ListTenantsCommand,
	RenameTenantCommand
} from "./commands/tenants.js";
import type { AgentIssuesContext } from "./shared.js";

export type { AgentIssuesContext } from "./shared.js";

function buildCli(): Cli<AgentIssuesContext> {
	const cli = new Cli<AgentIssuesContext>({
		binaryLabel: "agent-issues",
		binaryName: "agent-issues"
	});

	cli.register(HelpCommand);
	cli.register(SchemaCommand);
	cli.register(CapabilitiesCommand);
	cli.register(InstallSkillsCommand);
	cli.register(InstallAgentCommand);
	cli.register(ListSkillsCommand);
	cli.register(ListAgentCommand);
	cli.register(UninstallSkillsCommand);
	cli.register(UninstallAgentCommand);
	cli.register(ServeSiteCommand);
	cli.register(OpenSiteCommand);
	cli.register(InitCommand);
	cli.register(CurrentTenantCommand);
	cli.register(ListTenantsCommand);
	cli.register(DeleteTenantCommand);
	cli.register(RenameTenantCommand);
	cli.register(BackfillBodiesCommand);
	cli.register(ContextCommand);
	cli.register(CreateCommand);
	cli.register(EditCommand);
	cli.register(ArchiveCommand);
	cli.register(DeleteCommand);
	cli.register(MoveCommand);
	cli.register(LinkCommand);
	cli.register(UnlinkCommand);
	cli.register(StatusCommand);
	cli.register(BundleCommand);
	cli.register(HandoffCommand);
	cli.register(RelationsCommand);
	cli.register(OrphansCommand);
	cli.register(ShowCommand);
	cli.register(ListCommand);
	cli.register(FallbackCommand);

	return cli;
}

export async function runCli(argv: string[], context: Partial<AgentIssuesContext> = {}): Promise<number> {
	const cli = buildCli();
	const command = cli.process(normalizeArgv(argv), { cwd: process.cwd(), ...context });
	return await command.validateAndExecute();
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const cli = buildCli();

	try {
		const command = cli.process(normalizeArgv(argv), { cwd: process.cwd() });
		return await command.validateAndExecute();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (argv.includes("--json")) {
			process.stderr.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
		} else if (error instanceof Error) {
			process.stderr.write(cli.error(error));
		} else {
			process.stderr.write(`${message}\n`);
		}

		return 1;
	}
}

function normalizeArgv(argv: string[]): string[] {
	if (argv.length === 0) {
		return ["help"];
	}

	if (argv[0] === "--help" || argv[0] === "-h") {
		return ["help", ...argv.slice(1).filter((arg) => arg !== "--help" && arg !== "-h")];
	}

	if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
		const filtered = argv.filter((arg, index) => index === 0 || (arg !== "--help" && arg !== "-h"));
		return ["help", filtered[0], ...filtered.slice(1)];
	}

	return argv;
}
