---
name: ai-start-work
description: Start executing an initiative - find the next workable issue, decide how to approach it, then drive implementation with the tdd skill.
argument-hint: Initiative or issue ID to start working on (optional)
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Start Work

Pick up an initiative that has already been planned (grilled, captured as a PRD, broken into issues, and handed off) and begin the actual implementation. This skill answers two questions: *what should I work on next* and *how should I approach it*, then hands the active issue to the `ai-tdd` skill to build.

This skill is the bridge between planning and coding.

## Issue lifecycle

- Move each issue you start through its lifecycle: `agent-issues status ISSx in-progress` when you begin, `agent-issues status ISSx done` when it is implemented and validated.

## Process

### 1. Select the active initiative

Resolve the scope you were asked to work on.

- If the user passed an initiative or issue ID, start there. Otherwise ask one routing question to identify the initiative.

### 2. Select the next workable issue

From the initiative's issues, choose the single next issue to implement.

- List candidates with `agent-issues list issue --json` and inspect dependencies with `agent-issues relations <id> --json`.
- An issue is **workable** when it is not `done` and nothing that `blocks` it is still open.
- Rank every workable leaf issue ahead of every parent issue.
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

### 4. Hand off to the TDD skill

Begin implementation under test-driven development.

- Set the issue in progress: `agent-issues status ISSx in-progress`.
- Invoke the `ai-tdd` skill to delegate the confirmed slice to its implementation subagent. The implementation subagent owns implementation, focused validation, and repairs for accepted findings. The visible `ai-tdd` orchestrator owns the two parallel read-only reviews, final validation, marking the issue `done`, and reporting the next workable issue.
- Do not write production code outside the tdd loop. This skill chooses the work; the tdd skill builds it.

### 5. Continue or stop

When `ai-tdd` reports the completed issue and its next-workable-issue result:

- If it recommends an issue, present that issue and ask whether to continue with it.
- If the user confirms, treat the recommendation as the selected issue and return to step 3 to decide how to approach it. Do not repeat step 2.
- If no issue is workable, report whether the initiative's issue work is complete or show the remaining blocker chain reported by `ai-tdd`.
- If the user declines, or when the work is complete, blocked, or out of scope, leave the tracker accurate and offer `/ai-handoff` so the next session can resume cleanly.

Do not batch multiple issues into one tdd run. One issue at a time keeps the tracker and the slices honest.
