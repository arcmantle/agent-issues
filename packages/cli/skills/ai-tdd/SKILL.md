---
name: ai-tdd
description: Test-driven development with a red-green-refactor loop, anchored to the active agent-issues issue.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Test-Driven Development

## Philosophy

Test observable behavior through public interfaces. Prefer integration-style tests that survive internal refactors.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Anti-pattern: horizontal slices

Use vertical tracer bullets. Do not write all tests first and all implementation second.

## Workflow

### 1. Planning

Read the active issue, relations, and scoped context. Confirm the public interface, prioritized behaviors, and approach. Resolve hard-to-reverse ambiguity before coding. See [deep modules](deep-modules.md) and [interface design](interface-design.md) when those concerns are material.

### 2. Tracer bullet

Write one test that confirms one thing about the system.

```
RED:   Write test for first behavior -> test fails
GREEN: Write minimal code to pass -> test passes
```

Confirm the test fails for the expected reason before implementation.

### 3. Incremental loop

For each remaining behavior:

```
RED:   Write next test -> fails
GREEN: Minimal code to pass -> passes
```

Run one test at a time. Write only enough code to pass it, then continue with the next behavior.

### 4. Refactor

Refactor only while green, using [refactoring guidance](refactoring.md), and rerun focused tests after each step.

### 5. Implementation review gate

Delegate the confirmed issue and approach to one implementation subagent. It owns the TDD cycles, focused validation, and repairs. Do not treat the first passing test as completion.

After the implementation subagent's initial validation, the visible `ai-tdd` orchestrator must launch one read-only review subagent. Do not delegate this gate to the implementation subagent: the orchestrator must retain the reviewer report as auditable evidence.

The reviewer must cover both dimensions:

- **Behavior and contract:** Compare the implementation and tests against the active issue, linked user stories, relevant ADRs, and observable public behavior. Identify missing behaviors, incorrect semantics, and insufficient behavior coverage.
- **Code and regression risk:** Inspect the changed code for correctness defects, unintended scope, regressions, error handling gaps, maintainability concerns, and validation gaps.

Give the reviewer the active issue context, the changed-file diff, and the validation already run. The reviewer must not edit files. It must return either no findings or structured findings with severity, file and location, evidence, and a concrete correction.

`ai-tdd` rejects only findings it can explain as invalid or out of scope. It gives every valid material finding to the implementation subagent for repair, then requires the focused validation that covers the repair. If no material findings exist, `ai-tdd` records the reviewer report before final validation. Do not mark the issue done until this gate is complete.

### 6. Complete and report

After the review gate and final focused validation pass, mark the active issue `done`. Invoke the `ai-next-work` skill with the active initiative and include its result in the completion report. Do not start the selected issue.

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