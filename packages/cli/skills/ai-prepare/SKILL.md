---
name: ai-prepare
description: Given whatever the user provides — an ID, a topic, a description, a rough pointer — find all the surrounding tracker context and codebase context relevant to it, then stop for a conversation fork. Does not narrow to one issue, change any status, or name what to do next. Use at the start of a work session to gather what forked conversations need without growing the session that will run them.
argument-hint: An ID, a topic, or a description of what to look into
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Prepare

One job: given whatever information the user hands you, find all the surrounding information relevant to it, so that any conversation forked from here has what it needs without redoing the discovery. Nothing more.

Do not narrow the input down to a single issue to work on. Do not decide what gets built. Do not write production code, run tests, change any status, or start a build skill in this skill.

## Process

### 1. Take the input as given

Accept anything: an issue, user story, ADR, initiative, or handoff ID; a topic; a plain description; a fragment of a conversation. Do not force it into a single tracked entity first. If it names or describes one or more entities, resolve those. If it is a handoff, also read its `handsOff` target. If it is a description with no obvious ID, search for matching entities with `agent-issues context search <query> --json` and `agent-issues list <kind> --json`. It is normal for this to surface zero, one, or many entities — report what exists, do not force a pick.

### 2. Load the surrounding context

For every entity the input touches or resolves to:

- Read `agent-issues relations <id> --view full --json` once per entity. This single call returns the entity's own full body and the full body of everything directly related to it, in both directions and all types: `constrains` (ADRs), `fixes` (user stories), `blocks` (blockers), `tracks`/`decomposes` (parent/sub-issues), `handsOff` (handoff targets). Read every relation type straight off this one response. Do not issue a separate filtered `relations` call per type.
- Read `agent-issues context show <id> --json` for the initiative-scoped glossary.
- When the input touches a whole initiative or an area wider than one entity, also list its unfinished issues with `agent-issues list issue --status todo,in-progress,blocked --parent <initiativeId> --json`. Each item's `openBlockers` map shows what still blocks it; read that straight off this response instead of calling `relations` per candidate.

Follow relations outward as far as they stay relevant. Do not stop at the first entity if its blockers, parents, or linked user stories and ADRs also matter to whoever picks this up next.

### 3. Explore the codebase

Explore whatever codebase areas the resolved context points to: the interfaces involved, the behaviors the linked user stories describe, the files and directories that implement or test them. Surface any hard-to-reverse design question and send it to `/ai-grill-with-docs` instead of deciding it yourself.

### 4. Report everything found

Return a compact, self-contained briefing so a fresh conversation does not need to redo discovery:

- Every relevant entity, each with its reference, title, and status. Report the `reference` field, for example `ISS53`, never the internal `id`.
- How they relate: blockers (and whether they are open), parent/sub-issue structure, user stories fixed, ADRs that constrain them.
- The glossary terms and decisions that apply.
- The files and directories the codebase exploration found relevant.
- Any open design questions worth resolving before someone builds this.

Do not recommend a single issue to build next, and do not set any status. Selecting the next issue is `ai-next-work`'s job, not this one.

### 5. Stop for the fork

End your response with this instruction, and do not continue past it:

> Fork this conversation now. Pick up the next step in the new conversation with whatever this briefing points to.

Do not start a build skill yourself, even if asked to continue in the same reply. The fork is what keeps the next step's context small.
