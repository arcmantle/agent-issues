---
name: ai-start-work
description: Start executing an initiative — find the next workable issue, decide how to approach it, then drive implementation with the tdd skill.
argument-hint: Initiative or issue ID to start working on (optional)
---

# Start Work

Pick up an initiative that has already been planned (grilled, captured as a PRD, broken into issues, and handed off) and begin the actual implementation. This skill answers two questions — *what should I work on next* and *how should I approach it* — and then hands the active issue to the `ai-tdd` skill to build.

This skill is the bridge between planning and coding. It does not invent new scope. If you discover work that is not yet tracked, route it back to `/ai-to-issues` instead of starting on untracked work.

## Tracking contract

`agent-issues` is the canonical tracker. Do not treat a chat plan, a handoff document, or a scratch list as the unit of work — the `issue` record is.

- Always prefer machine-readable output: `agent-issues ... --json`.
- Do not start implementing an issue that does not exist in the tracker. Create the missing issue under the correct initiative first, or route to `/ai-to-issues` if the breakdown is non-trivial.
- Move each issue you start through its lifecycle: `agent-issues status ISSx in-progress` when you begin, `agent-issues status ISSx done` when it is implemented and validated.

## Process

### 1. Orient on the initiative

Resolve the scope you were asked to work on.

- If the user passed an initiative or issue ID, start there. Otherwise ask one routing question to identify the initiative.
- If a handoff exists for the scope, read it first with `agent-issues handoff <id> --json` — it tells you where the previous session stopped and what to read next.
- Load the full picture of the initiative with `agent-issues bundle <initiativeId> --json`. This surfaces the PRDs, user stories, ADRs, and issues that define the work.
- Read the initiative-scoped glossary with `agent-issues context show <initiativeId> --json` before using any project vocabulary, so your plan, branch names, and test names match the project's language.
- If the right label is still unclear beyond the initiative boundary, use `agent-issues context search <query> --json` or `agent-issues context conflicts --json` before you start implementation.

Do not skip the bundle and the context. The plan only makes sense in the language the initiative already established.

### 2. Select the next workable issue

From the initiative's issues, choose the single next issue to implement.

- List candidates with `agent-issues list issue --json` and inspect dependencies with `agent-issues relations <id> --json`.
- An issue is **workable** when it is not `done` and nothing that `blocks` it is still open.
- If an issue owns open sub-issues, prefer selecting one of those sub-issues as the next slice unless the parent issue is already at the explicit coordination/closure step.
- Among workable issues, prefer the one that unblocks the most downstream work, then the thinnest tracer-bullet slice.
- If every remaining issue is blocked, stop and report the blocker chain instead of guessing. Surface the blocking issue and what it needs.

Present your pick to the user with its title, whether it is a parent issue or a leaf sub-issue, the user stories it `fixes`, and its blockers. Confirm it is the right next slice before writing any code. Ask one question; do not present a long menu unless the user asks.

### 3. Decide how to approach it

Once the issue is confirmed, work out the approach before touching the tdd loop.

- Explore the codebase to understand the current state of the area the issue touches.
- Re-read any ADR that `constrains` the issue (visible in `agent-issues relations <id> --json`) and respect those decisions.
- Identify the public interface the slice should expose and the observable behavior the user stories demand.
- Surface any assumption the planning did not resolve. If a real, hard-to-reverse design question appears, route it to `/ai-grill-with-docs` rather than deciding silently.

Summarize the approach in a few lines: the interface, the behaviors that matter, and the integration layers the slice cuts through.

### 4. Hand off to the tdd skill

Begin implementation under test-driven development.

- Set the issue in progress: `agent-issues status ISSx in-progress`.
- Invoke the `ai-tdd` skill to implement the confirmed slice. It owns the red-green-refactor loop, the per-cycle checklist, and marking the issue `done`.
- Do not write production code outside the tdd loop. This skill chooses the work; the tdd skill builds it.

### 5. Continue or stop

When the tdd skill reports the issue `done`:

- Return to step 2 and select the next workable issue in the same initiative.
- Continue until no workable issues remain.
- When you stop — finished, blocked, or out of scope — leave the tracker accurate and offer `/ai-handoff` so the next session can resume cleanly.

Do not batch multiple issues into one tdd run. One issue at a time keeps the tracker and the slices honest.
