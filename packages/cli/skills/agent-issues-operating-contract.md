# Shared Skill Operating Contract

All bundled `ai-*` skills follow this contract in addition to the shared [language standard](./agent-issues-language.md).

## Tracker is canonical

`agent-issues` is the canonical tracker for work. A chat plan, scratch note, raw markdown document, or test file is not a work record.

- Prefer machine-readable output: `agent-issues ... --json`.
- Before substantive planning, implementation, migration, or handoff work, identify the active tracked scope.
- Do not leave a new workstream, ADR, or implementation follow-up untracked. Create the missing record when its parent is clear; otherwise ask one routing question.
- For new feature planning, default to a new initiative unless the user explicitly places the work in an existing initiative.
- Change status on issues only. User story, PRD, and ADR statuses are derived from their linked issues.

## Current contracts supersede obsolete tests

Do not preserve obsolete behavior or compatibility paths solely because an old test expects them. When the active issue or a relevant ADR replaces behavior, update or remove the superseded implementation and tests unless a current compatibility or migration requirement says otherwise.

## Resolve scope efficiently

Use server-selected compact reads for routine discovery and graph navigation:

- Discover candidates with `agent-issues list <kind> --json`, adding `--status`, `--parent`, and `--limit` whenever the scope is known.
- Inspect edges with `agent-issues relations <id> --json`, adding `--direction` and `--type` to select only relevant edges.
- Use `agent-issues show <id> --view full --json` when authored body content or the complete stored record is required.
- Always reserve `bundle` for intentional initiative-wide reads, not routine discovery or blocker inspection.
- Compact JSON is the default for entity reads and mutation acknowledgements; request `--view full` only when complete records or authored content are required.

For resumed work, begin with `agent-issues list handoff --json`, then inspect a candidate with `agent-issues relations <handoffId> --direction outgoing --type handsOff --json` to confirm its target. Read the handoff or target with `agent-issues show <id> --view full --json` when its authored body is needed.

Routine `jq` projection indicates a missing CLI capability. Use the command's compact view and server-side filters; if they cannot express a recurring narrow read, track that CLI gap instead of normalizing downstream payload trimming.

## Context is database-backed

The canonical glossary lives in the `agent-issues` database. Do not treat raw `CONTEXT.md` or `CONTEXT-MAP.md` files as a source of truth.

- Read initiative-scoped context with `agent-issues context show <entityOrInitiativeId> --json` before introducing project-specific vocabulary.
- Use `agent-issues context search <query> --json` for project-wide discovery and `agent-issues context conflicts --json` before standardizing a potentially overloaded term.
- Initialize missing initiative context with `agent-issues context set --scope <entityOrInitiativeId> --title ... --summary ... --json`.
- Persist resolved terms immediately with `agent-issues context define <term> --scope <entityOrInitiativeId> --definition ... [--avoid ...] --json`; remove stale terms with `agent-issues context forget <term> --scope <entityOrInitiativeId> --json`.
- Keep shared context free of implementation details. It is a glossary, not a specification or scratch pad.

## Preserve continuity

When the work should resume in another session, persist a handoff as a graph entity:

```
agent-issues create handoff --title "<title>" --body-file - --link handsOff <focusId>
```

The handoff must target the active issue, user story, PRD, ADR, or initiative. Do not create sidecar handoff files.