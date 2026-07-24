---
name: ai-handoff
description: Compact the current conversation into a handoff document for another agent to pick up, anchored to the active agent-issues records.
argument-hint: What will the next session be used for?
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

Write a handoff that lets a fresh agent continue the work without reconstructing the state from scratch. Do not create any file, including temp files or workspace artifacts.

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
agent-issues create handoff --title "<title>" --body-file - --link handsOff <focusId>
```

Pipe the handoff markdown to stdin using your current shell. Examples:

POSIX shells:

```sh
cat <<'EOF' | agent-issues create handoff --title "<title>" --body-file - --link handsOff <focusId>
<handoff markdown>
EOF
```

PowerShell:

```powershell
@'
<handoff markdown>
'@ | agent-issues create handoff --title "<title>" --body-file - --link handsOff <focusId>
```

- `<focusId>` is the tracked entity that anchors the handoff (the active issue, PRD, ADR, or initiative). The `handsOff` link records that focus in the graph.
- `--body-file -` is required and reads the full handoff markdown from stdin, which avoids shell quoting problems and does not require a temp file.
- `--title` is required and is the one-line label shown in handoff listings.

After saving, confirm the returned handoff ID (e.g. `HO7`) in your response.

To correct a persisted handoff, use the generic entity editor: `agent-issues edit <handoffId> --title "<title>" --body-file -`.

If extra prose is needed beyond the persisted handoff, return it in the response only.