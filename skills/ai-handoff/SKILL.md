---
name: ai-handoff
description: Compact the current conversation into a handoff document for another agent to pick up, anchored to the active agent-issues records.
argument-hint: What will the next session be used for?
---

Write a handoff that lets a fresh agent continue the work without reconstructing the state from scratch. Do not create any file, including temp files or workspace artifacts.

Use `agent-issues` as the canonical tracker for the work. Before writing the handoff, identify the active tracked scope with `agent-issues handoff show <id> --json`. If you need a narrower or lower-level read after that, use `agent-issues show`, `agent-issues relations`, or `agent-issues bundle` as follow-up queries.

Do not write an untracked handoff. If there is no matching issue, PRD, ADR, or initiative for the workstream, create the missing record first when the parent is obvious. If the parent is ambiguous, ask one routing question.

The handoff must include:

- The tracked entity IDs, titles, and statuses that define the current scope.
- Relevant blockers from `blocks` relations.
- Relevant user stories or ADR constraints linked to the active issue.
- Files or artifacts to read next, referenced by path instead of duplicated prose.
- A `suggested skills` section for the next agent.

Do not duplicate content already captured in PRDs, ADRs, plans, issues, commits, or diffs. Reference them by path or identifier instead.

Redact sensitive information such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the handoff accordingly.

## Persist the handoff into the tracker

Once the handoff body is written, save it into `agent-issues` so the next agent can retrieve it. Do not stop at returning prose in the response.

Persist it with:

```
agent-issues handoff create <id> --summary "<one-line summary>" --body-file -
```

Pipe the handoff markdown to stdin using your current shell. Examples:

POSIX shells:

```sh
cat <<'EOF' | agent-issues handoff create <id> --summary "<one-line summary>" --body-file -
<handoff markdown>
EOF
```

PowerShell:

```powershell
@'
<handoff markdown>
'@ | agent-issues handoff create <id> --summary "<one-line summary>" --body-file -
```

- `<id>` is the tracked entity that anchors the handoff (the active issue, PRD, ADR, or initiative). The tool resolves and records the owning initiative automatically, so the handoff appears on that initiative's page.
- `--body-file -` is required and reads the full handoff markdown from stdin, which avoids shell quoting problems and does not require a temp file.
- `--summary` is optional but recommended — it is the one-line label shown in handoff listings.

After saving, confirm the returned handoff ID (e.g. `HO7`) in your response.

Tracking must remain in `agent-issues`. Do not create a sidecar handoff document in `/tmp`, the workspace, or any other file location. If extra prose is needed beyond the persisted handoff, return it in the response only.