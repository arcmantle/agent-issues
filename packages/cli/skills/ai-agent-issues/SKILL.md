---
name: ai-agent-issues
description: Internal orientation guide for agents working in repos that use agent-issues. Use when you need to understand the CLI, tracker model, command selection, or workflow before you act.
argument-hint: Which part of agent-issues do you need to review before you continue?
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Agent-Issues Tooling Guide

This is an internal reference skill for the agent. Use it before you continue with real work, when you need more information about how `agent-issues` operates.

Do not start this skill only because the repository uses `agent-issues`. Start it when you lack operational context: which command to run, how entities relate, how statuses change, or which `ai-*` skill owns the next step.

## What to do

Start from the built-in discovery commands before you guess:

- Use `agent-issues capabilities --json` for one combined view of command help, schema, and installed skill state.
- Use `agent-issues help --json` or `agent-issues help <command> --json` for command shapes, options, examples, and expected output.
- Use `agent-issues schema --json` for entity kinds, statuses, structural parent rules, and allowed relations.

Once you have this information, act. Do not keep explaining the task to yourself. Match the task to the smallest command sequence or `ai-*` skill that moves the work forward.

## Core mental model

`agent-issues` tracks work as a graph. It does not track work as loose markdown files.

- `initiative`: the top-level workstream.
- `prd`: the plan or product requirement for an initiative.
- `userStory`: the user-visible slice that the PRD commits to.
- `issue`: the unit of work you can execute.
- `adr`: a hard-to-reverse architecture decision.
- `context`: the database-backed glossary for shared or initiative-scoped terms.

An issue is not always a flat leaf. An issue can `decompose` into sub-issues.

- Use `agent-issues create issue --parent ISSx ...` to create a sub-issue under another issue.
- Use `agent-issues move ISSx ISSy` to move a sub-issue to a different parent issue.
- Link `fixes` from leaf issues to user stories. Parent issues group work and can own sub-issues.

Use `agent-issues list <kind> --json` to find records. Add `--status`, `--parent`, or `--limit` to narrow the result. Use `agent-issues relations <id> --json` to inspect edges. Add `--direction` or `--type` to select the edges you need. Use `agent-issues show <id> --view full --json` when you need the authored content or the complete record. Use `bundle` only for a planned initiative-wide read.

For an entity's complete working context, call `agent-issues relations <id> --view full --json` once with no `--direction`/`--type` filters: it already returns the entity's own full body plus the full body of every directly related entity, both directions, all types, in that one call. Add `--direction`/`--type` only to narrow what comes back for a smaller read, not to gather different edges across several separate calls. For `list issue --json`, the compact result also includes `openBlockers`: an entityId -> open (not-`done`) blocking issue ids map, so a candidate's blocked status is visible on the list itself without one `relations` call per candidate.

## Initiative reads

For real work, start with compact discovery and edge inspection. Use authored or initiative-wide content only when the task needs it:

- To resume a workstream, run `agent-issues list handoff --json`. Then inspect candidates with `agent-issues relations <handoffId> --direction outgoing --type handsOff --json`.
- Read the selected handoff with `agent-issues show <handoffId> --view full --json`. Its authored body carries the session context.
- Use filtered compact lists and relations to move from the target to the active issue and its blockers.
- Use `agent-issues bundle <initiativeId> --view full --json` only when the task needs the whole initiative graph and its authored records.
- Read `agent-issues context show <initiativeId> --json` right after that, so your language and plan match the initiative glossary.
- If a term is still unclear after the initiative read, use `agent-issues context search <query> --view <all|global|initiatives> --json` for project-wide discovery. Use `agent-issues context conflicts --json` when you suspect that one label has more than one definition.
- Fall back to `show <id>` or `relations <id>` only when you need a narrower read on one entity or one edge set.

Default steps:

1. Find candidates with compact filtered `list`.
2. Navigate with compact filtered `relations`.
3. Read one record's authored content with `show --view full`.
4. Read `bundle` only when the whole initiative is a planned input.

Do not fetch full records and trim them with routine `jq` filters. That shows a missing CLI feature. Use compact views and server-side filters, or track the recurring gap.

## Command selection

Use the right command group for the job:

- Find entities: `list`, `show`, `relations`, `bundle`.
- Change tracked data: `create`, `edit`, `link`, `status`.
- Manage vocabulary: `context list`, `context show`, `context search`, `context conflicts`, `context set`, `context define`, `context forget`.
- View the live graph: `serve-site`, `open-site`, `stop-site`.
- Find agent integration commands: `install-agent`, `list-agent`, `uninstall-agent`, `install-skills`, `list-skills`, `uninstall-skills`, `capabilities`.

Use `--json` whenever a program will read the output, or you will use the result to drive the next action. Entity reads and mutation replies are compact by default. Add `--view full` only for the complete record or its authored content.

## Workflow map

When you must choose the next packaged skill, pick it clearly:

1. `ai-domain-modeling` to sharpen terms, boundaries, glossary context, and architecture decisions.
2. `ai-grill-with-docs` to challenge and sharpen a plan one question at a time, with domain modeling.
3. `ai-plan` for the same domain-modeling result at a faster pace, through batches of questions.
4. `ai-to-prd` to capture the plan as a PRD and user stories.
5. `ai-to-issues` to break the plan into issues you can execute.
6. `ai-handoff` to record where the work stands for the next session.
7. `ai-prepare` to resolve an initiative, issue, user story, or handoff and load its context, then stop for a conversation fork before the build starts.
8. `ai-start-work` as the single-session alternative: it also selects the next workable issue, but it drives straight into a build skill without forking.
9. `ai-tdd` to build one issue through a red-green-refactor loop, either started fresh after an `ai-prepare` fork or handed off directly by `ai-start-work`.
10. `ai-implement` as the alternative to `ai-tdd` for the same fork point or hand-off: thin, independently-verified vertical slices for changes that do not fit a red-green-refactor loop (broad refactors, config/infrastructure changes, multi-file migrations).
11. `ai-migrate-docs` to import existing documentation into the tracker.

If you are unsure where the work sits in the workflow, inspect compact entity and relation results first. Use `bundle` only if you must see the whole initiative to choose the workflow.

## Prepare-then-fork

Prefer `ai-prepare` over `ai-start-work` for real build sessions. Do not plan and build in the same conversation. `ai-prepare` gathers context and reports a briefing, then the conversation forks before `ai-tdd` or `ai-implement` starts the build in a fresh conversation with a small context. This keeps a long build loop from growing the cost of a session that also carries the earlier planning and discovery. Use `ai-start-work` only when the user explicitly wants one continuous session.

To save a handoff, create it as a normal graph entity: `agent-issues create handoff --title "<title>" --body-file - --link handsOff <focusId>`. Use `agent-issues edit <handoffId> --title "<title>" --body-file -` to fix its title or body.

## Initiative default

For new feature planning, assume a new initiative by default.

- A new grilling session for a new feature normally needs a new initiative.
- A new PRD for a new feature normally needs a new initiative.
- Reuse an existing initiative only when the user asks for that directly, or when the work is clearly a continuation of an initiative that is already tracked.

Do not add new feature work to an existing initiative only because the themes seem close.

## Working rules

- Act from real command output, not from memory.
- Keep `agent-issues` as the source of truth. Do not invent tracker state.
- If the task depends on a tenant or a scope, put `--tenant` or the entity ID directly in the command you run or recommend.
- Do not turn this skill into a tutorial unless the user asks directly for an explanation of the tooling.
- If the next step is to execute rather than to explain, hand off right away to the matching `ai-*` skill.