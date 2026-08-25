---
name: ai-start-work
description: Start work on an initiative. Find the next workable issue, decide how to approach it, then drive the build with ai-tdd or ai-implement.
argument-hint: Initiative or issue ID to start working on (optional)
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Start Work

Pick up an initiative that is already planned: grilled, captured as a PRD, broken into issues, and handed off. Begin the real build. This skill answers two questions, *what to work on next* and *how to approach it*, then hands the active issue to the `ai-tdd` skill to build.

This skill is the bridge between planning and coding.

## Process

### 1. Select the active initiative

Find the scope you were asked to work on.

- If the user gave an initiative or issue ID, start there. If not, ask one routing question to find the initiative.

### 2. Select the next workable issue

Start the `ai-next-work` skill for the active scope. It runs the **Next Work** recipe. If the user supplied an explicit issue, treat it as confirmed and continue to step 3. Otherwise, show its result and confirm the selected issue with the user before you write code. If it reports the work is complete or blocked, stop and return that result.

### 3. Decide how to approach it

Once the issue is selected, work out the approach before you start the build.

- Explore the codebase to understand the current state of the area the issue touches.
- Run the **Relation Query** recipe for the selected issue with its complete relation set. Use the result to identify constraining ADRs, fixed user stories, open blockers, and parent or sub-issue boundaries. Do not repeat relation queries per relation type when one complete result provides them.
- Find the public interface the slice must expose and the behavior the user stories require.
- Surface any assumption the plan left open. If a real, hard-to-reverse design question comes up, send it to `/ai-grill-with-docs`. Do not decide it on your own.

Summarize the approach in a few lines: the interface, the behaviors that matter, and the layers the slice cuts through.

### 4. Hand off to a build skill

Begin the build under test-driven development. Use incremental implementation instead when the change does not fit a red-green-refactor loop, for example a broad refactor, a config or infrastructure change, or a multi-file migration.

- Run the **Entity State And Structure** recipe to set the selected issue to `in-progress`.
- Start `ai-tdd` with the selected issue and approach, or `ai-implement` when the change has no fast test seam. Wait for its completion result and its next-workable-issue result before you continue.
- Do not write production code outside that loop. This skill chooses the work. The build skill builds it.

### 5. Continue or stop

When the build skill reports the finished issue and its next-workable-issue result:

- If it recommends an issue, show that issue and ask whether to continue with it.
- If the user agrees, treat the recommendation as the selected issue and return to step 3 to decide the approach. Do not repeat step 2.
- If no issue is workable, report whether the initiative's issue work is complete, or show the remaining blocker chain that the build skill reported.
- If the user declines, or when the work is complete, blocked, or out of scope, leave the tracker accurate. Offer `/ai-handoff` so the next session can start cleanly.

Do not run more than one issue through one tdd run. One issue at a time keeps the tracker and the slices honest.
