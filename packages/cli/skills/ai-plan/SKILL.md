---
name: ai-plan
description: Fast-paced grilling session that challenges a plan against the existing domain model, sharpens terminology, updates documentation inline, and keeps the work tracked in agent-issues. Use when the user explicitly wants fast-paced planning, batched questions, or roughly five questions at a time.
disable-model-invocation: true
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

<what-to-do>

Run this interview with the `ai-domain-modeling` skill active throughout. Load and follow that skill before you begin. Keep its glossary, scenario, code cross-reference, context-update, and ADR rules active for the whole session.

Interview the user closely about the plan until you reach a shared understanding. Walk down each branch of the design tree. Resolve the dependencies between decisions. For each question, give your recommended answer.

Ask clear batches of about five questions at a time. Wait for the user's answers before you continue. Number the questions so the user can answer them fast. Keep each batch focused on decisions you can answer together. Do not combine two questions when an earlier answer would change the later question.

After each response, check every answer for open dependencies. If an answer opens a branch that needs more information, ask a focused follow-up batch for that branch. If no branch needs more information, move to the next batch of about five questions. Use fewer questions when only a small branch remains. Do not add low-value questions just to fill a batch.

If you can answer a question by exploring the codebase, explore the codebase instead.

</what-to-do>
