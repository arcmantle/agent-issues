---
name: ai-to-prd
description: Turn the current conversation context into a PRD, create the tracked PRD in agent-issues, and create the user stories that the PRD commits to.
---

This skill takes the current conversation context and codebase understanding and produces a PRD. Synthesize what you already know. Do not run an open-ended interview. For new feature work, default to a new initiative unless the user explicitly says this PRD belongs under an existing initiative. If you cannot determine the parent initiative or whether a matching PRD already exists, ask one short routing question.

`agent-issues` is the canonical PRD tracker. A PRD is not considered created until the `prd` entity exists and its user stories have been created as child `userStory` entities.

## Process

1. Explore the repo to understand the current state of the codebase if you have not already. Prefer the initiative fast path: once you know the initiative, read `agent-issues bundle <initiativeId> --json`, then `agent-issues context show <initiativeId> --json`. If you only know a lower-level entity, resolve its parent initiative first. If the PRD needs terminology that may be shared or overloaded, use `agent-issues context search <query> --json` or `agent-issues context conflicts --json` before you lock in names. Use that vocabulary throughout the PRD and respect any ADRs in the area you are touching.

2. Find the parent initiative in `agent-issues`. For new feature work, create a new initiative by default. Reuse an existing initiative only when the user explicitly routes the work there or the conversation makes it unambiguously clear that this PRD is continuing an already-tracked initiative. If the parent is not obvious, ask one short routing question instead of guessing.

3. Sketch the seams at which you are going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can.

4. Write the PRD using the template below.

5. Persist the full PRD markdown from the template into the tracked record body. For multiline content, write the markdown to a temporary file and use `--body-file`. Create the `prd` with `agent-issues create prd --title ... --parent INITx --body-file "$prdBodyFile" --json`, or if you are reusing an existing PRD, update it with `agent-issues edit PRDx --body-file "$prdBodyFile" --json`.

6. Create one `userStory` entity for each approved numbered user story with `agent-issues create userStory --title ... --parent PRDx --body-file "$userStoryBodyFile" --json`. The title may be compact, but the body should preserve the full committed user story sentence and any essential clarifying notes tied to that story. If you reuse an existing user story, backfill or refresh it with `agent-issues edit USx --body-file "$userStoryBodyFile" --json`.

7. Return the PRD content together with the tracked IDs that were created or reused. Do not create or update a markdown PRD artifact; `agent-issues` records are the only canonical PRD representation for this workflow.

Do not treat a markdown document, chat response, or external issue as the source of truth on its own. Do not create a sidecar markdown PRD as part of this workflow. The tracked `prd` and `userStory` records must exist.

<prd-template>

## Problem Statement

The problem from the user's perspective.

## Solution

The solution from the user's perspective.

## User Stories

A numbered list of user stories in the form:

1. As an <actor>, I want a <feature>, so that <benefit>

Make the list extensive enough to cover the feature boundary.

## Implementation Decisions

A list of implementation decisions that were made. This can include modules, interface changes, technical clarifications, architectural decisions, schema changes, API contracts, and specific interactions.

Do not include file paths or code snippets unless a prototype produced a compact snippet that encodes a decision more precisely than prose can.

## Testing Decisions

A list of testing decisions that were made. Include what makes a good test, which modules will be tested, and relevant prior art in the codebase.

## Out of Scope

Things that are intentionally not part of this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>