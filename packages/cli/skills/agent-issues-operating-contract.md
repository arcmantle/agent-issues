# Shared Skill Operating Contract

All bundled `ai-*` skills follow this contract. They also follow the shared [language standard](./agent-issues-language.md).

## Tracker is canonical

`agent-issues` is the single tracker for work. A chat plan, a scratch note, a raw markdown document, and a test file are not work records.

- Use machine-readable output: `agent-issues ... --json`.
- Before you plan, implement, migrate, or hand off work, find the active tracked scope.
- Do not leave a new workstream, ADR, or implementation follow-up untracked. Create the missing record when its parent is clear. If not, ask one routing question.
- For new feature planning, create a new initiative by default. Reuse an existing initiative only when the user asks for that directly.
- Change status on issues only. Derive user story and PRD status from their linked issues. An ADR is `current` unless it is `superseded` or `archived`.
- Treat each entity's complete `reference` field as its public tracker identity. Copy it exactly as returned by the CLI whenever you report or pass an entity to another command. Never abbreviate or truncate it, and never replace it with the internal `id`.

Issue comments use complete `COM_` references. They are issue discussion, not tracker state: use tracker records for scope, decisions, blockers, handoffs, and status.

## Record body recipes

Before you create or replace authored body content, identify the record type and read its matching recipe in [`recipes`](./recipes/README.md).

- When the catalog has a recipe for the record type, use that recipe for the body. This applies to context summaries, context terms, entities, handoffs, issue comments, and Wayfinder records.
- Do this before commands that write a body, including `context set`, `context define`, `create --body-file`, and `edit --body-file`.
- Commands that do not create or replace a body do not need a recipe.

## Current contracts replace obsolete tests

Do not keep old behavior or compatibility paths only because an old test expects them. When the active issue or a relevant ADR replaces behavior, update or remove the old implementation and its tests. Keep them only when a current compatibility or migration requirement says so.

## Resolve scope efficiently

Use compact, server-selected reads for routine discovery and graph navigation:

- Find candidates with `agent-issues list <kind> --json`. Add `--status`, `--parent`, and `--limit` when you know the scope.
- Inspect edges with `agent-issues relations <id> --json`. Add `--direction` and `--type` to select only the relevant edges.
- Use `agent-issues show <id> --view full --json` only when you need the authored body or the complete stored record.
- Use `bundle` only for a planned initiative-wide read. Do not use it for routine discovery or blocker checks.
- Compact JSON is the default for entity reads and mutation replies. Request `--view full` only when you need the complete record or its authored content.

To resume work, start with `agent-issues list handoff --json`. Then inspect a candidate with `agent-issues relations <handoffId> --direction outgoing --type handsOff --json` to confirm its target. Read the handoff or its target with `agent-issues show <id> --view full --json` when you need the authored body.

Routine `jq` filtering shows a missing CLI feature. Use the command's compact view and server-side filters instead. If they cannot give you a recurring narrow read, track that CLI gap. Do not normalize downstream payload trimming as a workaround.

## Context is database-backed

The canonical glossary lives in the `agent-issues` database. Do not treat a raw `CONTEXT.md` or `CONTEXT-MAP.md` file as a source of truth.

- Read project or initiative context with `agent-issues context show <entityOrProjectOrInitiativeId> --json` before you use project-specific terms.
- Use `agent-issues context search <query> --json` for project-wide discovery. Use `agent-issues context conflicts --json` before you standardize a term that may have more than one meaning.
- Set up missing project or initiative context with `agent-issues context set --scope <entityOrProjectOrInitiativeId> --title ... --body-file <path|-> --json`.
- Save resolved terms right away with `agent-issues context define <term> --scope <entityOrProjectOrInitiativeId> --body-file <path|-> [--avoid ...] --json`. Remove old terms with `agent-issues context forget <term> --scope <entityOrProjectOrInitiativeId> --json`.
- Keep the shared context free of implementation detail. It is a glossary, not a specification and not a scratch pad.

## Preserve continuity

When work must resume in another session, save a handoff as a graph entity:

```
agent-issues create handoff --title "<title>" --body-file - --link handsOff <focusId>
```

The handoff must target the active issue, user story, PRD, ADR, or initiative. Do not create a sidecar handoff file.