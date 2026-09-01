# Shared Skill Operating Contract

All bundled `ai-*` skills follow this contract. They also follow the shared [language standard](./agent-issues-language.md).

## Tracker is canonical

`agent-issues` is the single tracker for work. A chat plan, a scratch note, a raw markdown document, and a test file are not work records.

- Use the exact operation recipe named by the active skill. Start with its MCP tool. Use the listed CLI fallback only when the MCP server is unavailable or lacks that operation.
- Before you plan, implement, migrate, or hand off work, run the **Entity Read** recipe, the **Relation Query** recipe, and the **Context Read** recipe to find the active tracked scope.
- Do not leave a new workstream, ADR, or implementation follow-up untracked. Run the **Entity Create And Edit** recipe to create the missing record when its parent is clear. If not, ask one routing question.
- For new feature planning, create a new initiative by default. Reuse an existing initiative only when the user asks for that directly.
- Run the **Entity State And Structure** recipe to change issue status and Plan status. Derive user story and PRD status from their linked issues. An ADR is `current` unless it is `superseded` or `archived`.
- Treat each entity's complete `reference` field as its public tracker identity. Copy it exactly as returned by the tracker whenever you report or use an entity. Never abbreviate or truncate it, and never replace it with the internal `id`.

Issue comments use complete `COM_` references. They are issue discussion, not tracker state: use tracker records for scope, decisions, blockers, handoffs, and status.

## Operation Recipes

Every tracker operation uses one of these recipes. CLI fallbacks use `--json`.

**Kind** is `Read`, `Write`, `Destructive write`, or `Host`. A `Read` recipe does not change tracker data. A `Write` recipe changes tracker data. A `Destructive write` recipe requires the stated inspection or confirmation flow. A `Host` recipe changes the local environment and has no MCP equivalent.

### Entity Read

**Kind:** Read.

- MCP: `entity_show({ reference })`.
- CLI fallback: `agent-issues show <reference> --json`.

### Entity List

**Kind:** Read.

- MCP: `entity_list({ kind, statuses?, parentId?, limit? })`.
- CLI fallback: `agent-issues list <kind> [--status <status[,status]>] [--parent <parent>] [--limit <count>] --json`.

### Relation Query

**Kind:** Read.

- MCP: `relation_query({ entityId, direction?, types? })`.
- CLI fallback: `agent-issues relations <entityId> [--direction <incoming|outgoing|both>] [--type <type[,type]>] --json`.

### Initiative Read

**Kind:** Read.

- MCP: `initiative_bundle({ initiativeId })`.
- CLI fallback: `agent-issues show <initiativeId> --json`.

### Next Work

**Kind:** Read.

- MCP: `entity_next_work({ scopeId })`.
- CLI fallback: `agent-issues next-work <initiativeOrDescendantId> --json`.

### Context Read

**Kind:** Read.

- MCP: `context_show({ scopeRef? })`, `context_directory({})`, `context_search({ query?, view? })`, or `context_conflicts({ query?, view? })`.
- CLI fallback: `agent-issues context show [<scope>] --json`, `agent-issues context list --json`, `agent-issues context search <query> [--view <all|global|initiatives>] --json`, or `agent-issues context conflicts [<query>] [--view <all|initiatives>] --json`.

### Context Write

**Kind:** Write.

- MCP: `context_set({ scopeRef?, title, summary, expectedRevision?, expectedContentHash? })`, `context_term_define({ scopeRef?, term, definition, avoid?, expectedRevision?, expectedContentHash? })`, or `context_term_forget({ scopeRef?, term, expectedRevision?, expectedContentHash? })`.
- CLI fallback: `agent-issues context set --scope <scope> --title "<title>" --body-file - --json`, `agent-issues context define "<term>" --scope <scope> --body-file - [--avoid "<term[,term]>"] --json`, or `agent-issues context forget "<term>" --scope <scope> --json`.

### Entity Create And Edit

**Kind:** Write.

- MCP create: `entity_create({ kind, title, body?, parentId?, status?, category?, priority?, type?, links? })`.
- MCP edit: first use the **Entity Read** recipe, then call `entity_edit({ entityId, title?, body?, category?, priority?, type?, expectedRevision, expectedContentHash })`.
- CLI fallback: `agent-issues create <kind> --title "<title>" [--parent <parent>] --body-file - --json`, or `agent-issues edit <entityId> [--title "<title>"] --body-file - --json`.

### Entity State And Structure

**Kind:** Write.

- MCP: `entity_status({ entityId, status })`, `entity_move({ entityId, newParentId })`, or `entity_archive({ entityId })`.
- CLI fallback: `agent-issues status <entityId> <status> --json`, `agent-issues move <entityId> <newParentId> --json`, or `agent-issues archive <entityId> --json`.

### Entity Relations

**Kind:** Write.

- MCP: `relation_link({ fromId, relationType, toId })` or `relation_unlink({ fromId, relationType, toId })`.
- CLI fallback: `agent-issues link <fromId> <relationType> <toId> --json` or `agent-issues unlink <fromId> <relationType> <toId> --json`.

### Plan Entry Read

**Kind:** Read.

- MCP: `plan_entry_list({ planId })` or `plan_entry_history({ entryId })`.
- CLI fallback: `agent-issues plan-entry list <planId> --json` or `agent-issues plan-entry history <entryId> --json`.

### Plan Entry Write

**Kind:** Write.

- MCP: `plan_entry_create({ planId, role, body, scopeDirection?, referencedEntityIds?, supersededEntryIds? })`, `plan_entry_edit({ entryId, body, expectedRevision, expectedContentHash })`, or `plan_entry_delete({ entryId, expectedRevision, expectedContentHash })`.
- CLI fallback: `agent-issues plan-entry add <planId> --role <role> --body-file - [--scope-direction <included|excluded>] [--reference <entity>] [--supersedes <entry>] --json`, `agent-issues plan-entry edit <planId> <entryId> --body-file - --json`, or `agent-issues plan-entry delete <planId> <entryId> --json`.

### Plan Entry Issue Link

**Kind:** Write.

- MCP: `plan_entry_issue_link({ entryId, issueId })` or `plan_entry_issue_unlink({ entryId, issueId })`.
- CLI fallback: `agent-issues link <planEntryId> informs <issueId> --json` or `agent-issues unlink <planEntryId> informs <issueId> --json`.
- The MCP operation accepts an issue target only. For existing Plan-entry-to-PRD provenance, MCP is unavailable; use `agent-issues link <planEntryId> informs <prdId> --json` or its unlink fallback.

### Issue Comment Read

**Kind:** Read.

- MCP: `comment_list({ issueId, before?, all? })` or `comment_history({ commentId })`.
- CLI fallback: `agent-issues comment list <issueId> [--before <cursor>] [--all] --json` or `agent-issues comment history <commentId> --json`.

### Issue Comment Write

**Kind:** Write.

- MCP: `comment_create({ issueId, body, referencedIssueIds? })`, `comment_edit({ commentId, body, referencedIssueIds?, expectedRevision, expectedContentHash })`, or `comment_delete({ commentId, expectedRevision, expectedContentHash })`.
- CLI fallback: `agent-issues comment add <issueId> --body-file - [--reference <issue>] --json`, `agent-issues comment edit <issueId> <commentId> --body-file - [--reference <issue>] --json`, or `agent-issues comment delete <issueId> <commentId> --json`.

### Revision Read

**Kind:** Read.

- MCP: `entity_history({ entityId, revision })`, `context_revision({ scopeRef?, revision })`, or `context_term_revision({ scopeRef?, term, revision })`.
- CLI fallback: `agent-issues history <entityId> --revision <revision> --json`, `agent-issues history --context <scope> --revision <revision> --json`, or `agent-issues history --context <scope> --term <term> --revision <revision> --json`.

### Entity Restore

**Kind:** Destructive write.

- MCP: first call `entity_restore_inspect({ entityId, revision })`, then call `entity_restore({ entityId, revision, confirmationToken })` with its token.
- CLI fallback: `agent-issues restore <entityId> --revision <revision> --json`.

### Context Restore

**Kind:** Destructive write.

- MCP: unavailable.
- CLI fallback: `agent-issues restore --context <scope> --revision <revision> --json` or `agent-issues restore --context <scope> --term <term> --revision <revision> --json`.

### Handoff Read

**Kind:** Read.

- MCP: `entity_list({ kind: "handoff" })`, `relation_query({ entityId: handoffId, direction: "outgoing", types: ["handsOff"] })`, then `entity_show({ reference: handoffId })`.
- CLI fallback: `agent-issues list handoff --json`, `agent-issues relations <handoffId> --direction outgoing --type handsOff --json`, then `agent-issues show <handoffId> --json`.

### Handoff Write

**Kind:** Write.

- MCP: `entity_create({ kind: "handoff", title, body, links: [{ relationType: "handsOff", targetId: focusId }] })`.
- CLI fallback: `agent-issues create handoff --title "<title>" --body-file - --link handsOff <focusId> --json`.

### Host Operations

**Kind:** Host.

These operations have no MCP equivalent. Use the CLI: `install-mcp`, `list-mcp`, `uninstall-mcp`, `install-agent`, `list-agent`, `uninstall-agent`, `install-skills`, `list-skills`, `uninstall-skills`, and `site`.

## Record body recipes

Before you create or replace authored body content, identify the record type and read its matching recipe in [`recipes`](./recipes/README.md).

- When the catalog has a recipe for the record type, use that recipe for the body. This applies to context summaries, context terms, entities, handoffs, issue comments, and Pioneer records.
- Do this before the **Entity Create And Edit** recipe, **Context Write** recipe, **Plan Entry Write** recipe, **Issue Comment Write** recipe, or **Handoff Write** recipe creates or replaces a body.
- Tracker actions that do not create or replace a body do not need a recipe.

## Current contracts replace obsolete tests

Do not keep old behavior or compatibility paths only because an old test expects them. When the active issue or a relevant ADR replaces behavior, update or remove the old implementation and its tests. Keep them only when a current compatibility or migration requirement says so.

## Resolve scope efficiently

Use compact, server-selected reads for routine discovery and graph navigation:

- Run the **Entity List** recipe to find candidates by kind. Narrow by status, parent, or limit when the scope is known.
- Run the **Relation Query** recipe with direction and type filters when the skill needs a specific edge set.
- Run the **Entity Read** recipe only when the skill needs an authored body or full stored record.
- Run the **Initiative Read** recipe only for a planned initiative-wide view. Do not use it for routine discovery or blocker checks.
- Prefer the structured MCP result directly. Do not parse presentation text or add downstream filtering that an MCP input can express.

To resume work, run the **Handoff Read** recipe.

## Context is database-backed

The canonical glossary lives in the `agent-issues` database. Do not treat a raw `CONTEXT.md` or `CONTEXT-MAP.md` file as a source of truth.

- Run the **Context Read** recipe before you use project-specific terms.
- Run the **Context Read** recipe with its search or conflict input for project-wide discovery and before you standardize an ambiguous term.
- Run the **Context Write** recipe to create missing project or initiative context with authored title and body content.
- Run the **Context Write** recipe to save resolved terms right away or remove obsolete terms when the current glossary replaces them.
- Keep the shared context free of implementation detail. It is a glossary, not a specification and not a scratch pad.

## Preserve continuity

When work must resume in another session, run the **Handoff Write** recipe to create a graph entity that targets the active issue, user story, PRD, ADR, or initiative. Do not create a sidecar handoff file.