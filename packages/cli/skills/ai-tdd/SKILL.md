---
name: ai-tdd
description: Test-driven development with a red-green-refactor loop, anchored to the active agent-issues issue.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Test-Driven Development

## Philosophy

Test observable behavior through public interfaces. Prefer integration-style tests that survive internal refactors.

See [tests.md](tests.md) for examples. See [mocking.md](mocking.md) for mocking rules.

## Removed behavior

When an issue removes a feature, constraint, or compatibility path, remove or update its obsolete tests. Do not add a new test whose only purpose is to confirm that deleted code or an obsolete restriction has not returned. That test has no current behavior contract and adds maintenance cost. Test a replacement or newly supported observable behavior when the change creates one. Add an absence test only when the active issue or a relevant ADR makes the absence an explicit, observable requirement.

## Static declarations

Do not add a test that reads a static declaration and restates its literal shape or values. Examples include object trees, route tables, dependency lists, manifests, schema entries, and constant maps. Such a test duplicates the implementation and fails on an intentional edit without protecting caller behavior.

For a static declaration change, test the behavior that consumes the declaration through its public interface. If no distinct behavior can fail, do not force a red-green cycle. Use the existing behavioral suite, type-check, lint, build, or focused inspection as validation instead. Test the declaration directly only when its serialized shape is itself a supported external contract.

## Anti-pattern: horizontal slices

Use vertical tracer bullets. Do not write all the tests first and all the implementation second.

## Workflow

### 1. Planning

Run the **Entity Read** recipe, the **Relation Query** recipe, and the **Context Read** recipe for the active issue and its scope. Confirm the public interface, the priority behaviors, and the approach. Resolve any hard-to-reverse question before you code. See [deep modules](deep-modules.md) and [interface design](interface-design.md) when these concerns matter.

Treat the issue's `planEntries` as planning inputs to inspect. Do not create or change Plan-entry links. Report missing Plan-entry provenance to the issue creator.

### 2. Tracer bullet

Write one test that confirms one thing about the system.

```
RED:   Write test for first behavior -> test fails
GREEN: Write minimal code to pass -> test passes
```

Confirm the test fails for the expected reason before you write the implementation.

### 3. Incremental loop

For each remaining behavior:

```
RED:   Write next test -> fails
GREEN: Minimal code to pass -> passes
```

Run one test at a time. Write only enough code to pass it. Then move to the next behavior.

### 4. Refactor

Refactor only while the tests are green. Use the [refactoring guidance](refactoring.md). Run the focused tests again after each step.

### 5. Implementation review gate

You, the visible `ai-tdd` agent, own the TDD cycles, the focused validation, and any repairs. Do not hand the build to a subagent: you hold the context on what the active `ai-*` skills expect, and a subagent does not have it. Do not treat the first passing test as the end of the work.

After your first focused validation passes, start one read-only review subagent. This is the only step that runs as a subagent. Give the reviewer the active issue context, the changed-file diff, the validation you already ran, and the shared [language standard](../agent-issues-language.md). The reviewer's report, its findings, and every message it writes must follow that standard.

The reviewer must cover both of these:

- **Behavior and contract:** Compare the implementation and tests against the active issue, the linked user stories, the relevant ADRs, and the observable public behavior. Find missing behaviors, wrong semantics, and gaps in behavior coverage.
- **Code and regression risk:** Inspect the changed code for correctness defects, unplanned scope, regressions, gaps in error handling, maintainability concerns, and gaps in validation.

The reviewer must not edit files. It must return either no findings, or structured findings with a severity, a file and location, evidence, and a concrete fix.

`ai-tdd` rejects a finding only when it can explain why the finding is invalid or out of scope. For every valid, material finding, fix it yourself. Then run the focused validation that covers the fix. Do not hand repairs to a subagent. If there are no material findings, `ai-tdd` records the reviewer report before the final validation. Do not mark the issue done until this gate is complete.

### 6. Complete and report

After the review gate and the final focused validation pass, mark the active issue `done`. Start the `ai-next-work` skill with the active initiative. Include its result in the completion report. Do not start the selected issue.

## Implementer standards

If you need a paragraph-long comment to justify a workaround, the code is wrong. Fix the code.

## Checklist per cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Test does not restate a static declaration unless that shape is an external contract
[ ] Test covers current or newly supported behavior, not only the absence of removed behavior
[ ] Obsolete tests were removed or updated
[ ] Code is minimal for this test
[ ] No speculative features added
```