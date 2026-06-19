---
name: ai-grill-with-docs
description: Grilling session that challenges a plan against the existing domain model, sharpens terminology, updates documentation inline, and keeps the work tracked in agent-issues.
---

<what-to-do>

Interview the user relentlessly about the plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. For each question, provide your recommended answer.

Ask one question at a time and wait for feedback before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead.

Before substantive work, identify the active tracked scope in `agent-issues`. Prefer the initiative fast path: if you are resuming work, start with `agent-issues handoff <id> --json`; once you know the initiative, read `agent-issues bundle <initiativeId> --json`; then read `agent-issues context show <initiativeId> --json`. If terminology is still unclear across scopes, use `agent-issues context search <query> --json` or `agent-issues context conflicts --json` before you push the user toward a canonical term. Use `agent-issues show`, `agent-issues relations`, and `agent-issues list` only for narrower follow-up reads. For new feature planning, default to creating a new initiative unless the user explicitly says the work belongs inside an existing initiative. If the relevant initiative, PRD, ADR, or issue does not exist, create the missing record before you treat the work as captured. If the correct parent is ambiguous, ask one routing question.

Use `agent-issues` as the canonical tracker. Documentation explains the meaning of the work; the tracker captures the identity and relationships of the work.

Context is also tracked in `agent-issues`. Do not treat a raw `CONTEXT.md` file as the source of truth.

When a hard-to-reverse decision is resolved and an ADR is warranted, create or update the `adr` entity in `agent-issues` under the relevant initiative. Do not create a filesystem ADR document unless the user explicitly asks for one. If that ADR constrains implementation work, link it to the affected issue records with `agent-issues link ADR1 constrains ISS1`.

</what-to-do>

<supporting-info>

## Tracking contract

- Always prefer machine-readable output: `agent-issues ... --json`.
- Never leave a new ADR or a newly clarified workstream untracked.
- Do not create standalone notes or filesystem ADRs that imply planned work without either linking them to an existing tracked entity or creating the missing entity first.
- If the session discovers implementation follow-up that is not yet tracked, call that out explicitly and route it to `/ai-to-issues` rather than burying it in prose.

## Domain awareness

During codebase exploration, also look for existing documentation.

### Database-backed context

The canonical glossary lives in the `agent-issues` database.

- Use initiative-scoped context as the default model. This is the database equivalent of `CONTEXT.md` files inside initiative folders.
- Read it with `agent-issues context show <entityOrInitiativeId> --json` before you use project-specific vocabulary.
- Use `agent-issues context search <query> --json` when you need project-wide discovery across shared and initiative scopes, and `agent-issues context search <query> --terms-only --json` when you only need the matching definitions.
- Use `agent-issues context conflicts --json` before standardizing a term that may already exist elsewhere in the project.
- If the initiative context has not been initialized yet, initialize it with `agent-issues context set --scope <entityOrInitiativeId> --title ... --summary ... --json`.
- When a term is resolved, persist it immediately with `agent-issues context define <term> --scope <entityOrInitiativeId> --definition ... [--avoid ...] --json`.
- If a term becomes wrong or stale, remove it with `agent-issues context forget <term> --scope <entityOrInitiativeId> --json`.
- Use `agent-issues context list --json` only when you need the raw set of stored scopes.
- Do not create or edit a raw `CONTEXT.md` or `CONTEXT-MAP.md` as the source of truth.

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

The shared context must stay free of implementation details. It is a glossary, not a spec or scratch pad.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. Hard to reverse.
2. Surprising without context.
3. The result of a real trade-off.

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

</supporting-info>