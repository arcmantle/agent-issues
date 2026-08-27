import { Cli } from "clipanion";

import { AuthListCommand, AuthLoginCommand, AuthLogoutCommand, AuthStatusCommand, AuthSwitchCommand } from "./commands/auth.js";
import { BackfillBodiesCommand } from "./commands/backfill.js";
import { AddIssueCommentCommand, DeleteIssueCommentCommand, EditIssueCommentCommand, IssueCommentCommand, IssueCommentHistoryCommand, ListIssueCommentsCommand } from "./commands/comments.js";
import { AddPlanEntryCommand, DeletePlanEntryCommand, EditPlanEntryCommand, ListPlanEntriesCommand, PlanEntryHistoryCommand } from "./commands/plan-entries.js";
import { ContextCommand } from "./commands/context.js";
import {
	ArchiveCommand,
	CreateCommand,
	DeleteCommand,
	EditCommand,
	HistoryCommand,
	LinkCommand,
	ListCommand,
	MoveCommand,
	NextWorkCommand,
	OrphansCommand,
	RelationsCommand,
	RestoreCommand,
	ShowCommand,
	StatusCommand,
	UnlinkCommand
} from "./commands/entities.js";
import { ExportCommand } from "./commands/export.js";
import { FallbackCommand } from "./commands/fallback.js";
import {
	InstallAgentCommand,
	InstallMcpCommand,
	InstallSkillsCommand,
	ListAgentCommand,
	ListMcpCommand,
	ListSkillsCommand,
	UninstallAgentCommand,
	UninstallMcpCommand,
	UninstallSkillsCommand
} from "./commands/installers.js";
import { CapabilitiesCommand, HelpCommand, SchemaCommand } from "./commands/meta.js";
import { SiteCommand } from "./commands/site.js";
import { SqlCommand } from "./commands/sql.js";
import { SynchronizeCommand } from "./commands/synchronize.js";
import {
	CurrentTenantCommand,
	DeleteTenantCommand,
	InitCommand,
	ListTenantsCommand,
	ProjectIdentityCommand,
	RenameTenantCommand
} from "./commands/tenants.js";
import { stringifyJson, type AgentIssuesContext } from "./shared.js";

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
	cli.register(InstallMcpCommand);
	cli.register(ListSkillsCommand);
	cli.register(ListAgentCommand);
	cli.register(ListMcpCommand);
	cli.register(UninstallSkillsCommand);
	cli.register(UninstallAgentCommand);
	cli.register(UninstallMcpCommand);
	cli.register(SiteCommand);
	cli.register(InitCommand);
	cli.register(CurrentTenantCommand);
	cli.register(ProjectIdentityCommand);
	cli.register(ListTenantsCommand);
	cli.register(DeleteTenantCommand);
	cli.register(RenameTenantCommand);
	cli.register(BackfillBodiesCommand);
	cli.register(ContextCommand);
	cli.register(IssueCommentCommand);
	cli.register(AddIssueCommentCommand);
	cli.register(DeleteIssueCommentCommand);
	cli.register(EditIssueCommentCommand);
	cli.register(IssueCommentHistoryCommand);
	cli.register(ListIssueCommentsCommand);
	cli.register(AddPlanEntryCommand);
	cli.register(EditPlanEntryCommand);
	cli.register(DeletePlanEntryCommand);
	cli.register(ListPlanEntriesCommand);
	cli.register(PlanEntryHistoryCommand);
	cli.register(CreateCommand);
	cli.register(EditCommand);
	cli.register(HistoryCommand);
	cli.register(RestoreCommand);
	cli.register(ArchiveCommand);
	cli.register(DeleteCommand);
	cli.register(MoveCommand);
	cli.register(LinkCommand);
	cli.register(UnlinkCommand);
	cli.register(StatusCommand);
	cli.register(NextWorkCommand);
	cli.register(ExportCommand);
	cli.register(SqlCommand);
	cli.register(RelationsCommand);
	cli.register(OrphansCommand);
	cli.register(ShowCommand);
	cli.register(ListCommand);
	cli.register(AuthListCommand);
	cli.register(AuthLoginCommand);
	cli.register(AuthLogoutCommand);
	cli.register(AuthStatusCommand);
	cli.register(AuthSwitchCommand);
	cli.register(SynchronizeCommand);
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
			process.stderr.write(`${stringifyJson({ error: message }, argv.includes("--pretty"))}\n`);
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
