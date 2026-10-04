# agent-issues

`agent-issues` is a TypeScript ESM CLI for managing shared context, initiatives, PRDs, user stories, ADRs, and issues in a local SQLite database.

## Install and use

## Requirements

- Node.js 24 or newer

Install both packages globally. `agent-issues` provides the command-line interface. `agent-issues-mcp` provides the MCP server executable. You need both packages for complete CLI and MCP use.

```bash
npm install --global agent-issues agent-issues-mcp
```

Confirm that npm installed both global packages:

```bash
npm list --global --depth=0 agent-issues agent-issues-mcp
```

Initialize the database in a workspace, then use the CLI:

```bash
cd /path/to/workspace
agent-issues init
agent-issues create initiative --title "Platform cleanup"
```

### MCP registration

MCP registration calls `agent-issues-mcp` with no arguments. This executable starts `agent-issues --mcp`. Both commands must be globally installed and available on your `PATH`:

```json
{
	"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
	"mcpServers": {
		"agent-issues": {
			"type": "stdio",
			"command": "agent-issues-mcp",
			"args": []
		}
	}
}
```

Use the host plugin instructions in [Agent integration installation](#agent-integration-installation) to configure Copilot CLI, VS Code, or Claude Code.

## Develop from source

This path is for contributors to this repository. It requires pnpm in addition to Node.js 24 or newer.

The repository is a pnpm monorepo under `packages/`: `@agent-issues/core` holds the shared domain (schema, database, and store layers), `agent-issues` is the CLI, `agent-issues-mcp` is the MCP server executable, `@agent-issues/site` is a Lit app built with Vite and served by the CLI, and `@agent-issues/api-pg` is a deployable cloud API service scaffold.

```bash
git clone https://github.com/arcmantle/agent-issues.git
cd agent-issues
pnpm install
pnpm run build
```

For frontend development, run `pnpm site:dev` from the repository root or `pnpm --filter @agent-issues/site dev`. The Vite dev server starts the live backend for `site-config.json`, `/api/snapshot`, and `/events`.

### Publish the plugin

The `publish-plugin` workflow job builds `packages/cli/dist/plugin/` and publishes its contents to `arcmantle/agent-issues-plugin` after each successful push to `main`. Set the `AGENT_ISSUES_PLUGIN_REPOSITORY_TOKEN` repository secret to a GitHub App installation token or a fine-grained personal access token with `Contents: Read and write` access to that repository.

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

For one command from a different folder, use `--project-identity <id>`. For example, `agent-issues list issue --project-identity shared-product --json` reads the `shared-product` project. A direct MCP server can use the same override: `agent-issues --mcp --project-identity shared-product`.

Use `agent-issues project-identity --json` to inspect the CLI's resolved identity and its source. The MCP server exposes the same resolved value through `project_identity`.

## Instruction Retrieval

Use `agent-issues instruction retrieve skill/prepare --json` or the MCP `instruction_retrieve` tool to retrieve instructions for the running CLI release. Both use the database source and return complete assembled Markdown.

To include a fragment, insert `<!-- include:fragment/rules -->` in the source Markdown. The marker is reserved instruction syntax wherever it occurs in the source. Include targets must be fragment keys, not skill or agent keys. Nested and repeated includes expand at the marker position in text order. No extra whitespace or newline is inserted around fragment content.

The response contains the requesting release in `version`, the source revision and source-content hash in `source`, and each included fragment's key and source metadata in `fragments`. The fragment list contains each key once, in first-use order. Hashes describe stored source Markdown, not the assembled body.

SQLite reads the release content in one transaction. PostgreSQL reads defaults, authenticated owner overrides, and personal fragments in one SQL statement. Both validate the complete dependency graph before returning a document. Missing defaults, unavailable storage, missing fragments, forbidden targets, and cycles return errors without partial instructions or fallback content. A returned document does not refresh after a later database change; retrieve it again to get the current content.

### Manage Instruction Source

Use `agent-issues instruction list --json` to list the current owner's agent, skill, and fragment sources. Use `agent-issues instruction read <key> --json` to read source Markdown without expanding includes. The matching MCP tools are `instruction_list` and `instruction_read`.

CLI updates keep personal overrides by stable item key and retain their original `source.defaultVersion`. Unchanged items use the requesting release's defaults. Reads and catalog items include `releaseChanges` when an override's original release differs from the requesting release. This metadata identifies the applicable `defaultVersion`, whether its default body changed, and added, removed, or changed fragment dependencies. Dependency inspection includes nested references from official defaults and personal source. It does not merge or rewrite edits.

`releaseChanges.newerDefaultAvailable` compares semantic release versions. It is `false` for an older requested release and `null` for bundle keys with no semantic version order. Missing or invalid dependencies still prevent runtime retrieval without fallback. Source reads remain available for repair.

Save an existing source with `agent-issues instruction save <key> --body-file <path|-> --expected-revision <revision> --json`. Use the revision from the source read. MCP provides `instruction_save` with `key`, `body`, and `expectedRevision`. Both select defaults for the running CLI release and return the same saved source metadata.

A save creates or updates a personal override, or updates an existing personal fragment. It cannot change immutable defaults, discovery metadata, or another cloud owner's content. Local mode uses one local profile. Cloud mode uses the authenticated tenant and user across projects. Validated changes apply to the next retrieval, not to documents already loaded.

Stale revisions and invalid dependencies leave saved content unchanged. CLI JSON failures return exit code 1. MCP failures set `isError`. Both return `reason` and `currentSource` with current Markdown, revision, and content hash for comparison and retry. Cloud saves serialize changes within one owner's set before revision checks and final-graph validation.

### Compare Instruction Defaults

Use `agent-issues instruction compare <key> --json` or MCP `instruction_compare` with `key`. Both compare the owner's source with the running CLI release's default, not the service release. The result includes both unassembled Markdown bodies as `currentSource` and `defaultSource`, their revision metadata, and `different`. An override retains its original `currentSource.source.defaultVersion` and applicable `releaseChanges` metadata.

`newerDefaultVersions` lists installed defaults for that item with semantic versions later than the requesting release, in ascending order. A personal fragment has no official default: `defaultSource` and `different` are `null`. Comparison does not save content, change revisions or history, or merge personal edits. Missing items, missing release bundles, and unavailable storage return errors without partial output or fallback.

### Instruction Revision History

Use `agent-issues instruction history <key> --json` to list saved source revisions, newest first. Use `agent-issues instruction revision <key> --revision <revision> --json` to read saved Markdown and its source metadata without expanding fragments. The matching MCP tools are `instruction_history` and `instruction_revision`.

Restore with `agent-issues instruction restore <key> --revision <revision> --expected-revision <current-revision> --json`. MCP provides `instruction_restore` with `key`, `revision`, and `expectedRevision`. Restore creates a new saved revision and validates its dependencies against the requesting CLI release. It does not replace official defaults or change instructions already loaded into a task. Stale revisions and invalid dependencies leave saved source and history unchanged.

History belongs to the instruction owner, not the selected project. The migration retains each existing override as a history entry. It cannot recover revisions that storage discarded before this feature was installed. Official defaults remain separate from saved personal history.

### Reset One Instruction

Use `agent-issues instruction reset-inspect <key> --json` before confirmation. The result shows `currentSource`, `proposedSource`, `affectedInstructions`, and `modifiedFragments`. Modified fragments remain active after the selected source returns to its default. Inspection does not save changes.

Confirm with `agent-issues instruction reset <key> --expected-revision <current-revision> --yes --json`. MCP provides `instruction_reset_inspect` and `instruction_reset`. Inspection returns a single-use confirmation token that expires after five minutes. Supply its `confirmationToken`, the item `key`, and `expectedRevision` to reset. A changed inspection requires a new token.

Reset removes only the selected override. The source uses the requesting CLI release's default and follows later release defaults. Its history records the reset as a new revision. Fragment overrides, unrelated items, other owners, and official bundles remain unchanged. Stale revisions and invalid dependency graphs leave source and history unchanged. Personal fragments have no official default and cannot be reset. Site reset controls are separate work.

### Reset All Instructions

Use `agent-issues instruction reset-all-inspect --json` before confirmation. The result identifies the owner and requesting release. It lists every `override`, including items absent from that release, every `personalFragment`, proposed defaults, affected instructions, and `expectedRevisions`. The response fields for the item lists are `overrides` and `personalFragments`. A removed release item has a `null` proposed source. Inspection does not save changes.

Confirm with `agent-issues instruction reset-all --input-file <path|-> --yes --json`. The JSON input contains the inspected `expectedRevisions` array. Each entry has an item `key`, `sourceType` (`override` or `personal`), and its `expectedRevision`. The source type distinguishes a hidden override from a personal fragment with the same key. The complete inspection response can also be used as input.

MCP provides `instruction_reset_all_inspect` and `instruction_reset_all`. Inspection returns a single-use `confirmationToken` that expires after five minutes. Commit requires that token and the inspected `expectedRevisions`. A changed owner or proposal requires a new token. The CLI-served site exposes `GET /api/instructions/reset-all/inspect` and `POST /api/instructions/reset-all` with the same confirmation fields.

Reset All clears owner overrides and removes personal fragments in one transaction. It validates the final official-default graph rather than intermediate states. The active set returns to the running CLI release's defaults. Official bundles and other owners remain unchanged. History retains reset revisions and fragment removal records. Stale revisions, a changed affected-item set, missing bundles, and invalid final dependencies leave saved content unchanged. Revision failures include `reason` and `currentInspection` for comparison and retry.

### Preview Pending Instructions

Use `agent-issues instruction preview <key> --input-file <path|-> --json` to assemble unsaved source. The input contains a non-empty `changes` array of unique existing item keys and pending Markdown bodies. MCP provides `instruction_preview` with `key` and the same array. The CLI-served site provides `POST /api/instructions/preview` with the same request.

```json
{
	"changes": [
		{ "key": "skill/prepare", "body": "Prepare with <!-- include:fragment/rules -->" },
		{ "key": "fragment/rules", "body": "Pending rules." }
	]
}
```

All interfaces select the running CLI release and the current owner. Pending bodies replace saved bodies only for this assembly. Unchanged items come from one consistent snapshot. Nested and repeated includes use the retrieval rules.

Responses contain `pending: true`, sorted `pendingKeys`, assembled `body`, and release and source metadata. Source revisions and hashes identify the saved base content, not an invented pending revision. Human CLI output starts with `Pending`.

Preview does not save content, change revisions or history, create drafts, or activate instructions. Missing content, invalid targets, cycles, duplicate changes, and unavailable storage return errors without partial output. The site preview view is separate work.

### Atomic Instruction Changes

Use `agent-issues instruction commit --input-file <path|-> --json` to save related sources and remove personal fragments in one transaction. The input is a JSON object with a `changes` array. MCP provides `instruction_commit` with the same array. Each item requires a unique `key`, an `operation` (`save` or `remove`), and `expectedRevision`. A save also requires a Markdown `body`.

```json
{
	"changes": [
		{ "operation": "remove", "key": "fragment/personal", "expectedRevision": 1 },
		{ "operation": "save", "key": "skill/prepare", "body": "Prepare without the personal fragment.", "expectedRevision": 2 }
	]
}
```

Every revision is checked against the saved set. Validation uses the complete final dependency graph, not intermediate changes. Reference changes and fragment removal can therefore commit together, regardless of input order. Saved overrides outside the requested release also protect their fragment references. Only personal fragments can be removed.

A stale revision or invalid final graph leaves every source and its history unchanged. Successful responses identify the requesting CLI release and each changed source revision. Concurrent retrieval returns the complete old or new set, not an intermediate set. The operation does not create drafts or change instructions already loaded into a task.

### Personal Fragments

Create a fragment with `agent-issues instruction fragment create fragment/my-rules --body-file <path|-> --json`. MCP provides `instruction_fragment_create` with `key` and `body`. Keys must use the `fragment/` prefix and the same lowercase key format as official items. Creation rejects duplicate keys, missing include targets, and cycles. It does not add a discoverable skill.

Read and edit the fragment with `instruction read` and `instruction save`, or their matching MCP tools. Its source type is `personal`. The catalog and later retrievals include the saved fragment within the same owner scope across projects and releases.

Remove it with `agent-issues instruction fragment remove fragment/my-rules --expected-revision <revision> --json`, or MCP `instruction_fragment_remove` with `key` and `expectedRevision`. Only personal fragments can be removed. Saved references block removal; errors include `affectedReferences` with the referring item keys. Stale revisions leave the fragment unchanged. Creation, edits, and removal retain revision records. Recreating a removed key continues its revision sequence, so an earlier revision cannot remove the new fragment.

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

Install both global packages before you install a host plugin. The plugin registers the `agent-issues-mcp` command described in [MCP registration](#mcp-registration).

Use one command to install the plugin for Copilot CLI or VS Code:

```bash
agent-issues agent init
```

To install for Claude Code, select that host explicitly:

```bash
agent-issues agent init --host claude
```

### Copilot CLI and VS Code

```bash
copilot plugin marketplace add arcmantle/agent-issues-plugin
copilot plugin install agent-issues@agent-issues
```

VS Code discovers this shared plugin from `~/.copilot/installed-plugins/` and loads its agents, skills, and MCP server. Set `chat.plugins.enabled` to `true` in VS Code.

Update the marketplace, then update the installed plugin:

```bash
copilot plugin marketplace update agent-issues
copilot plugin update agent-issues
```

Remove the shared plugin with `copilot plugin uninstall agent-issues`. In VS Code, use the Agent Plugins - Installed view to inspect, enable, disable, or uninstall plugins.

### Claude Code

```bash
claude plugin marketplace add arcmantle/agent-issues-plugin
claude plugin install agent-issues@agent-issues --scope user
```

Update the marketplace, then update the installed plugin:

```bash
claude plugin marketplace update agent-issues
claude plugin update agent-issues@agent-issues
```

Remove the plugin with `claude plugin uninstall agent-issues@agent-issues`.

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