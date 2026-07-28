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

1. List unfinished issues with `agent-issues list issue --status todo,in-progress,blocked --parent <initiativeId> --json`. Each item carries its `reference`, the value to use everywhere else, never the internal `id`. Its compact JSON also includes `openBlockers`: a reference -> open, not-`done`, blocking issue references map, computed for every issue in the response.
2. A candidate is **workable** when `openBlockers[reference]` is empty. Read this straight off the step-1 response. Do not call `relations` per candidate to determine blocked status.
3. To find how many open targets a candidate unblocks, invert the `openBlockers` map from step 1: count how many other listed issues have the candidate's reference in their `openBlockers` array. This needs no additional call. This count is scoped to the current initiative and the `--status` filter from step 1. A candidate that blocks an issue in a different initiative, or one outside that status filter, is not counted. That scope matches what this skill ranks, which is work within one initiative. It is intentional, not a gap to work around.
4. Rank workable leaf issues above parent issues. Use `agent-issues relations <id> --direction outgoing --type decomposes --json` only for a candidate you cannot otherwise classify. Most issues are leaves. This call is rarely needed for every candidate.
5. Within that order, prefer the issue that unblocks the most open targets, using the count from step 3. Then prefer the thinnest tracer-bullet slice. Use `agent-issues show <id> --view full --json` only on the few finalists whose authored outcome or acceptance criteria you need to compare.
6. Use `bundle` only for a planned initiative-wide read, when the compact list and its inline blocker map cannot show whether the work is ready.

Use the refreshed graph each time. Do not rely on state you captured before the previous issue finished.

## Result

Return the selected issue's:

- Reference and title. Report the `reference` field, for example `ISS53`, never the internal `id`.
- parent or leaf classification
- user stories it `fixes`
- open blockers
- short reason for the selection

If no issue is workable, return one of:

- **Complete:** every issue in the initiative is `done`, no matter what the initiative's manual status says.
- **Blocked:** unfinished issues remain. Report the blocker chain.

Do not set the selected issue to `in-progress`. The caller decides whether to start it.
