---
name: ai-next-work
description: Selects the next workable issue from a tracked scope and reports why it should be next. Use after completing an issue or when choosing the next implementation slice.
argument-hint: Initiative or issue ID
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Next Work

Select work; do not implement it or change issue status.

## Input

Accept the active initiative or an issue whose initiative can be resolved from its relations.

## Selection

1. List unfinished issues with `agent-issues list issue --status todo,in-progress,blocked --parent <initiativeId> --json`.
2. Inspect each candidate's blockers with `agent-issues relations <id> --direction incoming --type blocks --json` and its open targets with `--direction outgoing --type blocks`.
3. Use `agent-issues show <id> --view full --json` only when the issue's authored outcome or acceptance criteria are needed to distinguish candidates.
4. Reserve `bundle` for an intentional initiative-wide read when compact lists and edges cannot establish workability.
5. A candidate is **workable** when it is not `done` and no open source issue blocks it.
6. Rank workable leaf issues ahead of parent issues.
7. Within that ordering, prefer the issue that unblocks the most open targets, then the thinnest tracer-bullet slice.

Use the refreshed graph each time. Do not rely on state captured before the previous issue completed.

## Result

Return the selected issue's:

- ID and title
- parent or leaf classification
- user stories it `fixes`
- open blockers
- short selection rationale

If no issue is workable, return one of:

- **Complete:** every issue in the initiative is `done`, regardless of the initiative's manual status.
- **Blocked:** unfinished issues remain; report the blocker chain.

Do not set the selected issue to `in-progress`. The caller decides whether to begin it.
