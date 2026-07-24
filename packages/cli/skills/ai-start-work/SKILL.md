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

## Process

### 1. Select the active initiative

Resolve the scope you were asked to work on.

- If the user passed an initiative or issue ID, start there. Otherwise ask one routing question to identify the initiative.

### 2. Select the next workable issue

Invoke the `ai-next-work` skill for the active scope. Present its result and confirm the selected issue with the user before writing code. If it reports complete or blocked, stop with that result.

### 3. Decide how to approach it

Once the issue is confirmed, work out the approach before touching the tdd loop.

- Explore the codebase to understand the current state of the area the issue touches.
- Find constraining ADRs with `agent-issues relations <id> --direction incoming --type constrains --json`, then read each ADR's authored decision with `agent-issues show <adrId> --view full --json`.
- Identify the public interface the slice should expose and the observable behavior the user stories demand.
- Surface any assumption the planning did not resolve. If a real, hard-to-reverse design question appears, route it to `/ai-grill-with-docs` rather than deciding silently.

Summarize the approach in a few lines: the interface, the behaviors that matter, and the integration layers the slice cuts through.

### 4. Hand off to the TDD skill

Begin implementation under test-driven development.

- Set the issue in progress: `agent-issues status ISSx in-progress`.
- Invoke the `ai-tdd` skill with the confirmed issue and approach. Wait for its completion result and next-workable-issue result before continuing.
- Do not write production code outside the tdd loop. This skill chooses the work; the tdd skill builds it.

### 5. Continue or stop

When `ai-tdd` reports the completed issue and its next-workable-issue result:

- If it recommends an issue, present that issue and ask whether to continue with it.
- If the user confirms, treat the recommendation as the selected issue and return to step 3 to decide how to approach it. Do not repeat step 2.
- If no issue is workable, report whether the initiative's issue work is complete or show the remaining blocker chain reported by `ai-tdd`.
- If the user declines, or when the work is complete, blocked, or out of scope, leave the tracker accurate and offer `/ai-handoff` so the next session can resume cleanly.

Do not batch multiple issues into one tdd run. One issue at a time keeps the tracker and the slices honest.
