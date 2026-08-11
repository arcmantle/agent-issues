---
name: ai-recipe-migration
description: Restructure approved tracker record bodies to use their applicable record body recipes.
disable-model-invocation: true
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

# Recipe Migration

Recipe migration is a user-invoked process that restructures existing authored bodies to use their applicable [record body recipes](../recipes/README.md). It preserves the source meaning, keeps typed facts and graph relations outside body prose, and writes through normal tracker revisions.

## Scope

Start from an entity, initiative, shared context, or full project. Preview one selected scope at a time:

- **Entity:** Read the record with `agent-issues show <reference> --view full --json`.
- **Initiative:** Read `agent-issues bundle <initiativeReference> --json` and `agent-issues context show <initiativeReference> --json`.
- **Shared context:** Read `agent-issues context show default --json`.
- **Full project:** Read each supported entity kind with `agent-issues list <kind> --json`, then read project and initiative context with `agent-issues context list --json`.

Include authored entity bodies, context summaries, and context terms in the selected scope. Do not migrate generated bodies, empty bodies, or issue comments. Comment migration remains reserved until comment records exist.

## Preview

1. Read the applicable recipe for every selected record.
2. Produce a per-record migration preview before any write. Include the complete tracker reference, record kind, observed revision, and the proposed body.
3. Preserve clear source content. Put content that cannot be assigned safely in `## Notes` when that recipe has a Notes section.
4. Do not add status, parentage, timestamps, revisions, references, or graph relations to body prose. Do not use the generated-content marker as an authored placeholder.
5. Show unchanged records and per-record exclusions with the proposed changes. Let the user exclude any record.

For a full-project recipe migration, preview all supported authored entity bodies and all context summaries and term definitions in the current project. Do not write while the preview is under review.

## Approval And Write

1. Ask for explicit approval of the remaining preview. Approval may cover the selected scope after per-record exclusions.
2. Before each write, reload the record and compare its revision and body with the preview. The migration skips it when the body changed after preview. Do not retry or overwrite a stale record.
3. Write an approved entity with `agent-issues edit <reference> --body-file <path> --json`.
4. Write an approved context summary with `agent-issues context set --scope <scope> --title <title> --body-file <path> --json`.
5. Write an approved context term with `agent-issues context define <term> --scope <scope> --body-file <path> --avoid <existingAvoidList> --json`.

Use existing CLI operations only. Do not add a recipe command group or conditional-write options.

## Report

Report updated, unchanged, excluded, and stale records separately. For every item, include its complete tracker reference. For updated records, report the prior and resulting revisions. Explain restoration with the existing revision commands:

- `agent-issues restore <reference> --revision <priorRevision> --json` for an entity.
- `agent-issues restore --context <scope> --revision <priorRevision> --json` for a context summary.
- `agent-issues restore --context <scope> --term <term> --revision <priorRevision> --json` for a context term.

End after the report. A stale record needs a new preview before it can be considered again.