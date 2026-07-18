---
name: ai-tdd
description: Test-driven development with a red-green-refactor loop, anchored to the active agent-issues issue.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Test-Driven Development

## Issue lifecycle

Move the active issue through its lifecycle in the tracker:

- When implementation begins, set it to in progress with `agent-issues status ISS1 in-progress`.
- If you discover a true blocker, create or reuse the blocking issue and link it with `agent-issues link BLOCKER_ISS blocks ISS1`.
- When the behavior is implemented and validated, mark the issue done with `agent-issues status ISS1 done`.

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

## Tests follow the current contract

Do not preserve obsolete code, features, compatibility paths, or public APIs solely because an existing test expects them. When the active issue, approved interface, or relevant ADR deliberately replaces behavior, remove the superseded implementation and update or delete the tests that specify it. Keep old behavior only when an explicit current requirement, compatibility commitment, or migration plan requires it.

Treat a failing old test as evidence to investigate, not automatic proof that the old feature must survive. Decide whether it verifies a still-required behavior; if it does not, change or remove the test in the same slice. The final test suite must specify the intended system after the refactor, not preserve its entire history.

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

When exploring the codebase, prefer the initiative fast path: if you are resuming an issue, find its handoff with `agent-issues list handoff --json`, inspect candidates with `agent-issues show HOx --json`, and verify the `handsOff` relation with `agent-issues relations HOx --json`; then read `agent-issues bundle <initiativeId> --json` and `agent-issues context show <initiativeId> --json`. If terminology still looks ambiguous across scopes, run `agent-issues context search <query> --json` or `agent-issues context conflicts --json` before you design tests. This gives you the issue's PRDs, user stories, ADRs, and glossary before you design tests, so test names and interface vocabulary match the project's language and constraints.

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

### 5. Implementation review gate

`ai-tdd` delegates the confirmed issue to one implementation subagent. That subagent implements the issue through the tracer-bullet and incremental TDD cycles, runs focused validation, and reports the changed-file diff plus validation results to `ai-tdd`. Do not treat a report immediately after the first passing test run as completion.

After the implementation subagent's initial validation, the visible `ai-tdd` orchestrator must launch these two read-only review subagents in parallel. Do not delegate this gate to the implementation subagent: the orchestrator must retain the reviewer reports as auditable evidence.

- **Behavior and contract review:** Compare the implementation and tests against the active issue, linked user stories, relevant ADRs, and observable public behavior. Identify missing behaviors, incorrect semantics, and insufficient behavior coverage.
- **Code and regression review:** Inspect the changed code for correctness defects, unintended scope, regressions, error handling gaps, maintainability concerns, and validation gaps.

Give each reviewer the active issue context, the changed-file diff, and the validation already run. Reviewers must not edit files. They must return either no findings or a structured finding with severity, file and location, evidence, and a concrete correction.

`ai-tdd` consolidates duplicate findings and rejects only findings it can explain as invalid or out of scope. It gives every valid material finding to the implementation subagent for repair, then requires the focused validation that covers the repair. If no material findings exist, `ai-tdd` records both reviewer reports before final validation. Do not mark the issue done until this gate is complete.

### 6. Report the next workable issue

After the implementation review gate passes, final validation succeeds, and the active issue is marked `done`, reload the initiative with `agent-issues bundle <initiativeId> --json`. Use the refreshed graph rather than the state captured before implementation.

Select the next **workable** issue: it is not `done`, and no `blockerLinks` entry targets it from a source issue that is still open. Rank every workable leaf issue ahead of every parent issue. Within that ordering, prefer the issue that is the source for the most open targets in `blockerLinks`, then the thinnest tracer-bullet slice.

Report the selected issue's ID, title, whether it is a parent or leaf issue, the user stories it `fixes`, and its blockers. Do not set it to `in-progress` or begin implementation; the user or `ai-start-work` chooses whether to continue.

If no issue is workable, treat the initiative's issue work as complete when the refreshed bundle contains no issue whose status is not `done`, regardless of the initiative's manual status. If unfinished issues remain blocked, report the blocker chain instead of recommending a blocked issue.

## Implementer standards

If you need a paragraph-long comment to justify why the workaround is OK, the code is wrong — fix the code.

## Checklist per cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```