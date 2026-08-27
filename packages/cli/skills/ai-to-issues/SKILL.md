---
name: ai-to-issues
description: Break a plan or PRD into independently grabbable issues, then create and link those issues in agent-issues.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# To Issues

Break a plan into sequenced, independently verifiable issues. Use tracer-bullet vertical slices.

## Process

### 1. Gather context

Work from what is already in the conversation context. If the user gives an entity ID, run the **Entity Read** recipe to resolve it. If the user gives a file path, read the file first.

Run the **Initiative Read** recipe and the **Relation Query** recipe for the active scope to find:

- the parent initiative that must structurally own the new issues
- the PRD and user stories the issues must satisfy
- the active Plan entries that each new issue implements, when the work comes from a Plan
- any existing issues or blockers you must reuse instead of duplicate

### 2. Explore the codebase

If you have not explored the codebase yet, do so now to understand the current state of the code. Issue titles and descriptions must use the established vocabulary and respect the ADRs in the area you touch.

### 3. Draft vertical slices

List every testable behavior, contract, state, integration, and verification change in the plan. Draft one tracer-bullet issue per change. Dependencies remain linked issues; a shared feature outcome is not a reason to merge them.

A slice can be `HITL` or `AFK`. Prefer `AFK` over `HITL` when you can. If the choice matters to the user, state it in the text you present. Do not invent unsupported tracker fields.

Rules:

- Each slice delivers one narrow, complete change through the affected behavior.
- A finished slice is demoable or verifiable on its own.
- Merge changes only when they share one implementation boundary and one acceptance check.
- Use sub-issues when related changes must roll up under one parent issue. In this shape, leaf sub-issues normally carry the `fixes` links to user stories.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- Title
- Type: `HITL` or `AFK`
- Blocked by
- User stories covered

Ask whether the size of each slice and the dependencies feel right, whether to merge or split any slices, and whether the `HITL` and `AFK` split is correct.

Repeat until the user approves the breakdown.

### 5. Publish the issues in agent-issues

For each approved slice:

1. Write a short markdown issue body from the [Issue recipe](../recipes/issue.md) before you publish it. Keep the substance of the approved slice in the body, not just in the title. Include the slice type (`AFK` or `HITL`), the user-visible outcome, the main implementation seam, the acceptance criteria, and any explicit blocker or dependency from the approved breakdown.
2. The **Entity Create And Edit** recipe sends the body as direct MCP text. Its CLI fallback reads the body from standard input; do not place multiline text in a shell argument.
3. Run the **Entity Create And Edit** recipe to create the issue under the correct structural parent: the initiative for top-level work or the parent issue for a sub-issue.
4. If you reuse an existing issue whose body is missing or old, run the **Entity Create And Edit** recipe to update its body before you link anything else.
5. Run the **Entity Relations** recipe to link each leaf issue to every user story it satisfies with `fixes`.
6. For Plan-based work, run the **Plan Entry Issue Link** recipe to link each issue to every active Plan entry it implements with `informs`. Issue creation owns these links.
7. Run the **Entity Relations** recipe to record dependencies with `blocks`.

Publish blockers first, so later issues can link to real issue IDs.

Return a short summary that shows each created issue ID, its linked Plan entries and user stories, and its blockers.