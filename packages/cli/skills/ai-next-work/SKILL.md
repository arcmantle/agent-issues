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

1. Run the **Next Work** recipe with the supplied initiative or descendant. This one operation resolves a PRD, user story, or issue to its owning initiative and returns the complete work order.
2. A candidate is **workable** when it appears in `available`. The command excludes issues with an open `blocks` source and parent issues with unfinished decomposed children.
3. Use `unblocks` to prefer work that releases the most unfinished issues. A child issue lists its decomposed parent in `unblocks`, so the command makes the path to an unfinished parent explicit.
4. Prefer the thinnest tracer-bullet slice among the available issues with the largest unblock count. Run the **Entity Read** recipe only for finalists whose authored outcome or acceptance criteria you need to compare.
5. Run the **Initiative Read** recipe only when the work order lacks the records needed for a planned initiative-wide decision.

Use the refreshed graph each time. Do not rely on state you captured before the previous issue finished.

## Result

Return the selected issue's:

- Reference and title.
- parent or leaf classification
- user stories it `fixes`
- open blockers
- short reason for the selection

If no issue is workable, return one of:

- **Complete:** every issue in the initiative is `done`, no matter what the initiative's manual status says.
- **Blocked:** unfinished issues remain. Report the blocker chain.

Do not set the selected issue to `in-progress`. The caller decides whether to start it.
