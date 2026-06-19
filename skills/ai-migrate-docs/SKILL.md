---
name: ai-migrate-docs
description: Migrates existing project documentation into tracked agent-issues records and relationships. Use when importing or backfilling PRDs, ADRs, glossary docs, planning notes, or issue lists into agent-issues.
---

# Migrate Docs

`agent-issues` is the canonical tracker. Existing markdown docs, tickets, and notes are source material to interpret, not the final source of truth.

## Process

### 1. Inventory the source material

- Identify the specific documents or notes the user wants migrated.
- Classify each source as glossary/context, initiative or roadmap, PRD or spec, ADR, or issue or task breakdown.
- Reuse an existing initiative when the fit is clear. Use `agent-issues list initiative --json` to discover candidates, then prefer `agent-issues bundle <initiativeId> --json` as the main read to avoid creating duplicates. Fall back to `agent-issues show <id> --json` only when you need a narrower check on one candidate.
- If the target initiative is ambiguous, ask one short routing question before creating anything.

### 2. Load tracked context first

- Read the existing glossary with `agent-issues context show <initiativeId> --json` immediately after the bundle read before rephrasing domain terms.
- If the source docs use shared or cross-initiative language that is not obviously local to the initiative, use `agent-issues context search <query> --json` before you coin or migrate a term.
- If the source docs appear to redefine an existing term, run `agent-issues context conflicts --json` so you can either preserve the established label or call out the collision explicitly.
- If the initiative context does not exist yet and the source docs define shared language, initialize it with `agent-issues context set --scope <initiativeId|default> --title ... --summary ... --json`.
- Persist canonical terms immediately with `agent-issues context define <term> --scope <initiativeId|default> --definition ... [--avoid ...] --json`.
- Do not leave glossary truth in a raw `CONTEXT.md` alone.

### 3. Map source docs to tracked entities

- Initiative or roadmap doc: create or reuse one `initiative`.
- PRD or feature spec: create or reuse one `prd` under the initiative.
- Numbered user commitments inside a PRD: create one `userStory` child per committed story.
- ADR or architecture decision doc: create or reuse one `adr` under the initiative.
- Task list, implementation checklist, or backlog doc: create one `issue` per independently grabbable slice.
- Glossary, terminology, or domain-language notes: migrate into initiative-scoped context records.

If one document mixes multiple concerns, split it into the smallest set of tracked records that preserves the original intent.

### 4. Publish records in dependency order

1. Create or reuse the parent initiative.
2. Migrate glossary and context terms.
3. Create or reuse PRDs with their migrated markdown in the body: `agent-issues create prd --title ... --parent INITx --body-file "$prdBodyFile" --json`. If reusing an existing PRD, update it with `agent-issues edit PRDx --body-file "$prdBodyFile" --json`.
4. Create the PRD's user stories with `agent-issues create userStory --title ... --parent PRDx --body-file "$userStoryBodyFile" --json`. Preserve the full committed story text in the body even if the title is shorter. If reusing a story, update it with `agent-issues edit USx --body-file "$userStoryBodyFile" --json`.
5. Create or reuse ADRs with their decision prose in the body: `agent-issues create adr --title ... --parent INITx --body-file "$adrBodyFile" --json`. If reusing an ADR, update it with `agent-issues edit ADRx --body-file "$adrBodyFile" --json`.
6. Create issues with their migrated implementation prose in the body: `agent-issues create issue --title ... --parent INITx --body-file "$issueBodyFile" --json`. If reusing an issue, update it with `agent-issues edit ISSx --body-file "$issueBodyFile" --json`.
7. Link issues to user stories with `agent-issues link ISSx fixes USy`.
8. Link ADR constraints with `agent-issues link ADRx constrains ISSy` when a decision clearly governs implementation work.
9. Link issue dependencies with `agent-issues link BLOCKER_ISS blocks BLOCKED_ISS`.

Publish blockers before blocked issues so every relationship points at a real record.

When migrating markdown docs, store the source prose in the record body rather than collapsing it into a title. Drop only the duplicated top-level heading when the record title already captures it. Prefer `--body-file` for these migrations so multiline markdown lands exactly as written.

### 5. Handle gaps and ambiguities carefully

- Do not create placeholder records for claims the source docs do not support.
- When the source material is stale or contradictory, migrate only the parts you can defend and call out the unresolved pieces explicitly.
- If a source task list is too coarse, break it into thin vertical slices before creating issues.
- If a doc appears to describe an existing record with a different title, prefer reusing the existing record and report the mapping instead of duplicating it.

### 6. Return a migration report

Return a concise report that includes:

- each source document that was processed
- every created or reused initiative, PRD, user story, ADR, and issue ID
- the links that were added
- any source material that was skipped, merged, or left unresolved

Do not treat the migration as complete until the local `agent-issues` graph reflects the source material.