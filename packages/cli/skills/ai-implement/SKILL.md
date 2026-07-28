---
name: ai-implement
description: Delivers a change in thin, independently-verified vertical slices instead of one large pass, anchored to the active agent-issues issue. Use for broad refactors, config or infrastructure changes, multi-file migrations, or other work with no fast test seam.
argument-hint: Issue ID to implement (or the briefing ai-prepare just reported)
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Incremental Implementation

Build in thin vertical slices: implement one piece, verify it, then expand. Each increment leaves the system in a working, verified state. Never implement an entire issue in one uninterrupted pass.

If a slice turns out to have a natural test seam, write the test for that slice. Verification and tests can work together in this skill.

## Workflow

### 1. Planning

Read the active issue, its relations, and its scoped context. If `ai-prepare` reported a briefing at the fork, use that instead. Confirm the public interface, the priority behaviors, and the approach. Resolve any hard-to-reverse question before you write code. Send it to `/ai-grill-with-docs` instead of deciding it yourself.

Break the approach into vertical slices before you start:

- **Vertical (preferred):** each slice is a complete path through the stack. The slice gives the user or caller new, working capability. Do not build one layer at a time across every slice, for example all models, then all endpoints, then all UI.
- **Contract-first:** when two sides of a boundary must move in parallel, fix the shared type or interface first. Then implement each side against it independently.
- **Risk-first:** sometimes one slice is genuinely uncertain, for example an external integration, a tricky migration, or a performance question. Do that slice first. A dead end then surfaces before you build on top of it.

### 2. The increment cycle

For each slice:

1. **Implement** the smallest complete piece of the slice. Before you write it, ask what the simplest thing that could work is. After you write it, check that each abstraction earns its complexity. Do not add complexity for a problem this issue does not have. Three similar lines are better than one early abstraction.
2. **Verify** with the narrowest check available. Run the slice's tests if a test seam exists. If not, run the repository's build, typecheck, and lint commands for the touched packages. Then run a manual check that the behavior matches what the slice promised.
3. **Move to the next slice.** Carry the working state forward. Do not restart. Do not batch verification across slices.

Touch only what the issue requires. If you notice unrelated cleanup worth doing, name it in your report instead of doing it:

```
NOTICED BUT NOT TOUCHING:
- <file>: <what you noticed, and why it's out of this issue's scope>
```

### 3. Increment discipline

- **One thing at a time.** Each increment changes one logical thing. Do not mix a feature addition with an unrelated refactor or config change in the same slice.
- **Keep it compilable.** After every slice, the touched packages must build and their existing tests must still pass. Never leave the tree in a broken state between slices.
- **Safe defaults.** New behavior defaults to off, or to the conservative choice, unless the issue asks for the opposite. Do not change existing behavior for every caller as a side effect of one slice.
- **Rollback-friendly.** Prefer additive changes over edits to existing code, where the issue allows it. Additive changes are new files or new functions. Do not delete code and replace it in the same slice. Split the delete and the replacement into separate slices, so either half reverts on its own.

### 4. Implementation review gate

You, the visible `ai-implement` agent, own every increment, its verification, and any repairs. Do not hand the build to a subagent: you hold the context on what the active `ai-*` skills expect, and a subagent does not have it. Do not treat the first working slice as the end of the work.

After the last slice's focused verification passes, start one read-only review subagent. This is the only step that runs as a subagent. Give the reviewer the active issue context, the changed-file diff, the verification you already ran, and the shared [language standard](../agent-issues-language.md). The reviewer's report, its findings, and every message it writes must follow that standard.

The reviewer must cover both of these:

- **Behavior and contract:** Compare the implementation against the active issue, the linked user stories, the relevant ADRs, and the observable public behavior. Find missing behaviors, wrong semantics, and gaps in behavior coverage.
- **Code and regression risk:** Inspect the changed code for correctness defects, unplanned scope, regressions, gaps in error handling, maintainability concerns, and gaps in validation.

The reviewer must not edit files. It must return either no findings, or structured findings with a severity, a file and location, evidence, and a concrete fix.

`ai-implement` rejects a finding only when it can explain why the finding is invalid or out of scope. For every valid, material finding, fix it yourself. Then re-run the verification that covers the fix. Do not hand repairs to a subagent. If there are no material findings, `ai-implement` records the reviewer report before the final verification. Do not mark the issue done until this gate is complete.

### 5. Complete and report

After the review gate and the final verification pass, mark the active issue `done`. Start the `ai-next-work` skill with the active initiative. Include its result in the completion report. Do not start the selected issue.

## Red flags

Stop and reconsider the current slice if any of these show up:

- More than roughly 100 lines written without running any verification.
- Two or more unrelated changes landing in the same slice.
- Scope creep, for example telling yourself "let me just quickly add this too."
- Skipping verification to move faster.
- The build or tests are broken between slices.
- An abstraction built before a third use case actually demands it.
- Editing files outside the issue's scope because you happened to be nearby.

## Checklist per slice

```
[ ] Slice is a complete, working vertical step, not a partial layer
[ ] A test, build, typecheck, or manual check ran and passed
[ ] No unrelated changes riding along in this slice
[ ] No speculative abstractions added ahead of a real second or third use case
[ ] The tree builds and existing checks still pass after this slice
```
