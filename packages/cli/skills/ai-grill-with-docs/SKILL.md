---
name: ai-grill-with-docs
description: An interview that challenges a plan against the existing domain model, sharpens terms, updates documentation inline, and keeps the work tracked in agent-issues.
disable-model-invocation: true
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

<what-to-do>

Run this interview with the `ai-domain-modeling` skill active throughout. Load and follow that skill before you begin. Keep its glossary, scenario, code cross-reference, context-update, and ADR rules active for the whole session.

Interview the user closely about the plan until you reach a shared understanding. Walk down each branch of the design tree. Resolve the dependencies between decisions one by one. For each question, give your recommended answer.

Ask one question at a time. Wait for the user's answer before you ask the next question. Do not ask more than one question at a time. This confuses the user.

If you can answer a question by exploring the codebase, explore the codebase instead.

</what-to-do>