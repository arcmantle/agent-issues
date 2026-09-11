# agent-issues

`agent-issues` is a TypeScript ESM CLI for managing shared context, initiatives, PRDs, user stories, ADRs, and issues in a local SQLite database.

The repository is a pnpm monorepo under `packages/`: `@agent-issues/core` holds the shared domain (schema, database, and store layers), `agent-issues` (the CLI) compiles to `dist/` and depends on core, `@agent-issues/site` is a separate Lit app that builds with Vite and is served live by the CLI, and `@agent-issues/api-pg` is a deployable cloud API service scaffold. The older terminal prototype remains under `workflow-prototype/` and stays separate from the installable CLI.

## Requirements

- Node.js 24 or newer
- pnpm for development in this repo

## Development

```bash
pnpm install
pnpm run build
```

For frontend development, run `pnpm site:dev` from the repo root or `pnpm --filter @agent-issues/site dev`.
The Vite dev server now auto-starts the live backend used for `site-config.json`, `/api/snapshot`, and `/events`.
Set `AGENT_ISSUES_DB=/path/to/agent-issues.db` before starting the dev server if you want the browser to point at a non-default database.

## Global install

```bash
npm install --global agent-issues agent-issues-mcp
```

The `agent-issues` package installs the CLI and owns the MCP implementation. The fixed-version `agent-issues-mcp` package installs a stable stdio proxy that starts `agent-issues` from `PATH`, so MCP behavior updates with the CLI.

## Storage

SQLite is the canonical store.

- Default path: `~/.agent-issues/agent-issues.db`
- Default tenant: derived from the current workspace root, so commands from subdirectories in the same project land on the same tenant inside the shared user-local database
- Override the derived tenant with: `--tenant <name>`
- Override with: `--db /path/to/agent-issues.db`
- Legacy cwd-local `.agent-issues/agent-issues.db` files and previous tenant-local `~/.agent-issues/tenants/<tenant>/agent-issues.db` files are imported into the shared user-local database the first time that tenant is opened without an explicit `--db`

The project glossary lives in this database. It is not a raw `CONTEXT.md` file.

## MCP project identity

The MCP server scopes tracker reads and writes to one project identity. For a VS Code multi-root workspace, set `agentIssues.projectIdentity` in the workspace file:

```json
{
	"folders": [
		{ "path": "api" },
		{ "path": "web" }
	],
	"settings": {
		"agentIssues.projectIdentity": "shared-product"
	}
}
```

The VS Code MCP provider passes this value to the server. An explicit workspace value takes precedence over `.agent-issues.json`, `.agent-issues`, the `.code-workspace` filename, Git remote name, `package.json` name, and folder name.

When the MCP client advertises roots, the server resolves identity from the first `file:` root. That root is the chat folder. If the client does not send roots, the server uses the process working directory.

Outside VS Code, set the same identity in either `.agent-issues.json` or `.agent-issues`:

```json
{ "projectIdentity": "shared-product" }
```

Use `agent-issues project-identity --json` to inspect the CLI's resolved identity and its source. The MCP server exposes the same resolved value through `project_identity`.

## Context

Context is a first-class database-backed concept.

- Read the project-wide context directory with `agent-issues context --json`.
- Search project-wide context discovery with `agent-issues context search <query> [--view <all|global|initiatives>] --json`.
- Return only matching terms for agent-oriented search with `agent-issues context search <query> [--view <all|global|initiatives>] --terms-only --json`.
- List duplicate labels across scopes with `agent-issues context conflicts [<query>] --json`.
- Read only the shared project glossary with `agent-issues context show default --json`.
- List available contexts with `agent-issues context list --json`.
- Read project or initiative context with `agent-issues context show <entityOrProjectOrInitiativeId> --json`.
- Initialize or update context metadata with `agent-issues context set --scope <entityOrProjectOrInitiativeId|default> --title ... --body-file <path|-> --json`.
- Add or update a canonical term with `agent-issues context define <term> --scope <entityOrProjectOrInitiativeId|default> --body-file <path|-> [--avoid ...] --json`.
- Remove a stale term with `agent-issues context forget <term> --scope <entityOrProjectOrInitiativeId|default> --json`.

The project context holds project-wide terms. Initiative context holds workstream-specific terms. The project-wide context directory preserves source scope so initiative-local terms do not silently become project-canonical. Agents should read the context for the active project or initiative before they use project-specific terms and should update it immediately when a term is resolved.

## Commands

```bash
agent-issues init
agent-issues context --json
agent-issues context search review --view initiatives --json
agent-issues context search review --view initiatives --terms-only --json
agent-issues context conflicts --json
agent-issues context list --json
agent-issues context show default --json
agent-issues context show --view global --query Administration --json
agent-issues context show INIT1 --json
agent-issues context set --scope INIT1 --title "Payments Context" --body-file /tmp/payments-summary.md
agent-issues context define "Order" --scope INIT1 --body-file /tmp/order-definition.md --avoid "purchase, transaction"
agent-issues help create --json
agent-issues schema --json
agent-issues capabilities --json
agent-issues current-tenant
agent-issues list-tenants --json
agent-issues init --tenant payments
agent-issues site --port 4300
agent-issues site --tenant payments
agent-issues site --stop
agent-issues archive ISS1
agent-issues create initiative --title "Platform cleanup"
agent-issues delete ISS2
agent-issues create prd --title "Workflow PRD" --parent INIT1
agent-issues create userStory --title "Story one" --parent PRD1
agent-issues create issue --title "Implement CLI" --parent INIT1
agent-issues create issue --title "Handle parser edge cases" --parent ISS1
agent-issues show INIT1 --json
agent-issues create handoff --title "Resume parser work" --body-file - --link handsOff ISS1
agent-issues edit HO1 --title "Resume parser work" --body-file -
agent-issues move US1 PRD2
agent-issues move ISS7 ISS1
agent-issues relations ISS1
agent-issues orphans
agent-issues link ISS1 fixes US1
agent-issues unlink ISS1 fixes US1
agent-issues show ISS1 --json
agent-issues list issue
agent-issues auth login
agent-issues auth list
agent-issues auth status
agent-issues auth switch work
agent-issues auth switch
agent-issues auth logout work
```

## Current relation model

- Initiatives own PRDs.
- PRDs create user stories.
- Initiatives record ADRs.
- Initiatives track issues.
- Issues can decompose into sub-issues.
- Issues fix user stories.
- ADRs constrain issues.
- Issues block other issues.
- Handoffs are entities linked to their active focus with `handsOff`.

## Output

- Default output is human-readable text.
- Use `--json` for machine-readable output. Entity lists return `{ items, total }`, relations return summaries, and mutations return compact acknowledgements.
- Use `show <id> --json` for a complete entity read, including authored body content. `show <initiativeId> --json` returns the complete initiative graph.
- Add `--pretty` with `--json` when you want indented JSON.
- Human-readable output is unchanged by the JSON response-shape change. See [release notes](docs/release-notes.md) for migration details.

## Tenant management

- `current-tenant` shows the tenant the CLI will use from the current workspace root.
- `list-tenants` shows all tenant namespaces currently present in the selected database.
- `delete-tenant <tenantId> --force` removes one tenant and all of its rows.
- `rename-tenant <tenantId> <newTenantId> --force` renames one tenant namespace across all stored rows.

## Auth (Entra ID)

The cloud API (`@agent-issues/api-pg`) validates requests through a swappable `AuthProvider` seam, with Entra ID (Azure AD) as the first concrete provider. The CLI stores named remote logins and includes a permanent built-in local login:

```bash
agent-issues auth login
agent-issues auth login --name work --url https://agent-issues.example.com # one-shot
agent-issues auth list
agent-issues auth status
agent-issues auth switch work
agent-issues auth switch
agent-issues auth logout work
```

- `auth login` prompts for a name and service URL, discovers the service's Entra configuration, runs the interactive device-code flow, and saves the resulting remote login.
- `auth login --name <name> --url <url>` supplies both values for one-shot or automated use.
- `auth list` shows the permanent local login first, then remote saved logins in creation order, and marks the active login.
- `auth switch <name>` activates local or a named remote login directly. Bare `auth switch` advances through local, each remote in creation order, and wraps to local.
- The active saved login controls routing globally for subsequent CLI requests.
- `auth logout [name]` removes a remote saved login; removing the active remote atomically falls back to local.
- Remote credentials are stored in the OS credential store, not plaintext files.
- `auth status` never prints the raw access token.
- You need a real Entra ID app registration before `auth login` will work. See [`docs/auth-entra-id-setup.md`](docs/auth-entra-id-setup.md) for a step-by-step guide to creating one.

### Local dev auth (no Azure required)

`LocalAuthProvider` remains available inside `@agent-issues/api-pg` for API service tests and local service development only. It is not exposed through `agent-issues auth login`; local CLI storage uses the permanent built-in `local` saved login. See [`docs/local-dev-setup.md`](docs/local-dev-setup.md).

## Discovery

- `context` exposes database-backed glossary records, primarily scoped per initiative.
- `help` shows the command catalog or command-specific help.
- `schema` exposes entity kinds, statuses, archive mappings, allowed relations, and structural parent rules.
- `capabilities` returns both the help catalog and the workflow schema in one call.
- `site` starts a local HTTP view in the background and prints its URL.
- `site --stop` asks the local live server on the selected port to stop.
- `agent-issues help <command> --json` is the main LLM-facing command discovery surface.
- `agent-issues schema --json` is the main LLM-facing workflow schema surface.
- `agent-issues capabilities --json` is the fastest single-shot discovery call for an LLM.
- `agent-issues site` is the quickest way to inspect the full graph with live refresh.

## Agent integration installation

- Copilot CLI and VS Code: run `copilot plugin marketplace add arcmantle/agent-issues`, then `copilot plugin install agent-issues@agent-issues`. VS Code automatically discovers the installed plugin in `~/.copilot/installed-plugins/` and loads its supported agents, skills, and MCP servers. Make sure `chat.plugins.enabled` is `true` in VS Code.
- Copilot updates: run `copilot plugin marketplace update agent-issues` and `copilot plugin update agent-issues`. Remove the shared installation with `copilot plugin uninstall agent-issues`.
- VS Code management: use the Agent Plugins - Installed view to inspect, enable, disable, or uninstall the plugin. You can also install it in VS Code from its configured marketplace or Git source.
- Claude Code: run `claude plugin marketplace add arcmantle/agent-issues`, then `claude plugin install agent-issues@agent-issues`. For updates, run `claude plugin marketplace update agent-issues` and `claude plugin update agent-issues@agent-issues`. Remove it with `claude plugin uninstall agent-issues@agent-issues`.
- Migration: replace `install-agent`, `install-skills`, `install-mcp`, and the VS Code compatibility lifecycle commands with host plugin installation. Use the Copilot CLI installation for both Copilot CLI and VS Code.

## Browser viewer

The browser viewer is built from the separate Lit project in `packages/site/`. Root `pnpm run build` builds both the CLI and the viewer.

For local UI work, `pnpm site:dev` starts Vite on `127.0.0.1:5173` and automatically spins up the live backend on `127.0.0.1:4313` unless something is already listening there.
Set `AGENT_ISSUES_DB` if you want the dev server to target a specific database path, or use a named tenant via the regular CLI commands when you are not overriding the DB path directly.

### Live view

Use `agent-issues site` to start a detached local HTTP server that serves the built viewer and refreshes when the database changes.

- Default live server: `agent-issues site`
- Choose a port: `agent-issues site --port 4300`
- Stop the server: `agent-issues site --stop`

The live server exposes the viewer assets together with `site-config.json`, `/api/snapshot`, and `/events`.

## Query-focused commands

- `show <initiativeId>` returns one complete initiative graph directly.
- Initiative bundles include structural sub-issue links so issue trees can be reconstructed in the CLI and UI.
- `create handoff --title ... --body-file - --link handsOff <focusId>` records a handoff as a graph entity.
- `list handoff`, `show HOx`, `relations HOx`, and `edit HOx --title ... --body-file -` read and update handoffs through the generic entity commands.
- `relations <entityId>` returns incoming and outgoing relations for one entity.
- `orphans [kind]` returns entities not reachable from any initiative.

## Destructive commands

- `archive <id>` moves an entity to its terminal archive status.
- `unlink <from> <type> <to>` removes a relation unless that would orphan a subtree.
- `delete <id>` deletes a leaf entity after its outgoing relations are gone.

## Move command

- `move <id> <newParentId>` reparents an entity by replacing its structural parent relation in one guarded operation.
- For issues, `move` can also reparent a sub-issue under a different parent issue.