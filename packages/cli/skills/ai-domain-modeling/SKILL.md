---
name: ai-domain-modeling
description: Builds and sharpens the tracked domain model. It resolves terms, tests boundaries with real scenarios, checks the model against the code, and records glossary terms and architecture decisions. Use it when the user wants to define domain language, refine a model, record an ADR, or when another skill needs active domain modeling.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Domain Modeling

Actively build and sharpen the project's domain model while you design. This skill changes the model. It challenges terms, tests edge cases, and records resolved language and decisions. If you only read initiative context for known vocabulary, you do not need this skill.

## During the session

### Challenge against the glossary

The user can use a term that conflicts with the language returned by `agent-issues context show <entityOrInitiativeId> --json` or `agent-issues context conflicts --json`. When this happens, point it out right away.

### Sharpen fuzzy language

The user can use a vague or overloaded term. When this happens, propose one precise term.

### Discuss concrete scenarios

When you discuss domain relationships, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force precision about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a conflict, point it out.

### Update context inline

When you resolve a term, update the database-backed context right away. Do not batch glossary updates. Use the rules in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

### Offer ADRs only when needed

Offer to create an ADR only when all three of these are true:

1. The decision is hard to reverse.
2. The decision is surprising without context.
3. The decision came from a real trade-off.

If any of the three is not true, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

When an ADR is needed, create or update the `adr` entity in `agent-issues` under the relevant initiative. Do not create a markdown ADR file unless the user asks for one directly. If the ADR limits implementation work, link it to the affected issues with `agent-issues link ADR1 constrains ISS1`.
