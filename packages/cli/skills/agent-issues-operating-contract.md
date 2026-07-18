# Shared Skill Operating Contract

All bundled `ai-*` skills follow this contract in addition to the shared [language standard](./agent-issues-language.md).

## Tracker is canonical

`agent-issues` is the canonical tracker for work. A chat plan, scratch note, raw markdown document, or test file is not a work record.

- Prefer machine-readable output: `agent-issues ... --json`.
- Before substantive planning, implementation, migration, or handoff work, identify the active tracked scope.
- Do not leave a new workstream, ADR, or implementation follow-up untracked. Create the missing record when its parent is clear; otherwise ask one routing question.
- For new feature planning, default to a new initiative unless the user explicitly places the work in an existing initiative.

## Resolve scope efficiently

For resumed work, begin with `agent-issues list handoff --json`, then inspect a candidate with `agent-issues show HOx --json` and `agent-issues relations HOx --json` to confirm its `handsOff` target. Once the initiative is known, use `agent-issues bundle <initiativeId> --json` as the primary read. Use `show`, `relations`, and `list` for narrower follow-up reads only.

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