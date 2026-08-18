---
name: ai-to-prd
description: Turn an explicit ready Plan into a PRD, create the tracked PRD in agent-issues, and create the user stories that the PRD commits to.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

This skill turns an explicit ready Plan and relevant codebase knowledge into a PRD. Do not run an open-ended interview.

A PRD is not created until the `prd` entity exists and its user stories exist as child `userStory` entities.

## Process

1. Require one explicit ready Plan reference. If it is missing or resolves to more than one Plan, stop and ask for the reference. Do not infer a Plan from conversation context.

2. Read the Plan with `agent-issues show <plan-reference> --view full --json`. Reject a record that is not a Plan or is not `ready`. Read its direct owning initiative with `agent-issues relations <plan-reference> --direction incoming --type owns --json`. The Plan must have one initiative owner.

3. Read Plan entries with `agent-issues plan-entry list <plan-reference> --json`. Select active Plan entries by excluding an entry with `tombstone: true` and an entry whose ID occurs in another entry's `supersededEntryIds`. Use only active Plan entries as the source for the PRD and user stories. Do not copy obsolete entry history.

4. If you have not explored the repo yet, do so now to understand the current state of the code. Choose seams where you will test the feature. Use the established vocabulary throughout the PRD and respect applicable ADRs.

5. Write the PRD from the [PRD recipe](../recipes/prd.md). Write each user story from the [User Story recipe](../recipes/user-story.md). Map active entry roles into the relevant product requirements, decisions, scope, constraints, preferences, considerations, and unresolved implementation questions. The child `userStory` entities are authoritative. Do not duplicate their story text in the PRD body.

6. Save the full PRD markdown from the template in the tracked record body. For multiline content, write the markdown to a temporary file and use `--body-file`. Create the `prd` with `agent-issues create prd --title ... --parent <initiative-reference> --body-file "$prdBodyFile" --json`. This preserves initiative ownership of the PRD.

7. Create one `userStory` entity for each approved numbered user story with `agent-issues create userStory --title ... --parent <prd-reference> --body-file "$userStoryBodyFile" --json`. The title can be short, but the body must keep the full committed user story sentence and any essential note tied to that story.

8. Create the non-structural Plan informs PRD relation with `agent-issues link <plan-reference> informs <prd-reference> --json`. Verify that the PRD has initiative ownership and Plan provenance.

9. Return the PRD content together with the tracked IDs you created. Do not create or update a markdown PRD file. The tracked `prd` and `userStory` records are the only canonical PRD representation for this workflow.

Do not treat a markdown document, chat response, or external issue as the source of truth on its own. Do not create a side markdown PRD as part of this workflow. Do not infer a Plan or reuse an existing PRD during conversion.