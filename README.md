# agent-issues

`agent-issues` is a TypeScript ESM CLI for managing shared context, initiatives, PRDs, user stories, ADRs, and issues in a local SQLite database.

The CLI implementation lives under `src/` and compiles to `dist/`. The browser viewer is a separate Lit app under `site/` that builds with Vite and is served live by the CLI. The older terminal prototype remains under `workflow-prototype/` and stays separate from the installable CLI.

## Requirements

- Node.js 24 or newer
- pnpm for development in this repo

## Development

```bash
pnpm install
pnpm run build
```

For frontend development, run `pnpm site:dev` from the repo root or `pnpm --dir site dev`.
The Vite dev server now auto-starts the live backend used for `site-config.json`, `/api/snapshot`, and `/events`.
Set `AGENT_ISSUES_DB=/path/to/agent-issues.db` before starting the dev server if you want the browser to point at a non-default database.

## Global install from this repo

```bash
pnpm add -g .
```

That installs the `agent-issues` command using the package `bin` entry.

## Storage

SQLite is the canonical store.

- Default path: `~/.agent-issues/agent-issues.db`
- Default tenant: derived from the current workspace root, so commands from subdirectories in the same project land on the same tenant inside the shared user-local database
- Override the derived tenant with: `--tenant <name>`
- Override with: `--db /path/to/agent-issues.db`
- Legacy cwd-local `.agent-issues/agent-issues.db` files and previous tenant-local `~/.agent-issues/tenants/<tenant>/agent-issues.db` files are imported into the shared user-local database the first time that tenant is opened without an explicit `--db`

The project glossary lives in this database. It is not a raw `CONTEXT.md` file.

## Context

Context is a first-class database-backed concept.

- Read the project-wide context directory with `agent-issues context --json`.
- Search project-wide context discovery with `agent-issues context search <query> [--view <all|global|initiatives>] --json`.
- Return only matching terms for agent-oriented search with `agent-issues context search <query> [--view <all|global|initiatives>] --terms-only --json`.
- List duplicate labels across scopes with `agent-issues context conflicts [<query>] --json`.
- Read only the shared project glossary with `agent-issues context show default --json`.
- List available contexts with `agent-issues context list --json`.
- Read initiative-scoped context with `agent-issues context show <entityOrInitiativeId> --json`.
- Initialize or update context metadata with `agent-issues context set --scope <entityOrInitiativeId|default> --title ... --summary ... --json`.
- Add or update a canonical term with `agent-issues context define <term> --scope <entityOrInitiativeId|default> --definition ... [--avoid ...] --json`.
- Remove a stale term with `agent-issues context forget <term> --scope <entityOrInitiativeId|default> --json`.

The project-wide context directory combines the shared glossary with initiative-scoped discovery, while preserving source scope so initiative-local terms do not silently become project-canonical. Initiative-scoped context is still the database equivalent of `CONTEXT.md` files that would live inside initiative folders. Agents should read the context for the active initiative before using project-specific terms and should update it immediately when a term is resolved.

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
agent-issues context set --scope INIT1 --title "Payments Context" --summary "Glossary for the payments initiative."
agent-issues context define "Order" --scope INIT1 --definition "A customer request accepted and tracked by the system." --avoid "purchase, transaction"
agent-issues help create --json
agent-issues schema --json
agent-issues capabilities --json
agent-issues current-tenant
agent-issues list-tenants --json
agent-issues init --tenant payments
agent-issues serve-site --port 4300
agent-issues serve-site --tenant payments
agent-issues open-site
agent-issues install-agent --json
agent-issues list-agent --json
agent-issues uninstall-agent --json
agent-issues install-skills --json
agent-issues list-skills --json
agent-issues uninstall-skills --json
agent-issues archive ISS1
agent-issues create initiative --title "Platform cleanup"
agent-issues delete ISS2
agent-issues create prd --title "Workflow PRD" --parent INIT1
agent-issues create userStory --title "Story one" --parent PRD1
agent-issues create issue --title "Implement CLI" --parent INIT1
agent-issues create issue --title "Handle parser edge cases" --parent ISS1
agent-issues bundle INIT1
agent-issues handoff show ISS1 --json
agent-issues move US1 PRD2
agent-issues move ISS7 ISS1
agent-issues relations ISS1
agent-issues orphans
agent-issues link ISS1 fixes US1
agent-issues unlink ISS1 fixes US1
agent-issues show INIT1 --json
agent-issues list issue
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

## Output

- Default output is human-readable text.
- Use `--json` for compact machine-readable skill-friendly output.
- Add `--pretty` with `--json` when you want indented JSON.

## Tenant management

- `current-tenant` shows the tenant the CLI will use from the current workspace root.
- `list-tenants` shows all tenant namespaces currently present in the selected database.
- `delete-tenant <tenantId> --force` removes one tenant and all of its rows.
- `rename-tenant <tenantId> <newTenantId> --force` renames one tenant namespace across all stored rows.

## Discovery

- `context` exposes database-backed glossary records, primarily scoped per initiative.
- `help` shows the command catalog or command-specific help.
- `schema` exposes entity kinds, statuses, archive mappings, allowed relations, and structural parent rules.
- `capabilities` returns both the help catalog and the workflow schema in one call.
- `serve-site` starts a local live browser view backed by HTTP, live DB reads, and server-sent events.
- `open-site` starts the same live server and asks the OS to open it in the default browser.
- `stop-site` asks the local live server on the selected port to stop.
- `install-agent` installs the packaged Agent Issues custom agent and hook into a VS Code prompts directory.
- `list-agent` reports whether the packaged Agent Issues custom agent is present in a prompts directory.
- `uninstall-agent` removes the packaged Agent Issues custom agent and hook from a prompts directory.
- `capabilities --target /path/to/skills` also includes the packaged skill installation state for that target.
- `install-skills` installs the packaged `ai-*` skills into an agent skills directory.
- `list-skills` reports whether the packaged `ai-*` skills are installed in an agent skills directory.
- `uninstall-skills` removes the packaged `ai-*` skills from an agent skills directory.
- `agent-issues help <command> --json` is the main LLM-facing command discovery surface.
- `agent-issues schema --json` is the main LLM-facing workflow schema surface.
- `agent-issues capabilities --json` is the fastest single-shot discovery call for an LLM.
- `agent-issues serve-site` or `agent-issues open-site` is the quickest way to inspect the full graph with live refresh.

## Skill installation

- The packaged skills install under these names to avoid conflicts with generic originals:
	- `ai-agent-issues`
	- `ai-grill-with-docs`
	- `ai-handoff`
	- `ai-migrate-docs`
	- `ai-start-work`
	- `ai-tdd`
	- `ai-to-issues`
	- `ai-to-prd`
- `ai-agent-issues` is the internal orientation skill for agents to refresh how the `agent-issues` CLI, entity model, and workflow fit together before taking action.
- Default install target: `~/.agents/skills`
- Override target: `agent-issues install-skills --target /path/to/skills`
- Inspect a target without changing it: `agent-issues list-skills --target /path/to/skills`
- Get schema, help, and packaged skill status for a target in one call: `agent-issues capabilities --target /path/to/skills --json`
- Replace existing installed copies: `agent-issues install-skills --force`
- Remove installed copies from the default target: `agent-issues uninstall-skills`
- Remove installed copies from a custom target: `agent-issues uninstall-skills --target /path/to/skills`

## Custom agent

- Install into the default VS Code prompts directory: `agent-issues install-agent`
- Inspect the installed state: `agent-issues list-agent`
- Remove it again: `agent-issues uninstall-agent`
- Override the prompts directory: `agent-issues install-agent --target /path/to/prompts`
- Force-refresh an existing installed copy: `agent-issues install-agent --force`
- Workspace source agent: `.github/agents/agent-issues.agent.md`
- Workspace source hook: `.github/hooks/agent-issues-enforcer.mjs`
- Installed user agent path (default): the VS Code user prompts directory for your OS, e.g. `~/Library/Application Support/Code/User/prompts/agent-issues.agent.md` (macOS), `%APPDATA%\Code\User\prompts\agent-issues.agent.md` (Windows), `~/.config/Code/User/prompts/agent-issues.agent.md` (Linux)
- Installed user hook path (default): the same prompts directory, e.g. `.../Code/User/prompts/agent-issues-enforcer.mjs`
- Enable `chat.useCustomAgentHooks` in VS Code so the inline hooks run only while the Agent Issues custom agent is active.
- When the active prompt includes an `ISS` id, the hook blocks edits and unrelated terminal commands until these preload commands have run:
	- `agent-issues show <ISS-ID> --json`
	- `agent-issues relations <ISS-ID> --json`
	- `agent-issues context show <ISS-ID> --json`

## Browser viewer

The browser viewer is built from the separate Lit project in `site/`. Root `pnpm run build` builds both the CLI and the viewer.

For local UI work, `pnpm site:dev` starts Vite on `127.0.0.1:5173` and automatically spins up the live backend on `127.0.0.1:4313` unless something is already listening there.
Set `AGENT_ISSUES_DB` if you want the dev server to target a specific database path, or use a named tenant via the regular CLI commands when you are not overriding the DB path directly.

### Live view

Use `agent-issues serve-site` to run a local HTTP server that serves the built viewer and refreshes when the database changes.

- Default live server: `agent-issues serve-site`
- Choose a port: `agent-issues serve-site --port 4300`
- Start the server and open a browser tab: `agent-issues open-site`

The live server exposes the viewer assets together with `site-config.json`, `/api/snapshot`, and `/events`. Keep the process running while you want live updates.

## Query-focused commands

- `bundle <initiativeId>` returns one initiative bundle directly.
- Initiative bundles include structural sub-issue links so issue trees can be reconstructed in the CLI and UI.
- `handoff <entityId>` returns focused handoff context for one entity, including its structural path, active blockers, and owning initiative bundle when one exists.
- `relations <entityId>` returns incoming and outgoing relations for one entity.
- `orphans [kind]` returns entities not reachable from any initiative.

## Destructive commands

- `archive <id>` moves an entity to its terminal archive status.
- `unlink <from> <type> <to>` removes a relation unless that would orphan a subtree.
- `delete <id>` deletes a leaf entity after its outgoing relations are gone.

## Move command

- `move <id> <newParentId>` reparents an entity by replacing its structural parent relation in one guarded operation.
- For issues, `move` can also reparent a sub-issue under a different parent issue.