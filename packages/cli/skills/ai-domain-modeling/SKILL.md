---
name: ai-domain-modeling
description: Builds and sharpens the tracked domain model by resolving terminology, testing boundaries with concrete scenarios, reconciling the model with code, and recording glossary terms and architectural decisions. Use when the user wants to define domain language, refine a model, record an ADR, or when another skill needs active domain-modeling discipline.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Domain Modeling

Actively build and sharpen the project's domain model while designing. This skill changes the model by challenging terms, testing edge cases, and recording resolved language and decisions. Merely reading initiative context for established vocabulary does not require this skill.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language returned by `agent-issues context show <entityOrInitiativeId> --json` or `agent-issues context conflicts --json`, call it out immediately.

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term.

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force precision about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it.

### Update context inline

When a term is resolved, update the database-backed context immediately. Do not batch glossary updates. Use the rules in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. Hard to reverse.
2. Surprising without context.
3. The result of a real trade-off.

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

When an ADR is warranted, create or update the `adr` entity in `agent-issues` under the relevant initiative. Do not create a filesystem ADR document unless the user explicitly asks for one. If the ADR constrains implementation work, link it to the affected issues with `agent-issues link ADR1 constrains ISS1`.
