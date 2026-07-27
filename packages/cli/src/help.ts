import {
	ALLOWED_RELATIONS,
	ENTITY_KINDS,
	ID_PREFIX,
	STATUS_FLOW,
	STRUCTURAL_RELATION_TYPES,
	getArchiveStatus,
	isStructuralRelationType,
	type EntityKind
} from "@agent-issues/core";
import { DEFAULT_CONTEXT_KEY } from "@agent-issues/api-local";
import type { ListSkillsResult } from "./skill-installer.js";

type OptionSpec = {
	name: string;
	description: string;
	required?: boolean;
	allowedValues?: readonly string[];
};

type PositionalSpec = {
	name: string;
	description: string;
	required?: boolean;
	allowedValues?: readonly string[];
};

type CommandSpec = {
	name: string;
	summary: string;
	usage: string[];
	positionals?: PositionalSpec[];
	options?: OptionSpec[];
	examples?: string[];
	notes?: string[];
	output?: {
		human?: string[];
		json?: string[];
	};
};

type GlobalOptionSpec = OptionSpec;

export type HelpPayload = {
	name: string;
	summary: string;
	globalOptions: GlobalOptionSpec[];
	commands: Array<{ name: string; summary: string; usage: string[] }>;
	discovery: string[];
	command?: CommandSpec;
};

export type CapabilitiesPayload = {
	help: HelpPayload;
	schema: SchemaPayload;
	skills: ListSkillsResult;
};

export type SchemaPayload = {
	entityKinds: Array<{
		kind: EntityKind;
		idPrefix: string;
		initialStatus: string;
		statuses: readonly string[];
		archiveStatus: string;
	}>;
	relationTypes: string[];
	allowedRelations: typeof ALLOWED_RELATIONS;
	structuralRelationTypes: readonly string[];
	parentRules: Array<{
		parentKind: EntityKind;
		childKind: EntityKind;
		relationType: string;
	}>;
	context: {
		storage: "database";
		scopes: string[];
		defaultKey: string;
		listCommand: string;
		readCommand: string;
		searchCommand: string;
		conflictsCommand: string;
		initializeCommand: string;
		defineCommand: string;
		forgetCommand: string;
		termFields: string[];
	};
};

const GLOBAL_OPTIONS: GlobalOptionSpec[] = [
	{
		name: "--db <path>",
		description: "Use a specific SQLite database path."
	},
	{
		name: "--json",
		description: "Print machine-readable JSON. Entity commands use compact output by default; pass --view full for complete records."
	},
	{
		name: "--pretty",
		description: "Pretty-print JSON when used with --json."
	},
	{
		name: "--help, -h",
		description: "Show help for the whole CLI or the selected command."
	}
];

const ENTITY_KIND_VALUES = ENTITY_KINDS;
const RELATION_TYPE_VALUES = Array.from(new Set(ALLOWED_RELATIONS.map((relation) => relation.type))).sort();
const STATUS_VALUES = Array.from(new Set(Object.values(STATUS_FLOW).flat())).sort();
const ENTITY_VIEW_OPTION: OptionSpec = {
	name: "--view <compact|full>",
	description: "Select compact or full JSON output. Compact is the default; use full for authored content and complete records. Human-readable output is unchanged.",
	allowedValues: ["compact", "full"]
};

const COMMAND_SPECS: CommandSpec[] = [
	{
		name: "context",
		summary: "Read and update shared and initiative-scoped database-backed context.",
		usage: [
			"agent-issues context",
			"agent-issues context list",
			"agent-issues context show",
			"agent-issues context show --view initiatives --query <text>",
			"agent-issues context show default",
			"agent-issues context show <entityOrInitiativeId>",
			"agent-issues context search <query> [--view <all|global|initiatives>]",
			"agent-issues context conflicts [<query>] [--view <all|initiatives>]",
			"agent-issues context set [--scope <entityOrInitiativeId|default>] --title <title> --summary <summary> [--view <compact|full>]",
			"agent-issues context define <term> [--scope <entityOrInitiativeId|default>] --definition <definition> [--avoid <comma-separated terms>] [--view <compact|full>]",
			"agent-issues context forget <term> [--scope <entityOrInitiativeId|default>] [--view <compact|full>]"
		],
		positionals: [
			{
				name: "subcommand",
				description: "Context action. Defaults to show.",
				allowedValues: ["list", "show", "search", "conflicts", "set", "define", "forget"]
			},
			{
				name: "scopeOrTerm",
				description: "Context scope for show, or term name for define and forget."
			}
		],
		options: [
			{
				name: "--scope <entityOrInitiativeId|default>",
				description: "Resolve context from an initiative or any entity inside that initiative."
			},
			{
				name: "--title <title>",
				description: "Context title for `context set`."
			},
			{
				name: "--summary <summary>",
				description: "Context summary for `context set`."
			},
			{
				name: "--definition <definition>",
				description: "Canonical term definition for `context define`."
			},
			{
				name: "--query <text>",
				description: "Filter project-wide context discovery for `context show`, `context search`, or `context conflicts`."
			},
			{
				name: "--avoid <comma-separated terms>",
				description: "Alternative terms to avoid for `context define`."
			},
			{
				name: "--view <all|global|initiatives|compact|full>",
				description: "For show, search, and conflicts: all/global/initiatives. For set, define, and forget: compact/full JSON acknowledgements."
			},
			{
				name: "--terms-only",
				description: "For `context search`, return only the matching term entries instead of the full project directory summary."
			}
		],
		examples: [
			"agent-issues context --json",
			"agent-issues context show --view initiatives --query review --json",
			"agent-issues context list --json",
			"agent-issues context show default --json",
			"agent-issues context show INIT1 --json",
			"agent-issues context show ISS3 --json",
			"agent-issues context search review --view initiatives --json",
			"agent-issues context search review --view initiatives --terms-only --json",
			"agent-issues context conflicts --json",
			'agent-issues context set --scope INIT1 --title "Payments Context" --summary "Glossary for the payments initiative."',
			'agent-issues context define "Order" --scope INIT1 --definition "A customer request that the system accepts and tracks to fulfillment." --avoid "purchase, transaction" --json',
			'agent-issues context forget "Legacy order" --scope INIT1 --json'
		],
		notes: [
			"Context is stored in the agent-issues database, not in a raw CONTEXT.md file.",
			"`context show` without a scope returns the project-wide context directory: shared context plus initiative-scoped discovery.",
			"Use `context show default` to read only the shared project glossary.",
			"Use `context search <query>` or `context show --query <text>` to narrow project-wide discovery before reading a specific initiative scope.",
			"Use `context search <query> --terms-only --json` when you only need matching definitions and do not want the surrounding project directory summary.",
			"Use `context conflicts` to list duplicate labels across scopes so agents can resolve terminology collisions early.",
			"Initiative-scoped context is the primary model: resolve the context from the active initiative or any entity inside it.",
			"Read the context before using project-specific vocabulary, and update it immediately when a term is resolved."
		],
		output: {
			human: [
				"Context metadata block, project-wide context directory, or context list",
				"One line per term with definition and optional avoid list, plus duplicate-scope warnings in the project directory"
			],
			json: ["contexts", "context", "terms", "shared", "initiatives", "duplicateTerms", "view", "query", "conflictsOnly"]
		}
	},
	{
		name: "init",
		summary: "Initialize the local data store.",
		usage: ["agent-issues init"],
		examples: ["agent-issues init"],
		output: {
			human: ["Initialized data store at <dbPath>"],
			json: ["command", "dbPath", "status"]
		}
	},
	{
		name: "current-tenant",
		summary: "Show which tenant the CLI would use from the current workspace.",
		usage: ["agent-issues current-tenant"],
		examples: ["agent-issues current-tenant", "agent-issues current-tenant --json"],
		notes: [
			"The CLI always derives the tenant automatically - there is exactly one tenant per OS user.",
			"Workspace root discovery walks upward from the current directory and prefers pnpm-workspace.yaml, then .git, then package.json."
		],
		output: {
			human: ["Current tenant, workspace root, and database path"],
			json: ["command", "tenantId", "workspaceRoot", "dbPath"]
		}
	},
	{
		name: "list-tenants",
		summary: "List the tenants currently present in the selected database.",
		usage: ["agent-issues list-tenants", "agent-issues list-tenants --db <path> --json"],
		examples: ["agent-issues list-tenants", "agent-issues list-tenants --json"],
		notes: [
			"The command lists tenants with any stored entities, relations, context, terms, or handoffs.",
			"Use this before `delete-tenant` to avoid deleting the wrong tenant."
		],
		output: {
			human: ["Database path followed by one line per tenant with per-table counts"],
			json: ["command", "dbPath", "currentTenantId", "tenants"]
		}
	},
	{
		name: "delete-tenant",
		summary: "Delete one tenant and all of its rows from the selected database.",
		usage: ["agent-issues delete-tenant <tenantId> --force"],
		positionals: [{ name: "tenantId", description: "Tenant ID to delete.", required: true }],
		options: [
			{
				name: "--force",
				description: "Required safety flag for whole-tenant deletion."
			}
		],
		examples: ["agent-issues delete-tenant payments --force", "agent-issues delete-tenant agent-issues-de3fbe614e21 --force --json"],
		notes: [
			"This removes the tenant's counters, entities, relations, context, context terms, and handoffs.",
			"Tenant IDs are sanitized (display-style input like `Payments Sandbox` resolves to `payments-sandbox`).",
			"The command is irreversible. Run `list-tenants` first if you are not sure which tenant to delete."
		],
		output: {
			human: ["Deleted tenant summary with per-table removal counts, or a not-found message"],
			json: ["command", "dbPath", "tenantId", "displayName", "removed", "counts", "counters"]
		}
	},
	{
		name: "rename-tenant",
		summary: "Rename one tenant namespace across the selected database.",
		usage: ["agent-issues rename-tenant <tenantId> <newTenantId> --force"],
		positionals: [
			{ name: "tenantId", description: "Existing tenant ID to rename.", required: true },
			{ name: "newTenantId", description: "New tenant ID to assign.", required: true }
		],
		options: [
			{
				name: "--force",
				description: "Required safety flag for whole-tenant renaming."
			}
		],
		examples: ["agent-issues rename-tenant smoke-handoff handoff-sandbox --force", "agent-issues rename-tenant payments-sandbox payments --force --json"],
		notes: [
			"Tenant IDs are sanitized the same way (display-style input like `Payments Sandbox` resolves to `payments-sandbox`).",
			"Renaming updates counters, entities, relations, contexts, context terms, and handoffs.",
			"The target tenant must not already exist. Run `list-tenants` first if you are not sure."
		],
		output: {
			human: ["Renamed tenant summary with per-table moved counts, or a not-found message"],
			json: ["command", "dbPath", "previousTenantId", "previousDisplayName", "newTenantId", "newDisplayName", "renamed", "counts", "counters"]
		}
	},
	{
		name: "auth list",
		summary: "List saved logins in switching order and mark the active saved login.",
		usage: ["agent-issues auth list"],
		examples: ["agent-issues auth list", "agent-issues auth list --json"],
		notes: [
			"The permanent local login is listed first, followed by remote saved logins in creation order.",
			"Never prints raw access tokens, in either human or --json output."
		],
		output: {
			human: ["One line per saved login, with * marking the active login"],
			json: ["command", "logins"]
		}
	},
	{
		name: "auth login",
		summary: "Discover a remote service's Entra configuration and create or refresh a named saved login.",
		usage: ["agent-issues auth login", "agent-issues auth login --name <name> --url <url>"],
		options: [
			{
				name: "--name <name>",
				description: "Unique saved-login name for one-shot use. Prompted when omitted interactively."
			},
			{
				name: "--url <url>",
				description: "Remote agent-issues service URL for one-shot use. Prompted when omitted interactively."
			}
		],
		examples: ["agent-issues auth login", "agent-issues auth login --name work --url https://agent-issues.example.com"],
		notes: [
			"Remote login fetches /.well-known/agent-issues from the normalized service URL and uses its tenant and client IDs for device-code sign-in.",
			"Interactive login prompts for the saved-login name and service URL.",
			"When --json is present, --name and --url are required so prompt text never mixes with JSON output.",
			"Refreshing an existing name preserves saved-login switching order and makes that login active."
		],
		output: {
			human: ["Saved-login destination, signed-in identity, tenant, and session expiry"],
			json: ["command", "login"]
		}
	},
	{
		name: "auth logout",
		summary: "Remove a remote saved login.",
		usage: ["agent-issues auth logout [name]"],
		positionals: [
			{
				name: "name",
				description: "Remote saved login to remove. Defaults to the active saved login.",
				required: false
			}
		],
		examples: ["agent-issues auth logout work", "agent-issues auth logout --json"],
		notes: [
			"Removing the active remote saved login activates local atomically.",
			"The permanent local saved login cannot be removed."
		],
		output: {
			human: ["Confirmation of which saved login was removed"],
			json: ["command", "name"]
		}
	},
	{
		name: "auth status",
		summary: "Show the active saved login and its destination and identity details.",
		usage: ["agent-issues auth status"],
		examples: ["agent-issues auth status", "agent-issues auth status --json"],
		notes: ["Never prints raw access tokens, in either human or --json output."],
		output: {
			human: ["Active saved-login name, destination kind, remote URL when applicable, identity, and expiry"],
			json: ["command", "login"]
		}
	},
	{
		name: "auth switch",
		summary: "Activate a named saved login or advance to the next saved login.",
		usage: ["agent-issues auth switch [name]"],
		positionals: [{ name: "name", description: "Saved login to activate. Omit to advance in switching order.", required: false }],
		examples: ["agent-issues auth switch work", "agent-issues auth switch local", "agent-issues auth switch"],
		notes: [
			"Without a name, advances from local through remote saved logins in creation order, then wraps to local.",
			"Never prints the raw access token, in either human or --json output."
		],
		output: {
			human: ["Confirmation of the saved login switched to"],
			json: ["command", "login"]
		}
	},
	{
		name: "backfill-bodies",
		summary: "Generate metadata-derived bodies for initiatives, issues, PRDs, user stories, and ADRs when authored bodies are missing.",
		usage: [
			"agent-issues backfill-bodies [--kinds <comma-separated kinds>] [--dry-run] [--force]",
			"agent-issues backfill-bodies --all-tenants --json"
		],
		options: [
			{
				name: "--kinds <initiative,issue,prd,userStory,adr>",
				description: "Comma-separated record kinds to backfill. Defaults to initiative,issue,prd,userStory,adr."
			},
			{
				name: "--all-tenants",
				description: "Process every tenant already present in the selected database instead of only the current or explicit tenant."
			},
			{
				name: "--dry-run",
				description: "Preview what would be updated without writing any bodies to the database."
			},
			{
				name: "--force",
				description: "Overwrite existing bodies instead of only filling empty ones."
			}
		],
		examples: [
			"agent-issues backfill-bodies",
			"agent-issues backfill-bodies --kinds initiative,prd,userStory,adr --json",
			"agent-issues backfill-bodies --dry-run --json",
			"agent-issues backfill-bodies --all-tenants --force"
		],
		notes: [
			"By default the command only fills empty bodies and leaves authored content unchanged.",
			"Generated bodies are derived from existing tracker metadata such as structural parents, fixing issues, and dependency links.",
			"Use `--all-tenants` to sweep the entire shared database; otherwise the command only touches the current or explicitly selected tenant.",
			"Use `--dry-run` to preview the counts without mutating the database.",
			"The command is idempotent unless `--force` is supplied."
		],
		output: {
			human: [
				"Backfill scope, database path, selected kinds, dry-run mode, and overwrite mode",
				"One section per tenant with considered, updated, and skipped counts by kind"
			],
			json: ["command", "dbPath", "scope", "kinds", "dryRun", "force", "tenants"]
		}
	},
	{
		name: "create",
		summary: "Create an entity, optionally under a structural parent.",
		usage: ["agent-issues create <kind> --title <title> [--parent <id>] [--status <status>] [--body <markdown> | --body-file <path|->] [--view <compact|full>]"],
		positionals: [
			{
				name: "kind",
				description: "Entity kind to create.",
				required: true,
				allowedValues: ENTITY_KIND_VALUES
			}
		],
		options: [
			{
				name: "--title <title>",
				description: "Entity title.",
				required: true
			},
			{
				name: "--parent <id>",
				description: "Structural parent ID when one is required by the workflow."
			},
			{
				name: "--link <relationType> <targetId>",
				description: "Create a relation from the new entity to a target. Repeat for each link."
			},
			{
				name: "--status <status>",
				description: "Override the default initial status.",
				allowedValues: STATUS_VALUES
			},
			{
				name: "--body <markdown>",
				description: "Authored markdown body for the record."
			},
			{
				name: "--body-file <path|->",
				description: "Read the authored markdown body from a file, or from stdin when the value is `-`."
			},
			ENTITY_VIEW_OPTION
		],
		examples: [
			'agent-issues create initiative --title "Workflow tooling"',
			'agent-issues create prd --title "Handoff support" --parent INIT1',
			'agent-issues create issue --title "Add help schema" --parent INIT1',
			'agent-issues create handoff --title "Resume export work" --body-file - --link handsOff ISS1',
			'agent-issues create issue --title "Split parser edge cases" --parent ISS1',
			'agent-issues create issue --title "Add help schema" --parent INIT1 --body-file /tmp/iss1.md'
		],
		notes: [
			"Valid structural parent-child pairs are exposed by `agent-issues schema --json`.",
			"Issues can be created under initiatives as tracked work, or under other issues as structural sub-issues.",
			"If no status is supplied, the CLI uses the first status in the workflow for that kind.",
			"Use `--body-file` for multiline markdown to avoid shell quoting problems.",
			"Use `--link` to create graph relations atomically with the entity.",
			"Create a handoff with `--title`, `--body` or `--body-file`, and `--link handsOff <focusId>`."
		],
		output: {
			human: ["<id> <kind> <status> <title>"],
			json: ["id", "kind", "title", "status", "body", "createdAt", "updatedAt"]
		}
	},
	{
		name: "archive",
		summary: "Move one entity to its archive status.",
		usage: ["agent-issues archive <id> [--view <compact|full>]"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		options: [ENTITY_VIEW_OPTION],
		examples: ["agent-issues archive ISS1"],
		notes: ["Archive status depends on entity kind and is exposed by `agent-issues schema --json`."],
		output: {
			human: ["Archived <id> from <previousStatus> to <status>"],
			json: ["entity", "previousStatus"]
		}
	},
	{
		name: "delete",
		summary: "Delete one leaf entity.",
		usage: ["agent-issues delete <id> [--view <compact|full>]"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		options: [ENTITY_VIEW_OPTION],
		examples: ["agent-issues delete ISS2"],
		notes: ["Deletion fails when the entity still has outgoing relations."],
		output: {
			human: ["Deleted <id> <kind> <title>"],
			json: ["entity", "removed"]
		}
	},
	{
		name: "bundle",
		summary: "Show one initiative bundle directly.",
		usage: ["agent-issues bundle <initiativeId> [--view <compact|full>]"],
		positionals: [{ name: "initiativeId", description: "Initiative ID.", required: true }],
		options: [ENTITY_VIEW_OPTION],
		examples: ["agent-issues bundle INIT1", "agent-issues bundle INIT1 --json"],
		notes: [
			"Compact JSON is the default and preserves bundle groups and link shapes while projecting every entity to id, kind, status, and title.",
			"Use --view full when the intentional initiative-wide read requires complete records, authored content, and links.",
			"Reserve bundle for intentional initiative-wide reads; use filtered list and relations commands for routine discovery."
		],
		output: {
			human: [
				"<initiativeId> <status> <title>",
				"PRDs: <id:status, ...>",
				"User Stories: <id:status, ...>",
				"ADRs: <id:status, ...>",
				"Issues: <id:status, ...>",
				"Fixes / Sub-issues / Blockers / Constrains summaries"
			],
			json: ["Full: InitiativeBundle with complete records", "Compact: same bundle groups and links with CompactEntity values"]
		}
	},
	{
		name: "export",
		summary: "Export one initiative or the whole project as markdown with graph metadata in frontmatter.",
		usage: [
			"agent-issues export <initiativeId> [--output <path>] [--force]",
			"agent-issues export project [--output <path>] [--force]",
			"agent-issues export <initiativeId|project> --single-file [--output <file>]"
		],
		positionals: [
			{
				name: "initiativeId|project",
				description: "One initiative ID, or `project` for a tenant-wide export.",
				required: true
			}
		],
		options: [
			{
				name: "--output <path>",
				description: "Directory path for grouped export output, or a file path when used with `--single-file`."
			},
			{
				name: "--single-file",
				description: "Emit one markdown document instead of a grouped folder export. Without `--output`, prints to stdout."
			},
			{
				name: "--force",
				description: "Replace an existing export directory when writing grouped output."
			}
		],
		examples: [
			"agent-issues export INIT1",
			"agent-issues export project --output ./tmp/export --force",
			"agent-issues export INIT1 --single-file",
			"agent-issues export INIT1 --single-file --output ./tmp/init1.md",
			"agent-issues export INIT1 --json"
		],
		notes: [
			"Grouped export is the default: it creates a folder tree that mirrors entity-kind and relation groupings in the database.",
			"Single-file export remains available with `--single-file` for piping or ad hoc capture.",
			"The YAML frontmatter summarizes counts, context, and relation edges so connections remain machine-readable.",
			"Project export includes normal entity and relation output, plus one nested initiative export per initiative."
		],
		output: {
			human: [
				"Default: export summary with output path and file count for a grouped folder export",
				"With `--single-file`: one markdown document with YAML frontmatter, entity sections, relation summaries, and context sections"
			],
			json: ["mode", "scope", "initiativeId", "generatedAt", "markdown", "outputPath", "files"]
		}
	},
	{
		name: "move",
		summary: "Move one entity under a new structural parent.",
		usage: ["agent-issues move <id> <newParentId> [--view <compact|full>]"],
		positionals: [
			{ name: "id", description: "Entity ID to move.", required: true },
			{ name: "newParentId", description: "New structural parent ID.", required: true }
		],
		options: [ENTITY_VIEW_OPTION],
		examples: ["agent-issues move US1 PRD2", "agent-issues move ISS7 ISS1"],
		notes: [
			"Move rejects incompatible parent kinds, cycles, and initiatives.",
			"Use move to reparent a sub-issue under a different parent issue without rebuilding its other relations."
		],
		output: {
			human: ["Moved <id> from <previousParentId|none> to <newParentId> as <relationType>"],
			json: ["entity", "previousParentId", "newParentId", "relationType"]
		}
	},
	{
		name: "relations",
		summary: "Show incoming and outgoing relations for one entity.",
		usage: ["agent-issues relations <id> [--direction <incoming|outgoing|both>] [--type <comma-separated types>] [--view <compact|full>]"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		options: [
			{
				name: "--direction <incoming|outgoing|both>",
				description: "Select incoming, outgoing, or both relation directions. Defaults to both.",
				allowedValues: ["incoming", "outgoing", "both"]
			},
			{
				name: "--type <comma-separated types>",
				description: "Include only the selected relation types.",
				allowedValues: RELATION_TYPE_VALUES
			},
			ENTITY_VIEW_OPTION
		],
		examples: ["agent-issues relations <id>", "agent-issues relations <id> --direction incoming --type blocks,decomposes --json"],
		notes: [
			"Compact JSON is the default and returns the focused entity and selected edges with id, kind, status, and title only.",
			"Use --view full when complete entity records or authored content are required.",
			"Use --direction and --type to select edges before serialization."
		],
		output: {
			human: [
				"<id> <kind> <status> <title>",
				"Incoming section",
				"Outgoing section"
			],
			json: ["Full: EntityDetails with complete records", "Compact: { entity: CompactEntity, incoming: CompactRelation[], outgoing: CompactRelation[] }"]
		}
	},
	{
		name: "orphans",
		summary: "List entities not reachable from any initiative.",
		usage: ["agent-issues orphans [kind]"],
		positionals: [
			{
				name: "kind",
				description: "Optional entity kind filter.",
				allowedValues: ENTITY_KIND_VALUES
			}
		],
		examples: ["agent-issues orphans", "agent-issues orphans issue --json"],
		output: {
			human: ["One line per orphaned entity: <id> <kind> <status> <title>"],
			json: ["Array<EntityRecord>"]
		}
	},
	{
		name: "status",
		summary: "Update an entity status.",
		usage: ["agent-issues status <id> <status> [--view <compact|full>]"],
		positionals: [
			{ name: "id", description: "Entity ID.", required: true },
			{
				name: "status",
				description: "New status.",
				required: true,
				allowedValues: STATUS_VALUES
			}
		],
		options: [ENTITY_VIEW_OPTION],
		examples: ["agent-issues status ISS1 in-progress", "agent-issues status US1 done"],
		notes: [
			"Each entity kind only accepts its own status flow.",
			"Issues cannot move to in-progress or done while blocked by a non-done issue.",
			"Parent issues also cannot move to in-progress or done while any sub-issue remains open."
		],
		output: {
			human: ["Updated <id> from <previousStatus> to <status>"],
			json: ["entity", "previousStatus"]
		}
	},
	{
		name: "edit",
		summary: "Update an entity title and/or authored markdown body.",
		usage: ["agent-issues edit <id> [--title <title>] [--body <markdown> | --body-file <path|->] [--view <compact|full>]"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		options: [
			{
				name: "--title <title>",
				description: "Replacement entity title."
			},
			{
				name: "--body <markdown>",
				description: "Replacement authored markdown body for the record."
			},
			{
				name: "--body-file <path|->",
				description: "Read the authored markdown body from a file, or from stdin when the value is `-`."
			},
			ENTITY_VIEW_OPTION
		],
		examples: [
			'agent-issues edit ISS1 --body "# Plan\\n\\nDetails here."',
			'agent-issues edit ISS1 --body-file /tmp/iss1.md',
			'agent-issues edit HO1 --title "Resume export work" --body-file -'
		],
		notes: [
			"Supply at least one of `--title`, `--body`, or `--body-file`; supplied fields replace their previously stored values.",
			"Use `--body-file` for multiline markdown to avoid shell quoting problems."
		],
		output: {
			human: ["Updated <id> <kind> <title>"],
			json: ["id", "kind", "title", "status", "body", "createdAt", "updatedAt"]
		}
	},
	{
		name: "link",
		summary: "Create a relation between entities.",
		usage: ["agent-issues link <fromId> <relationType> <toId> [--view <compact|full>]"],
		positionals: [
			{ name: "fromId", description: "Source entity ID.", required: true },
			{
				name: "relationType",
				description: "Relation type.",
				required: true,
				allowedValues: RELATION_TYPE_VALUES
			},
			{ name: "toId", description: "Target entity ID.", required: true }
		],
		options: [ENTITY_VIEW_OPTION],
		examples: [
			"agent-issues link ISS1 fixes US1",
			"agent-issues link ADR1 constrains ISS1",
			"agent-issues link ISS2 blocks ISS1",
			"agent-issues link ISS1 decomposes ISS7"
		],
		notes: [
			"Allowed relation pairs are exposed by `agent-issues schema --json`.",
			"For structural parent-child work, prefer `create --parent` or `move` over `link` so the intent stays explicit.",
			"The CLI rejects self-links and cycle-forming `blocks` or `supersedes` links."
		],
		output: {
			human: [
				"Linked <fromId> -> <toId> as <relationType>",
				"or Relation already existed: <fromId> -> <toId> as <relationType>"
			],
			json: ["relation", "created"]
		}
	},
	{
		name: "unlink",
		summary: "Remove one relation between entities.",
		usage: ["agent-issues unlink <fromId> <relationType> <toId> [--view <compact|full>]"],
		positionals: [
			{ name: "fromId", description: "Source entity ID.", required: true },
			{
				name: "relationType",
				description: "Relation type.",
				required: true,
				allowedValues: RELATION_TYPE_VALUES
			},
			{ name: "toId", description: "Target entity ID.", required: true }
		],
		options: [ENTITY_VIEW_OPTION],
		examples: ["agent-issues unlink ISS1 fixes US1"],
		notes: ["Unlink rejects structural removals that would orphan a subtree."],
		output: {
			human: [
				"Unlinked <fromId> -> <toId> as <relationType>",
				"or Relation did not exist: <fromId> -> <toId> as <relationType>"
			],
			json: ["relation", "removed"]
		}
	},
	{
		name: "show",
		summary: "Show an entity or initiative bundle.",
		usage: ["agent-issues show <id> [--view <compact|full>]"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		options: [ENTITY_VIEW_OPTION],
		examples: ["agent-issues show INIT1", "agent-issues show ISS1 --view full --json"],
		notes: [
			"Compact JSON is the default and projects entities to id, kind, status, and title.",
			"Use --view full when authored body content or the complete stored record is required."
		],
		output: {
			human: [
				"For initiatives: same shape as bundle",
				"For other kinds: same shape as relations"
			],
			json: ["Full: InitiativeBundle | EntityDetails", "Compact: CompactInitiativeBundle | CompactEntityDetails"]
		}
	},
	{
		name: "list",
		summary: "List entities by kind.",
		usage: ["agent-issues list <kind> [--status <comma-separated statuses>] [--parent <id>] [--limit <count>] [--view <compact|full>]"],
		positionals: [
			{
				name: "kind",
				description: "Entity kind.",
				required: true,
				allowedValues: ENTITY_KIND_VALUES
			}
		],
		options: [
			{
				name: "--status <comma-separated statuses>",
				description: "Include only entities with a selected status.",
				allowedValues: STATUS_VALUES
			},
			{
				name: "--parent <id>",
				description: "Include only entities with this structural parent."
			},
			{
				name: "--limit <count>",
				description: "Return at most this many entities. Compact total reports the full filtered count."
			},
			ENTITY_VIEW_OPTION
		],
		examples: ["agent-issues list issue", "agent-issues list issue --status todo,in-progress --parent <initiativeId> --limit 20 --json"],
		notes: [
			"Compact JSON is the default and returns { items, total }; total is the filtered count before --limit is applied.",
			"Use --view full when complete entity records or authored content are required.",
			"Use --status, --parent, and --limit to select records before serialization.",
			"Accepted status values depend on the entity kind; use agent-issues schema --json to inspect each kind's workflow."
		],
		output: {
			human: ["One line per entity: <id> <status> <title>"],
			json: ["Full: Array<EntityRecord>", "Compact: { items: CompactEntity[], total: number }"]
		}
	},
	{
		name: "serve-site",
		summary: "Serve a live read-only site that refreshes when the database changes.",
		usage: ["agent-issues serve-site [--port <port>]", "agent-issues serve-site --json"],
		options: [
			{
				name: "--port <port>",
				description: "Port for the local HTTP server. Defaults to 4173."
			}
		],
		examples: [
			"agent-issues serve-site",
			"agent-issues serve-site --port 4300",
			"agent-issues serve-site --db ~/.agent-issues/agent-issues.db --json"
		],
		notes: [
			"The server exposes the built site assets plus /site-config.json, /api/snapshot, and /events.",
			"Keep the process running to continue broadcasting database changes to connected browsers."
		],
		output: {
			human: [
				"Serving live site at <url>",
				"Database path and port summary"
			],
			json: ["dbPath", "host", "port", "url", "openInBrowser"]
		}
	},
	{
		name: "open-site",
		summary: "Start the live site server and request a browser launch.",
		usage: ["agent-issues open-site [--port <port>]", "agent-issues open-site --json"],
		options: [
			{
				name: "--port <port>",
				description: "Port for the local HTTP server. Defaults to 4173."
			}
		],
		examples: [
			"agent-issues open-site",
			"agent-issues open-site --port 4300",
			"agent-issues open-site --db ~/.agent-issues/agent-issues.db --json"
		],
		notes: [
			"This command serves the same live site as serve-site, then asks the OS to open the browser.",
			"Keep the process running after launch so the page can continue receiving change notifications."
		],
		output: {
			human: [
				"Opened live site at <url>",
				"Database path and port summary"
			],
			json: ["dbPath", "host", "port", "url", "openInBrowser"]
		}
	},
	{
		name: "stop-site",
		summary: "Ask the local live site server on the selected port to stop.",
		usage: ["agent-issues stop-site [--port <port>]", "agent-issues stop-site --json"],
		options: [
			{
				name: "--port <port>",
				description: "Port for the local HTTP server. Defaults to 4173."
			}
		],
		examples: [
			"agent-issues stop-site",
			"agent-issues stop-site --port 4300",
			"agent-issues stop-site --json"
		],
		notes: [
			"This command only stops the local live site server listening on the selected port.",
			"If some other server is running on that port, the command reports that the listener is not a stoppable agent-issues live site."
		],
		output: {
			human: ["Stopped live site at <url> or reported that no live site was running there"],
			json: ["host", "port", "url", "reachable", "stopped"]
		}
	},
	{
		name: "help",
		summary: "Show general or command-specific help.",
		usage: ["agent-issues help [command]", "agent-issues <command> --help"],
		positionals: [{ name: "command", description: "Optional command name." }],
		examples: ["agent-issues help", "agent-issues help create --json", "agent-issues create --help"]
	},
	{
		name: "install-skills",
		summary: "Install the packaged agent-issues skills into an agent skills directory.",
		usage: ["agent-issues install-skills [--target <path>] [--force]", "agent-issues install-skills --json"],
		options: [
			{
				name: "--target <path>",
				description: "Destination directory for installed skills. Defaults to ~/.agents/skills."
			},
			{
				name: "--force",
				description: "Overwrite existing installed copies of the packaged skills."
			}
		],
		examples: [
			"agent-issues install-skills",
			"agent-issues install-skills --target ./tmp/skills --json",
			"agent-issues install-skills --force"
		],
		notes: [
			"Installed skill identities are prefixed with `ai-` to keep them short and avoid clashing with existing generic skills.",
			"The command copies the packaged skill directories and rewrites the installed skill name to match the prefixed identity."
		],
		output: {
			human: [
				"Installed skills to <targetDir>",
				"One line per skill: <installedName> <status> <destinationDir>"
			],
			json: ["targetDir", "installed"]
		}
	},
	{
		name: "install-agent",
		summary: "Install the packaged Agent Issues custom agent into a VS Code prompts directory.",
		usage: ["agent-issues install-agent [--target <path>] [--force]", "agent-issues install-agent --json"],
		options: [
			{
				name: "--target <path>",
				description: "Destination prompts directory for the custom agent. Defaults to the VS Code user prompts directory for the current OS."
			},
			{
				name: "--force",
				description: "Overwrite the existing installed custom agent and hook files."
			}
		],
		examples: [
			"agent-issues install-agent",
			"agent-issues install-agent --target ./tmp/prompts --json",
			"agent-issues install-agent --force"
		],
		notes: [
			"This installs both the custom agent markdown file and its hook script.",
			"The installed agent rewrites its hook command to point at the installed hook file in the target prompts directory.",
			"Enable `chat.useCustomAgentHooks` in VS Code so the custom agent can enforce issue-context preloading when it is active."
		],
		output: {
			human: [
				"Installed agent to <targetDir>",
				"Status line plus the installed agent file and hook file paths"
			],
			json: ["targetDir", "installed"]
		}
	},
	{
		name: "list-skills",
		summary: "Report whether the packaged ai skills are installed in an agent skills directory.",
		usage: ["agent-issues list-skills [--target <path>]", "agent-issues list-skills --json"],
		options: [
			{
				name: "--target <path>",
				description: "Directory to inspect. Defaults to ~/.agents/skills."
			}
		],
		examples: [
			"agent-issues list-skills",
			"agent-issues list-skills --target ./tmp/skills --json"
		],
		notes: [
			"Only the packaged `ai-*` skill directories are reported.",
			"This command does not modify the target directory."
		],
		output: {
			human: [
				"Packaged skills in <targetDir>",
				"One line per skill: <installedName> <status> <destinationDir>"
			],
			json: ["targetDir", "skills"]
		}
	},
	{
		name: "list-agent",
		summary: "Report whether the packaged Agent Issues custom agent is installed in a VS Code prompts directory.",
		usage: ["agent-issues list-agent [--target <path>]", "agent-issues list-agent --json"],
		options: [
			{
				name: "--target <path>",
				description: "Prompts directory to inspect. Defaults to the VS Code user prompts directory for the current OS."
			}
		],
		examples: ["agent-issues list-agent", "agent-issues list-agent --target ./tmp/prompts --json"],
		notes: [
			"The command reports whether both the custom agent file and its hook file are present.",
			"A partial status means one file exists without the other."
		],
		output: {
			human: [
				"Packaged agent in <targetDir>",
				"Status line plus the expected installed agent file and hook file paths"
			],
			json: ["targetDir", "agent"]
		}
	},
	{
		name: "uninstall-skills",
		summary: "Remove the packaged ai skills from an agent skills directory.",
		usage: ["agent-issues uninstall-skills [--target <path>]", "agent-issues uninstall-skills --json"],
		options: [
			{
				name: "--target <path>",
				description: "Directory from which the packaged skills should be removed. Defaults to ~/.agents/skills."
			}
		],
		examples: [
			"agent-issues uninstall-skills",
			"agent-issues uninstall-skills --target ./tmp/skills --json"
		],
		notes: [
					"Packaged `ai-*` skill directories are removed. Shared skill files are removed only when they still match the packaged copies.",
			"Missing skill directories are reported but do not cause the command to fail."
		],
		output: {
			human: [
				"Removed skills from <targetDir>",
				"One line per skill: <installedName> <status> <destinationDir>"
			],
			json: ["targetDir", "removed"]
		}
	},
	{
		name: "uninstall-agent",
		summary: "Remove the packaged Agent Issues custom agent from a VS Code prompts directory.",
		usage: ["agent-issues uninstall-agent [--target <path>]", "agent-issues uninstall-agent --json"],
		options: [
			{
				name: "--target <path>",
				description: "Prompts directory from which the custom agent and hook should be removed. Defaults to the VS Code user prompts directory for the current OS."
			}
		],
		examples: ["agent-issues uninstall-agent", "agent-issues uninstall-agent --target ./tmp/prompts --json"],
		notes: [
			"Both the custom agent file and its hook file are removed.",
			"Missing files are reported but do not cause the command to fail."
		],
		output: {
			human: [
				"Removed agent from <targetDir>",
				"Status line plus the removed agent file and hook file paths"
			],
			json: ["targetDir", "removed"]
		}
	},
	{
		name: "schema",
		summary: "Show machine-discoverable workflow schema and relation rules.",
		usage: ["agent-issues schema", "agent-issues schema --json"],
		examples: ["agent-issues schema", "agent-issues schema --json"],
		notes: [
			"Use this command to discover entity kinds, status flows, allowed relations, structural relations, and archive mappings."
		],
		output: {
			human: [
				"Entity kinds section",
				"Relation types line",
				"Structural relation types line",
				"Allowed relations section",
				"Structural parent rules section"
			],
			json: ["entityKinds", "relationTypes", "allowedRelations", "structuralRelationTypes", "parentRules"]
		}
	},
	{
		name: "capabilities",
		summary: "Show combined help and schema data in one discovery payload.",
		usage: ["agent-issues capabilities [--target <path>]", "agent-issues capabilities --json"],
		options: [
			{
				name: "--target <path>",
				description: "Directory whose packaged skill installation state should be included. Defaults to ~/.agents/skills."
			}
		],
		examples: [
			"agent-issues capabilities",
			"agent-issues capabilities --json",
			"agent-issues capabilities --target ./tmp/skills --json"
		],
		notes: [
			"Use this command when an agent wants the command catalog, workflow schema, and packaged skill installation state in one round trip."
		],
		output: {
			human: [
				"General help text followed by the workflow schema summary",
				"Packaged skill installation summary for the inspected target"
			],
			json: ["help", "schema", "skills"]
		}
	}
];

const COMMAND_SPEC_BY_NAME = new Map(COMMAND_SPECS.map((spec) => [spec.name, spec]));

export function isKnownCommand(commandName: string): boolean {
	return COMMAND_SPEC_BY_NAME.has(commandName);
}

/**
 * Resolves a help lookup from raw positionals to a command spec name,
 * preferring the longest match so multi-word commands (e.g. "auth login")
 * are found before falling back to their first word alone.
 */
export function resolveHelpCommandName(positionals: string[]): string | undefined {
	for (let length = positionals.length; length > 0; length--) {
		const candidate = positionals.slice(0, length).join(" ");
		if (isKnownCommand(candidate)) {
			return candidate;
		}
	}

	return positionals[0];
}

export function getHelpPayload(commandName?: string): HelpPayload {
	const command = commandName ? getCommandSpec(commandName) : undefined;

	return {
		name: "agent-issues",
		summary: "Structured workflow CLI for shared context, initiatives, PRDs, user stories, ADRs, and issues.",
		globalOptions: GLOBAL_OPTIONS,
		commands: COMMAND_SPECS.map((spec) => ({
			name: spec.name,
			summary: spec.summary,
			usage: spec.usage
		})),
		discovery: [
			"Use `agent-issues context --json` to read the project-wide context directory: shared glossary plus initiative-scoped discovery.",
			"Use `agent-issues current-tenant --json` to see which workspace-derived tenant the CLI will use by default.",
			"Use `agent-issues list-tenants --json` to inspect all tenant namespaces present in the selected database before switching or deleting one.",
			"Use `agent-issues rename-tenant <tenantId> <newTenantId> --force --json` to normalize a tenant namespace without deleting and recreating it.",
			"Use `agent-issues backfill-bodies --json` to fill missing issue, PRD, and user story bodies from existing tracker metadata.",
			"Use `agent-issues context show default --json` to read only the shared glossary.",
			"Use `agent-issues context show <entityOrInitiativeId> --json` to read the initiative-scoped glossary for active work.",
			"Use `agent-issues context search <query> --view initiatives --json` to find initiative-local terminology without reading the full project directory.",
			"Use `agent-issues context conflicts --json` to detect duplicate labels across scopes before you rely on a term.",
			"Use `agent-issues context define <term> --scope <entityOrInitiativeId> --definition <text> [--avoid <comma-separated>] --json` to update the scoped glossary when a term is resolved.",
			"Use `agent-issues help <command> --json` for command-specific guidance.",
			"Use `agent-issues schema --json` for entity kinds, statuses, and relation rules.",
			"Use `agent-issues serve-site --json` to start a local live browser view with snapshot and event endpoints.",
			"Use `agent-issues open-site --json` to launch the live browser view in your default browser.",
			"Use `agent-issues stop-site --json` to stop the local live browser view on the default or selected port.",
			"Use `agent-issues install-agent --json` to install the packaged Agent Issues custom agent into the default VS Code prompts directory.",
			"Use `agent-issues list-agent --json` to inspect the packaged custom agent state in a prompts directory.",
			"Use `agent-issues uninstall-agent --json` to remove the packaged custom agent from a prompts directory.",
			"Use `agent-issues install-skills --json` to install the packaged agent-issues skill set.",
			"Use `agent-issues list-skills --json` to inspect the packaged agent-issues skill set in a target directory.",
			"Use `agent-issues uninstall-skills --json` to remove the packaged agent-issues skill set.",
			"Use `agent-issues capabilities --json` to fetch help, schema, and packaged skill installation state in one call."
		],
		command
	};
}

export function getCapabilitiesPayload(skills: ListSkillsResult): CapabilitiesPayload {
	return {
		help: getHelpPayload(),
		schema: getSchemaPayload(),
		skills
	};
}

export function renderHelp(payload: HelpPayload): string {
	if (payload.command) {
		return renderCommandHelp(payload.command);
	}

	const lines = ["agent-issues", "", payload.summary, "", "Commands:"];
	const longestName = Math.max(...payload.commands.map((command) => command.name.length));

	for (const command of payload.commands) {
		lines.push(`  ${command.name.padEnd(longestName)}  ${command.summary}`);
	}

	lines.push("", "Global options:");
	for (const option of payload.globalOptions) {
		lines.push(`  ${option.name.padEnd(18)} ${option.description}`);
	}

	lines.push("", "Discovery:");
	for (const item of payload.discovery) {
		lines.push(`  ${item}`);
	}

	return lines.join("\n");
}

export function getSchemaPayload(): SchemaPayload {
	return {
		entityKinds: ENTITY_KINDS.map((kind) => ({
			kind,
			idPrefix: ID_PREFIX[kind],
			initialStatus: STATUS_FLOW[kind][0],
			statuses: STATUS_FLOW[kind],
			archiveStatus: getArchiveStatus(kind)
		})),
		relationTypes: RELATION_TYPE_VALUES,
		allowedRelations: ALLOWED_RELATIONS,
		structuralRelationTypes: STRUCTURAL_RELATION_TYPES,
		parentRules: ALLOWED_RELATIONS.filter((relation) => isStructuralRelationType(relation.type)).map(
			(relation) => ({
				parentKind: relation.fromKind,
				childKind: relation.toKind,
				relationType: relation.type
			})
		),
		context: {
			storage: "database",
			scopes: ["default", "initiative"],
			defaultKey: DEFAULT_CONTEXT_KEY,
			listCommand: "agent-issues context list --json",
			readCommand: "agent-issues context show [<entityOrInitiativeId>|default] --json",
			searchCommand: "agent-issues context search <query> [--view <all|global|initiatives>] --json",
			conflictsCommand: "agent-issues context conflicts [<query>] [--view <all|initiatives>] --json",
			initializeCommand: "agent-issues context set --scope <entityOrInitiativeId|default> --title <title> --summary <summary> --json",
			defineCommand: "agent-issues context define <term> --scope <entityOrInitiativeId|default> --definition <definition> [--avoid <comma-separated terms>] --json",
			forgetCommand: "agent-issues context forget <term> --scope <entityOrInitiativeId|default> --json",
			termFields: ["term", "definition", "avoid", "createdAt", "updatedAt"]
		}
	};
}

export function renderSchema(payload: SchemaPayload): string {
	const lines = ["Entity kinds:"];

	for (const entityKind of payload.entityKinds) {
		lines.push(
			`  ${entityKind.kind} (${entityKind.idPrefix}) statuses=${entityKind.statuses.join(", ")} initial=${entityKind.initialStatus} archive=${entityKind.archiveStatus}`
		);
	}

	lines.push("", `Relation types: ${payload.relationTypes.join(", ")}`);
	lines.push("", `Structural relation types: ${payload.structuralRelationTypes.join(", ")}`);
	lines.push("", "Allowed relations:");

	for (const relation of payload.allowedRelations) {
		lines.push(`  ${relation.fromKind} --${relation.type}--> ${relation.toKind}`);
	}

	lines.push("", "Structural parent rules:");
	for (const rule of payload.parentRules) {
		lines.push(`  ${rule.parentKind} --${rule.relationType}--> ${rule.childKind}`);
	}

	lines.push("", "Context:");
	lines.push(`  storage=${payload.context.storage} scopes=${payload.context.scopes.join(", ")} default=${payload.context.defaultKey}`);
	lines.push(`  list: ${payload.context.listCommand}`);
	lines.push(`  read: ${payload.context.readCommand}`);
	lines.push(`  search: ${payload.context.searchCommand}`);
	lines.push(`  conflicts: ${payload.context.conflictsCommand}`);
	lines.push(`  initialize: ${payload.context.initializeCommand}`);
	lines.push(`  define term: ${payload.context.defineCommand}`);
	lines.push(`  forget term: ${payload.context.forgetCommand}`);
	lines.push(`  term fields: ${payload.context.termFields.join(", ")}`);

	return lines.join("\n");
}

function getCommandSpec(commandName: string): CommandSpec {
	const spec = COMMAND_SPEC_BY_NAME.get(commandName);

	if (!spec) {
		throw new Error(`Unknown command: ${commandName}`);
	}

	return spec;
}

function renderCommandHelp(command: CommandSpec): string {
	const lines = [command.name, "", command.summary, "", "Usage:"];

	for (const usage of command.usage) {
		lines.push(`  ${usage}`);
	}

	if (command.positionals && command.positionals.length > 0) {
		lines.push("", "Arguments:");
		for (const positional of command.positionals) {
			lines.push(`  ${formatField(positional.name, positional.description, positional.required, positional.allowedValues)}`);
		}
	}

	const options = dedupeOptions([...(command.options ?? []), ...GLOBAL_OPTIONS]);
	if (options.length > 0) {
		lines.push("", "Options:");
		for (const option of options) {
			lines.push(`  ${formatField(option.name, option.description, option.required, option.allowedValues)}`);
		}
	}

	if (command.examples && command.examples.length > 0) {
		lines.push("", "Examples:");
		for (const example of command.examples) {
			lines.push(`  ${example}`);
		}
	}

	if (command.notes && command.notes.length > 0) {
		lines.push("", "Notes:");
		for (const note of command.notes) {
			lines.push(`  ${note}`);
		}
	}

	if (command.output) {
		lines.push("", "Output:");
		if (command.output.human && command.output.human.length > 0) {
			lines.push("  Human-readable:");
			for (const line of command.output.human) {
				lines.push(`    ${line}`);
			}
		}

		if (command.output.json && command.output.json.length > 0) {
			lines.push("  JSON fields:");
			for (const field of command.output.json) {
				lines.push(`    ${field}`);
			}
		}
	}

	return lines.join("\n");
}

function formatField(
	name: string,
	description: string,
	required?: boolean,
	allowedValues?: readonly string[]
): string {
	const parts = [name, description];

	if (required) {
		parts.push("required");
	}

	if (allowedValues && allowedValues.length > 0) {
		parts.push(`allowed: ${allowedValues.join(", ")}`);
	}

	return parts.join(" | ");
}

function dedupeOptions(options: OptionSpec[]): OptionSpec[] {
	const seen = new Set<string>();
	const deduped: OptionSpec[] = [];

	for (const option of options) {
		if (seen.has(option.name)) {
			continue;
		}

		seen.add(option.name);
		deduped.push(option);
	}

	return deduped;
}