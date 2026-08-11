---
name: ai-handoff
description: Compact the current conversation into a handoff document for another agent to pick up, anchored to the active agent-issues records.
argument-hint: What will the next session be used for?
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

Write a handoff that lets a new agent continue the work without rebuilding the state from scratch. Do not create a file, including a temp file or a workspace artifact.
Use the [Handoff recipe](../recipes/handoff.md) for the tracked handoff body.

The handoff must include:

- The tracked entity IDs, titles, and statuses that define the current scope.
- The relevant blockers from `blocks` relations.
- The relevant user stories or ADR constraints linked to the active issue.
- The files or artifacts to read next, given by path instead of copied text.
- A `suggested skills` section for the next agent.

Do not copy content that already exists in a PRD, an ADR, a plan, an issue, a commit, or a diff. Reference it by path or ID instead.

Remove sensitive information such as API keys, passwords, or personal data.

If the user gave arguments, treat them as a description of the next session's focus. Shape the handoff to match.

## Save the handoff in the tracker

Once you write the handoff body, save it in `agent-issues` so the next agent can retrieve it. Do not stop at returning text in your response.

Save it with:

```
agent-issues create handoff --title "<title>" --body-file - --link handsOff <focusId>
```

Pipe the handoff markdown to stdin with your current shell. Examples:

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

- `<focusId>` is the tracked entity that anchors the handoff: the active issue, PRD, ADR, or initiative. The `handsOff` link records that focus in the graph.
- `--body-file -` is required. It reads the full handoff markdown from stdin. This avoids shell quoting problems and does not need a temp file.
- `--title` is required. It is the one-line label shown in handoff lists.

After you save the handoff, return this continuation prompt in a code block, with the returned handoff ID (for example, `HO7`):

```text
Continue from handoff <handoffId>.
```

To fix a saved handoff, use the generic entity editor: `agent-issues edit <handoffId> --title "<title>" --body-file -`.

If you need more text beyond the saved handoff, put it in your response only.