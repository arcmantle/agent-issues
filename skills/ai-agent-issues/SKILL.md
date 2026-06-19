---
name: ai-agent-issues
description: Internal orientation guide for agents working in repos that use agent-issues. Use when you need to understand the CLI, tracker model, command selection, or workflow before taking action.
argument-hint: What part of agent-issues do you need to orient on before proceeding?
---

# Agent-Issues Tooling Guide

This is an internal reference skill for the agent.

Use it when you need to orient yourself on how `agent-issues` works before you continue with real work.

Do not invoke it just because the repository uses `agent-issues`. Invoke it when you are missing operational context: which command to run, how entities relate, how statuses behave, or which `ai-*` skill should own the next step.

## What to do

Start from the built-in discovery surfaces before improvising:

- Use `agent-issues capabilities --json` when you want one combined snapshot of command help, schema, and packaged skill installation state.
- Use `agent-issues help --json` or `agent-issues help <command> --json` when you need command shapes, options, examples, or expected output.
- Use `agent-issues schema --json` when you need entity kinds, statuses, structural parent rules, or allowed relations.

Once oriented, stop explaining to yourself and act. Map the task to the smallest command sequence or `ai-*` skill that moves the work forward.

## Core mental model

`agent-issues` tracks work as a graph, not as loose markdown files.

- `initiative`: the top-level workstream.
- `prd`: the plan or product requirement for an initiative.
- `userStory`: the user-visible slice promised by the PRD.
- `issue`: the executable implementation unit.
- `adr`: a hard-to-reverse architectural decision.
- `context`: the database-backed glossary for shared or initiative-scoped language.

Use `agent-issues show <id> --json` for one record, `agent-issues relations <id> --json` for its edges, and `agent-issues bundle <initiativeId> --json` for the whole initiative view.

## Initiative fast path

For real work, prefer an initiative-first read instead of piecing the graph together one record at a time.

Treat `bundle` as the main quality-of-life command for getting most of what you need in one read:

- Start with `agent-issues handoff <id> --json` if you are resuming an existing workstream and want the last known stopping point.
- Then use `agent-issues bundle <initiativeId> --json` to load the initiative, PRDs, user stories, ADRs, and issues together.
- Read `agent-issues context show <initiativeId> --json` immediately after that so your language and planning match the initiative glossary.
- If the right term is still unclear after the initiative read, use `agent-issues context search <query> --view <all|global|initiatives> --json` for project-wide discovery and `agent-issues context conflicts --json` when you suspect the same label is defined in more than one scope.
- Only fall back to `show <id>` or `relations <id>` when you need a narrower read on one entity or one edge set.

Default heuristic:

1. If you know the initiative, read `bundle` first.
2. If you only know an issue or ADR, use `show` to resolve the parent initiative, then read `bundle`.
3. If the work is being resumed, prefer `handoff` first, then `bundle`, then `context show`.

Do not explore an initiative by manually listing every child kind unless you specifically need a cross-initiative search. `bundle` is the normal entry point.

## Command selection

Use the right command family for the job:

- Discover entities: `list`, `show`, `relations`, `bundle`, `handoff`
- Change tracking data: `create`, `link`, `status`
- Manage vocabulary: `context list`, `context show`, `context search`, `context conflicts`, `context set`, `context define`, `context forget`
- Inspect the live graph visually: `serve-site`, `open-site`
- Discover agent integration surfaces: `install-agent`, `list-agent`, `uninstall-agent`, `install-skills`, `list-skills`, `uninstall-skills`, `capabilities`

Prefer `--json` whenever you are reading output programmatically or using the results to drive the next action.

## Workflow map

When you need to choose the next packaged skill, route yourself explicitly:

1. `ai-grill-with-docs` to challenge and sharpen a plan.
2. `ai-to-prd` to capture the plan as a PRD and user stories.
3. `ai-to-issues` to break the plan into executable issues.
4. `ai-handoff` to capture where the work stands for the next session.
5. `ai-start-work` to pick the next workable issue and prepare execution.
6. `ai-tdd` to implement one issue through a red-green-refactor loop.
7. `ai-migrate-docs` when importing existing documentation into the tracker.

If you are unsure where the work sits in the workflow, inspect the initiative first with `agent-issues bundle <initiativeId> --json` and infer the next missing artifact from the graph.

## Initiative default

For new feature planning, assume a new initiative by default.

- A new grilling session for a new feature normally means a new initiative.
- A new PRD for a new feature normally means a new initiative.
- Reuse an existing initiative only when the user explicitly asks for that, or when the work is plainly a continuation of an already-tracked initiative rather than a new feature.

Do not silently stuff fresh feature work into an existing initiative just because the themes seem adjacent.

## Working rules

- Prefer acting from real command output over memory.
- Keep `agent-issues` as the source of truth; do not invent tracker state.
- If the task depends on tenant or scope, include `--tenant` or the relevant entity ID explicitly in the command you run or recommend.
- Do not turn this skill into a tutorial unless the user explicitly asks for an explanation of the tooling.
- If the next step is execution rather than explanation, hand off immediately to the matching `ai-*` skill.