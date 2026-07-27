---
name: ai-next-work
description: Selects the next workable issue from a tracked scope and reports the reason to work on it next. Use after completing an issue or when choosing the next implementation slice.
argument-hint: Initiative or issue ID
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Next Work

Select work. Do not implement it or change the issue status.

## Input

Accept the active initiative, or an issue whose initiative you can resolve from its relations.

## Selection

1. List unfinished issues with `agent-issues list issue --status todo,in-progress,blocked --parent <initiativeId> --json`.
2. Check each candidate's blockers with `agent-issues relations <id> --direction incoming --type blocks --json`, and its open targets with `--direction outgoing --type blocks`.
3. Use `agent-issues show <id> --view full --json` only when you need the issue's authored outcome or acceptance criteria to tell candidates apart.
4. Use `bundle` only for a planned initiative-wide read, when compact lists and edges cannot show whether the work is ready.
5. A candidate is **workable** when it is not `done` and no open source issue blocks it.
6. Rank workable leaf issues above parent issues.
7. Within that order, prefer the issue that unblocks the most open targets. Then prefer the thinnest tracer-bullet slice.

Use the refreshed graph each time. Do not rely on state you captured before the previous issue finished.

## Result

Return the selected issue's:

- ID and title
- parent or leaf classification
- user stories it `fixes`
- open blockers
- short reason for the selection

If no issue is workable, return one of:

- **Complete:** every issue in the initiative is `done`, no matter what the initiative's manual status says.
- **Blocked:** unfinished issues remain. Report the blocker chain.

Do not set the selected issue to `in-progress`. The caller decides whether to start it.
