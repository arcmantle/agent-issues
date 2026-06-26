import {
	ALLOWED_RELATIONS,
	ENTITY_KINDS,
	ID_PREFIX,
	STATUS_FLOW,
	STRUCTURAL_RELATION_TYPES,
	getArchiveStatus,
	isStructuralRelationType,
	type EntityKind
} from "./domain.js";
import { DEFAULT_CONTEXT_KEY } from "./context-store.js";
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
		name: "--tenant <name>",
		description: "Select a named tenant inside the shared user-local ~/.agent-issues/agent-issues.db database instead of deriving one from the current workspace root."
	},
	{
		name: "--json",
		description: "Print machine-readable JSON."
	},
	{
		name: "--help, -h",
		description: "Show help for the whole CLI or the selected command."
	}
];

const ENTITY_KIND_VALUES = ENTITY_KINDS;
const RELATION_TYPE_VALUES = Array.from(new Set(ALLOWED_RELATIONS.map((relation) => relation.type))).sort();
const STATUS_VALUES = Array.from(new Set(Object.values(STATUS_FLOW).flat())).sort();

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
			"agent-issues context set [--scope <entityOrInitiativeId|default>] --title <title> --summary <summary>",
			"agent-issues context define <term> [--scope <entityOrInitiativeId|default>] --definition <definition> [--avoid <comma-separated terms>]",
			"agent-issues context forget <term> [--scope <entityOrInitiativeId|default>]"
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
				name: "--view <all|global|initiatives>",
				description: "Choose the discovery slice for project-wide context reads. `context conflicts` supports `all` and `initiatives`."
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
		usage: ["agent-issues current-tenant", "agent-issues current-tenant --tenant <name>"],
		options: [
			{
				name: "--tenant <name>",
				description: "Show the explicitly requested tenant instead of deriving one from the workspace root."
			}
		],
		examples: ["agent-issues current-tenant", "agent-issues current-tenant --tenant payments --json"],
		notes: [
			"Without --tenant, the CLI derives the tenant from the current workspace root path.",
			"Workspace root discovery walks upward from the current directory and prefers pnpm-workspace.yaml, then .git, then package.json.",
			"The derived tenant format is <sanitized-workspace-name>-<stable-path-hash>."
		],
		output: {
			human: ["Current tenant, resolution mode, workspace root, and database path"],
			json: ["command", "tenantId", "resolution", "workspaceRoot", "dbPath"]
		}
	},
	{
		name: "list-tenants",
		summary: "List the tenants currently present in the selected database.",
		usage: ["agent-issues list-tenants", "agent-issues list-tenants --db <path> --json"],
		examples: ["agent-issues list-tenants", "agent-issues list-tenants --json"],
		notes: [
			"The command lists tenants with any stored entities, relations, context, terms, or handoffs.",
			"`--tenant` only changes which tenant is marked as current in the output; it does not filter the list.",
			"Use this before `delete-tenant` to avoid deleting the wrong workspace namespace."
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
			"Tenant names are sanitized the same way as `--tenant`, so display-style input like `Payments Sandbox` resolves to `payments-sandbox`.",
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
			"Tenant ids are sanitized with the same rules as `--tenant`, so display-style input like `Payments Sandbox` resolves to `payments-sandbox`.",
			"Renaming updates counters, entities, relations, contexts, context terms, and handoffs.",
			"The target tenant must not already exist. Run `list-tenants` first if you are not sure."
		],
		output: {
			human: ["Renamed tenant summary with per-table moved counts, or a not-found message"],
			json: ["command", "dbPath", "previousTenantId", "previousDisplayName", "newTenantId", "newDisplayName", "renamed", "counts", "counters"]
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
		usage: ["agent-issues create <kind> --title <title> [--parent <id>] [--status <status>] [--body <markdown> | --body-file <path|->]"],
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
			}
		],
		examples: [
			'agent-issues create initiative --title "Workflow tooling"',
			'agent-issues create prd --title "Handoff support" --parent INIT1',
			'agent-issues create issue --title "Add help schema" --parent INIT1',
			'agent-issues create issue --title "Add help schema" --parent INIT1 --body-file /tmp/iss1.md'
		],
		notes: [
			"Valid structural parent-child pairs are exposed by `agent-issues schema --json`.",
			"If no status is supplied, the CLI uses the first status in the workflow for that kind.",
			"Use `--body-file` for multiline markdown to avoid shell quoting problems."
		],
		output: {
			human: ["<id> <kind> <status> <title>"],
			json: ["id", "kind", "title", "status", "body", "createdAt", "updatedAt"]
		}
	},
	{
		name: "archive",
		summary: "Move one entity to its archive status.",
		usage: ["agent-issues archive <id>"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
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
		usage: ["agent-issues delete <id>"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
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
		usage: ["agent-issues bundle <initiativeId>"],
		positionals: [{ name: "initiativeId", description: "Initiative ID.", required: true }],
		examples: ["agent-issues bundle INIT1", "agent-issues bundle INIT1 --json"],
		output: {
			human: [
				"<initiativeId> <status> <title>",
				"PRDs: <id:status, ...>",
				"User Stories: <id:status, ...>",
				"ADRs: <id:status, ...>",
				"Issues: <id:status, ...>",
				"Fixes / Blockers / Constrains summaries"
			],
			json: [
				"initiative",
				"prds",
				"userStories",
				"adrs",
				"issues",
				"fixLinks",
				"blockerLinks",
				"constrainsLinks"
			]
		}
	},
	{
		name: "handoff",
		summary: "Show tracked handoff context for one entity, or create, edit, and delete saved handoffs.",
		usage: [
			"agent-issues handoff <id>",
			"agent-issues handoff show <id>",
			"agent-issues handoff create <id> (--body <markdown> | --body-file <path|->) [--summary <text>]",
			"agent-issues handoff edit <handoffId> [--summary <text>] [--body <markdown> | --body-file <path|->]",
			"agent-issues handoff delete <handoffId>"
		],
		positionals: [
			{ name: "subcommand", description: "Handoff action. Defaults to show.", allowedValues: ["show", "create", "edit", "delete"] },
			{ name: "id", description: "Focus entity ID for show/create, or handoff ID for edit/delete.", required: true }
		],
		options: [
			{
				name: "--body <markdown>",
				description: "Markdown handoff content to persist for `handoff create`, or replacement content for `handoff edit`."
			},
			{
				name: "--body-file <path|->",
				description: "Read markdown handoff content from a file, or from stdin when the value is `-`."
			},
			{
				name: "--summary <text>",
				description: "Short label shown in handoff lists. For `handoff edit`, omitting it preserves the current summary and an empty string clears it."
			}
		],
		examples: [
			"agent-issues handoff show ISS1",
			"agent-issues handoff ISS1 --json",
			'agent-issues handoff create ISS1 --summary "Paused mid-refactor" --body "## State\\n..."',
			'agent-issues handoff edit HO1 --summary "Ready for pickup" --body-file /tmp/handoff.md',
			"agent-issues handoff delete HO1"
		],
		notes: [
			"Reading returns the focus entity, structural path, active blockers, orphaned flag, owning initiative bundle, and any saved handoffs.",
			"`handoff create` persists a handoff into the tracker, anchored to the focus entity and its owning initiative, so the next session can resume from the initiative view.",
			"`handoff edit` updates an existing saved handoff in place, and `handoff delete` removes one by handoff id.",
			"`handoff write` remains accepted as a compatibility alias for `handoff create`.",
			"Use `--body-file` for multiline handoffs to avoid shell quoting problems."
		],
		output: {
			human: [
				"Focus: <id> <kind> <status> <title>",
				"Path section",
				"Orphaned flag",
				"Active blockers section",
				"Initiative summary",
				"Saved handoffs section",
				"Indented relations block"
			],
			json: ["focus", "structuralPath", "initiative", "orphaned", "activeBlockers", "handoffs"]
		}
	},
	{
		name: "move",
		summary: "Move one entity under a new structural parent.",
		usage: ["agent-issues move <id> <newParentId>"],
		positionals: [
			{ name: "id", description: "Entity ID to move.", required: true },
			{ name: "newParentId", description: "New structural parent ID.", required: true }
		],
		examples: ["agent-issues move US1 PRD2"],
		notes: ["Move rejects incompatible parent kinds, cycles, and initiatives."],
		output: {
			human: ["Moved <id> from <previousParentId|none> to <newParentId> as <relationType>"],
			json: ["entity", "previousParentId", "newParentId", "relationType"]
		}
	},
	{
		name: "relations",
		summary: "Show incoming and outgoing relations for one entity.",
		usage: ["agent-issues relations <id>"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		examples: ["agent-issues relations ISS1", "agent-issues relations ISS1 --json"],
		output: {
			human: [
				"<id> <kind> <status> <title>",
				"Incoming section",
				"Outgoing section"
			],
			json: ["entity", "incoming", "outgoing"]
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
		usage: ["agent-issues status <id> <status>"],
		positionals: [
			{ name: "id", description: "Entity ID.", required: true },
			{
				name: "status",
				description: "New status.",
				required: true,
				allowedValues: STATUS_VALUES
			}
		],
		examples: ["agent-issues status ISS1 in-progress", "agent-issues status US1 done"],
		notes: [
			"Each entity kind only accepts its own status flow.",
			"Issues cannot move to in-progress or done while blocked by a non-done issue."
		],
		output: {
			human: ["Updated <id> from <previousStatus> to <status>"],
			json: ["entity", "previousStatus"]
		}
	},
	{
		name: "edit",
		summary: "Update the authored markdown body of a record.",
		usage: ["agent-issues edit <id> (--body <markdown> | --body-file <path|->)"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		options: [
			{
				name: "--body <markdown>",
				description: "Authored markdown body for the record.",
				required: true
			},
			{
				name: "--body-file <path|->",
				description: "Read the authored markdown body from a file, or from stdin when the value is `-`."
			}
		],
		examples: [
			'agent-issues edit ISS1 --body "# Plan\\n\\nDetails here."',
			'agent-issues edit ISS1 --body-file /tmp/iss1.md'
		],
		notes: [
			"The body replaces any previously stored body for the record.",
			"Use `--body-file` for multiline markdown to avoid shell quoting problems."
		],
		output: {
			human: ["Updated body for <id> <kind> <title>"],
			json: ["id", "kind", "title", "status", "body", "createdAt", "updatedAt"]
		}
	},
	{
		name: "link",
		summary: "Create a relation between entities.",
		usage: ["agent-issues link <fromId> <relationType> <toId>"],
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
		examples: [
			"agent-issues link ISS1 fixes US1",
			"agent-issues link ADR1 constrains ISS1",
			"agent-issues link ISS2 blocks ISS1"
		],
		notes: [
			"Allowed relation pairs are exposed by `agent-issues schema --json`.",
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
		usage: ["agent-issues unlink <fromId> <relationType> <toId>"],
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
		usage: ["agent-issues show <id>"],
		positionals: [{ name: "id", description: "Entity ID.", required: true }],
		examples: ["agent-issues show INIT1", "agent-issues show ISS1 --json"],
		output: {
			human: [
				"For initiatives: same shape as bundle",
				"For other kinds: same shape as relations"
			],
			json: ["InitiativeBundle | EntityDetails"]
		}
	},
	{
		name: "list",
		summary: "List entities by kind.",
		usage: ["agent-issues list <kind>"],
		positionals: [
			{
				name: "kind",
				description: "Entity kind.",
				required: true,
				allowedValues: ENTITY_KIND_VALUES
			}
		],
		examples: ["agent-issues list issue", "agent-issues list prd --json"],
		output: {
			human: ["One line per entity: <id> <status> <title>"],
			json: ["Array<EntityRecord>"]
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
			"agent-issues serve-site --tenant payments --json",
			"agent-issues serve-site --db ~/.agent-issues/agent-issues.db --tenant payments --json"
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
			"agent-issues open-site --tenant payments --json",
			"agent-issues open-site --db ~/.agent-issues/agent-issues.db --tenant payments --json"
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
			"Only the packaged `ai-*` skill directories are removed.",
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