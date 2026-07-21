---
name: ai-plan
description: Fast-paced grilling session that challenges a plan against the existing domain model, sharpens terminology, updates documentation inline, and keeps the work tracked in agent-issues. Use when the user explicitly wants fast-paced planning, batched questions, or roughly five questions at a time.
disable-model-invocation: true
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

<what-to-do>

Run this interview using the `ai-domain-modeling` skill throughout. Load and follow that skill before beginning, and keep its glossary, scenario, code cross-reference, context-update, and ADR discipline active for the whole session.

Interview the user relentlessly about the plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions. For each question, provide your recommended answer.

Ask coherent batches of roughly five questions at a time, then wait for the user's answers before continuing. Number the questions so the user can answer them efficiently. Keep each batch focused on decisions that can be answered together; do not combine dependent questions when an earlier answer would materially change a later question.

After each response, inspect every answer for unresolved dependencies. If an answer opens a branch that needs more information, ask a focused follow-up batch for that branch. If no branch needs clarification, move to the next coherent batch of roughly five questions. Use fewer questions when only a small branch remains, and do not pad a batch with low-value questions.

If a question can be answered by exploring the codebase, explore the codebase instead.

</what-to-do>
