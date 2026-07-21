---
name: ai-grill-with-docs
description: Grilling session that challenges a plan against the existing domain model, sharpens terminology, updates documentation inline, and keeps the work tracked in agent-issues.
disable-model-invocation: true
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

<what-to-do>

Run this interview using the `ai-domain-modeling` skill throughout. Load and follow that skill before beginning, and keep its glossary, scenario, code cross-reference, context-update, and ADR discipline active for the whole session.

Interview the user relentlessly about the plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a question can be answered by exploring the codebase, explore the codebase instead.

</what-to-do>