---
name: ai-tdd
description: Test-driven development with a red-green-refactor loop, anchored to the active agent-issues issue.
---

# Test-Driven Development

## Tracking contract

`agent-issues` is the canonical tracker for the work. Before writing tests or code, identify the active `issue` record with `agent-issues show` and `agent-issues relations` using `--json`, then resolve the parent initiative and read `agent-issues bundle <initiativeId> --json` plus `agent-issues context show <initiativeId> --json` so the issue sits in its full initiative context. If interface or test names depend on ambiguous terminology, use `agent-issues context search <query> --json` or `agent-issues context conflicts --json` before you encode that language in tests.

If the task is not already tracked, create the missing issue under the correct initiative and link it to the user stories it fixes before you start implementing. If the parent initiative is ambiguous, ask one routing question.

Move the active issue through its lifecycle in the tracker:

- When implementation begins, set it to in progress with `agent-issues status ISS1 in-progress`.
- If you discover a true blocker, create or reuse the blocking issue and link it with `agent-issues link BLOCKER_ISS blocks ISS1`.
- When the behavior is implemented and validated, mark the issue done with `agent-issues status ISS1 done`.

Do not treat test files, scratch notes, or a chat plan as the work tracker. The issue record is the unit of execution.

Statuses cascade automatically — do not hand-set them on user stories, PRDs, or ADRs. They are derived at read-time from the issues underneath them, so closing (or reopening) an issue is enough:
- A **user story** is `ready` once it has issues, `in-progress` once any `fixes` issue is in-progress/done, and `done` once they are all done.
- A **PRD** moves to `in-progress` once any of its user stories is in progress, and `approved` once they are all done.
- An **ADR** moves to `accepted` once any issue it `constrains` is in-progress/done, and `superseded` once another ADR `supersedes` it.
- An **initiative** is `done` once its tracked issues are done and its PRDs approved (`active`/`paused` stay manual).

Never run `agent-issues status US#/PRD#/ADR#/INIT# <status>` to advance these by hand — the tracker rejects manual status on a derived record. To move one forward, finish the issues underneath it; to reopen one, reopen an issue.

## Philosophy

Core principle: tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests should not.

Good tests are integration-style. They exercise real code paths through public APIs and describe what the system does, not how it does it. A good test reads like a specification.

Bad tests are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means instead of using the interface.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Anti-pattern: horizontal slices

Do not write all tests first and all implementation second. That produces tests for imagined behavior rather than actual behavior.

Correct approach: vertical slices via tracer bullets.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED->GREEN: test1->impl1
  RED->GREEN: test2->impl2
  RED->GREEN: test3->impl3
```

## Workflow

### 1. Planning

When exploring the codebase, prefer the initiative fast path: if you are resuming an issue, read any available `agent-issues handoff <id> --json`, then `agent-issues bundle <initiativeId> --json`, then `agent-issues context show <initiativeId> --json`. If terminology still looks ambiguous across scopes, run `agent-issues context search <query> --json` or `agent-issues context conflicts --json` before you design tests. This gives you the issue's PRDs, user stories, ADRs, and glossary before you design tests, so test names and interface vocabulary match the project's language and constraints.

Before writing any code:

- Confirm with the user what interface changes are needed.
- Confirm which behaviors to test and prioritize.
- Identify opportunities for [deep modules](deep-modules.md).
- Design interfaces for [testability](interface-design.md).
- List the behaviors to test, not implementation steps.
- Get user approval on the plan.

Ask: what should the public interface look like, and which behaviors matter most to test?

### 2. Tracer bullet

Write one test that confirms one thing about the system.

```
RED:   Write test for first behavior -> test fails
GREEN: Write minimal code to pass -> test passes
```

This proves the path works end to end.

### 3. Incremental loop

For each remaining behavior:

```
RED:   Write next test -> fails
GREEN: Minimal code to pass -> passes
```

Rules:

- One test at a time.
- Only enough code to pass the current test.
- Do not anticipate future tests.
- Keep tests focused on observable behavior.

### 4. Refactor

After all tests pass, look for [refactor candidates](refactoring.md):

- Extract duplication.
- Deepen modules.
- Apply SOLID principles where natural.
- Consider what the new code reveals about existing code.
- Run tests after each refactor step.

Never refactor while red.

## Checklist per cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```