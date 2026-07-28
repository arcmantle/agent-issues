---
name: ai-prepare
description: Given whatever the user provides — an ID, a topic, a description, a rough pointer — find all the surrounding tracker context and codebase context relevant to it, then stop for a conversation fork. Widens a single issue, story, or ADR out to its whole owning initiative instead of reporting on just that one entity. Does not narrow to one issue, change any status, or name what to do next. Use at the start of a work session to gather what forked conversations need without growing the session that will run them.
argument-hint: An ID, a topic, or a description of what to look into
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Prepare

One job: given whatever information the user hands you, find all the surrounding information relevant to it, so that any conversation forked from here has what it needs without redoing the discovery. Nothing more.

When the input names or resolves to a single issue, user story, or ADR, do not stop at that one entity. Widen out to its whole owning initiative, because any conversation forked from here may end up working on a different issue inside the same initiative. The briefing is initiative-wide, not entity-wide.

Do not narrow the input down to a single issue to work on. Do not decide what gets built. Do not write production code, run tests, change any status, or start a build skill in this skill.

## Process

### 1. Take the input as given

Accept anything: an issue, user story, ADR, initiative, or handoff ID; a topic; a plain description; a fragment of a conversation. Do not force it into a single tracked entity first. If it names or describes one or more entities, resolve those. If it is a handoff, also read its `handsOff` target. If it is a description with no obvious ID, search for matching entities with `agent-issues context search <query> --json` and `agent-issues list <kind> --json`. It is normal for this to surface zero, one, or many entities — report what exists, do not force a pick.

### 2. Widen each entity to its owning initiative

The briefing must cover the whole initiative an entity belongs to, not just that one entity. A conversation forked from here may end up working on any issue inside the initiative, not only the one the user named.

For every resolved entity that is not itself an initiative, project, or epic:

- Read `agent-issues relations <id> --direction incoming --type tracks,decomposes,creates,owns,records --json`. The source of whichever edge comes back is the structural parent.
- Repeat on that parent until you reach an entity of kind `initiative`. An issue tracked directly by an initiative takes one hop; a decomposed sub-issue or a user story reached through a PRD can take two or three.
- Treat that initiative, not the original entity, as the scope for the rest of this skill. Keep a note of which entity started the search, so the briefing can say, for example, "started from ISS53, part of INIT7."

If an entity has no owning initiative (a standalone ADR, project, or epic), keep it as its own scope instead.

### 3. Load the whole initiative

For every initiative in scope:

- Read `agent-issues bundle <initiativeId> --json` (or `agent-issues show <initiativeId> --view full --json`, same shape) once. This single call returns the initiative plus every PRD, user story, ADR, and issue reachable from it — including sub-issues several `decomposes` hops deep — together with `fixLinks`, `subIssueLinks`, `blockerLinks`, and `constrainsLinks`. This is the ground truth for what belongs to the initiative. Do not rebuild it from separate `list` or `relations` calls per entity.
- Read `agent-issues context show <initiativeId> --json` for the initiative-scoped glossary.
- Read open blockers straight off `blockerLinks`: a `source` whose status is not `done` means its `target` is still blocked. Do not call `relations` per issue for this.

Follow relations outward as far as they stay relevant. Do not stop at the first initiative if a linked handoff or a related initiative also matters to whoever picks this up next.

### 4. Explore the codebase

Explore whatever codebase areas the resolved context points to: the interfaces involved, the behaviors the linked user stories describe, the files and directories that implement or test them. Surface any hard-to-reverse design question and send it to `/ai-grill-with-docs` instead of deciding it yourself.

### 5. Report everything found

Return a compact, self-contained briefing so a fresh conversation does not need to redo discovery:

- Every relevant entity across the whole initiative, each with its reference, title, and status. Report the `reference` field, for example `ISS53`, never the internal `id`.
- How they relate: blockers (and whether they are open), parent/sub-issue structure, user stories fixed, ADRs that constrain them.
- The glossary terms and decisions that apply.
- The files and directories the codebase exploration found relevant.
- Any open design questions worth resolving before someone builds this.

If the input named one entity inside the initiative, say so, but do not shrink the briefing back down to just that entity.

Do not recommend a single issue to build next, and do not set any status. Selecting the next issue is `ai-next-work`'s job, not this one.

### 6. Stop for the fork

End your response with this instruction, and do not continue past it:

> Fork this conversation now. Pick up the next step in the new conversation with whatever this briefing points to.

Do not start a build skill yourself, even if asked to continue in the same reply. The fork is what keeps the next step's context small.
