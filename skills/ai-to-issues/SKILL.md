---
name: ai-to-issues
description: Break a plan or PRD into independently grabbable issues, then create and link those issues in agent-issues.
---

# To Issues

Break a plan into independently grabbable issues using tracer-bullet vertical slices.

`agent-issues` is the canonical issue tracker for this workflow. Do not consider a slice published until the corresponding `issue` entity exists and its `fixes`, `blocks`, and structural parent relationships have been recorded.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an entity ID or a file path as an argument, resolve it first.

Prefer the initiative fast path. If the work is being resumed, start with `agent-issues handoff <id> --json`. Once you know the initiative, use `agent-issues bundle <initiativeId> --json` as the primary read, then fall back to `agent-issues show` or `agent-issues relations` only when you need a narrower read. Use those reads with `--json` to identify:

- the parent initiative that should structurally own the new issues
- the PRD and user stories the issues should satisfy
- any existing issues or blockers that should be reused instead of duplicated

If no suitable parent initiative can be identified, ask one routing question instead of creating orphan records.

### 2. Explore the codebase

If you have not already explored the codebase, do so to understand the current state of the code. Read the initiative-scoped glossary with `agent-issues context show <initiativeId> --json` immediately after the bundle read. If issue names depend on terminology that may exist outside the initiative, use `agent-issues context search <query> --json` or `agent-issues context conflicts --json` before you publish titles. Issue titles and descriptions should use that vocabulary and respect ADRs in the area you are touching.

### 3. Draft vertical slices

Break the plan into tracer-bullet issues. Each issue is a thin vertical slice that cuts through all relevant integration layers end to end, not a horizontal slice of one layer.

Slices may be `HITL` or `AFK`. Prefer `AFK` over `HITL` where possible. If the distinction matters to the user, include it in the prose you present. Do not invent extra tracker fields that the CLI does not support.

Rules:

- Each slice delivers a narrow but complete path through the affected behavior.
- A completed slice is demoable or verifiable on its own.
- Prefer many thin slices over a few thick ones.
- Use sub-issues when one approved issue clearly decomposes into smaller executable steps but should still roll up under one parent issue. In that shape, leaf sub-issues normally carry the `fixes` links to user stories.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- Title
- Type: `HITL` or `AFK`
- Blocked by
- User stories covered

Ask whether the granularity and dependency relationships feel right, whether any slices should be merged or split, and whether the `HITL` versus `AFK` split is correct.

Iterate until the user approves the breakdown.

### 5. Publish the issues in agent-issues

For each approved slice:

1. Write a concise markdown issue body before publishing. Preserve the substance of the approved slice in the body, not just the title. Include the slice type (`AFK` or `HITL`), the user-visible outcome, the main implementation seam, acceptance criteria, and any explicit blockers or dependencies that were part of the approved breakdown.
2. For multiline bodies, write the markdown to a temporary file first and publish it with `--body-file` rather than relying on fragile shell quoting.
3. Create the issue under the correct structural parent with `agent-issues create issue --title ... --parent INITx --body-file "$issueBodyFile" --json` for top-level initiative work, or `agent-issues create issue --title ... --parent ISSx --body-file "$issueBodyFile" --json` for sub-issues.
4. If you are reusing an existing issue whose body is missing or stale, refresh it with `agent-issues edit ISSx --body-file "$issueBodyFile" --json` before linking anything else.
5. Link each leaf issue to every user story it satisfies with `agent-issues link ISSx fixes USy`.
6. Record dependencies with `agent-issues link BLOCKER_ISS blocks BLOCKED_ISS`.

Publish blockers first so that later issues can link to real issue IDs.

Return a concise summary that shows each created issue ID, its linked user stories, and its blockers.

Do not create free-floating markdown issue checklists or external tracker issues before the local `agent-issues` graph is correct.