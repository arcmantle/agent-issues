---
name: ai-grill-with-docs
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).
Run this interview with the `ai-domain-modeling` skill.

## Persist Plan State

At the start of a new grilling effort, read the active initiative with `agent-issues show <initiative-reference> --view full --json`. Create one initiative-owned Plan with `agent-issues create plan --title "<Plan title>" --parent <initiative-reference> --body-file - --json`, and provide a stable Goal and Context body through standard input. If the user gives an explicit Plan reference, resume that Plan instead. Do not infer a Plan to resume or create a duplicate Plan.

Use `agent-issues plan-entry add` to record planning state as it changes:

- Record each design question as a `question` entry before asking it.
- Record each durable user answer before continuing. When an answer resolves a design question, add a `decision` entry with `--supersedes <question-reference>`.
- Record each durable fact from code or tool output before it affects later planning. Use the approved role that describes the fact.
- Changed entry -> replacement with `--supersedes`. Decision targets question or decision. Edit only corrections.
- Add no entry for transient conversation that does not change planning state.

Mark the Plan ready with `agent-issues status <plan-reference> ready --json` only after the planning frontier is empty and the user confirms shared understanding. A ready Plan can retain only explicit implementation-discovery questions.

Interview the user closely about the plan until you reach a shared understanding. Walk down each branch of the design tree. Resolve the dependencies between decisions one by one. For each question, give your recommended answer.

Ask one question at a time. Wait for the user's answer before you ask the next question. Do not ask more than one question at a time. This confuses the user.

If you can answer a question by exploring the codebase, explore the codebase instead.