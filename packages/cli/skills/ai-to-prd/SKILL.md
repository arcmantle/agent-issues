---
name: ai-to-prd
description: Turn the current conversation context into a PRD, create the tracked PRD in agent-issues, and create the user stories that the PRD commits to.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

This skill turns the current conversation context and your knowledge of the codebase into a PRD. Use what you already know. Do not run an open-ended interview.

A PRD is not created until the `prd` entity exists and its user stories exist as child `userStory` entities.

## Process

1. If you have not explored the repo yet, do so now to understand the current state of the code. Use the established vocabulary throughout the PRD and respect any ADRs in the area you touch.

2. Find the parent initiative in `agent-issues`.

3. Choose the seams where you will test the feature. Prefer an existing seam over a new one. Use the highest seam you can. If you need a new seam, propose it at the highest point you can.

4. Write the PRD from the [PRD recipe](../recipes/prd.md). Write each user story from the [User Story recipe](../recipes/user-story.md).

5. Save the full PRD markdown from the template in the tracked record body. For multiline content, write the markdown to a temporary file and use `--body-file`. Create the `prd` with `agent-issues create prd --title ... --parent INITx --body-file "$prdBodyFile" --json`. If you reuse an existing PRD, update it with `agent-issues edit PRDx --body-file "$prdBodyFile" --json`.

6. Create one `userStory` entity for each approved numbered user story with `agent-issues create userStory --title ... --parent PRDx --body-file "$userStoryBodyFile" --json`. The title can be short, but the body must keep the full committed user story sentence and any essential note tied to that story. If you reuse an existing user story, refresh it with `agent-issues edit USx --body-file "$userStoryBodyFile" --json`.

7. Return the PRD content together with the tracked IDs you created or reused. Do not create or update a markdown PRD file. The `agent-issues` records are the only canonical PRD representation for this workflow.

Do not treat a markdown document, a chat response, or an external issue as the source of truth on its own. Do not create a side markdown PRD as part of this workflow. The tracked `prd` and `userStory` records must exist.