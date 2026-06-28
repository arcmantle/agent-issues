import { afterEach, describe, expect, it } from "vitest";

import { defineContextTerm, upsertContext } from "./context-store.js";
import { ensureDatabase } from "./database.js";
import { renderInitiativeMarkdownExport, renderProjectMarkdownExport } from "./export-markdown.js";
import { createEntity, createHandoff, getDatabaseSnapshot, getInitiativeBundle, linkEntities, listHandoffs } from "./store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tempDir: string | null = null;

function openTestDatabase() {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-export-"));
	return ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" }).db;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("markdown export", () => {
	it("renders initiative export with frontmatter connections and sections", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse Records", body: "PRD body" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "Inspect Record", body: "Story body" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail view", body: "Issue body" });
		linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });
		createHandoff(db, { entityId: issue.id, summary: "Resume here", body: "Continue from the failing test." });
		upsertContext(db, { scopeRef: initiative.id, title: "Viewer Context", summary: "Shared language for the viewer." });
		defineContextTerm(db, { scopeRef: initiative.id, term: "Record Rail", definition: "The fixed navigation lane." });

		const bundle = getInitiativeBundle(db, initiative.id);
		const snapshot = getDatabaseSnapshot(db);
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === initiative.id);
		const markdown = renderInitiativeMarkdownExport({
			bundle,
			context: context!,
			relations: snapshot.relations
		});

		expect(markdown).toContain("type: \"initiative-export\"");
		expect(markdown).toContain(`id: \"${initiative.id}\"`);
		expect(markdown).toContain(`from: \"${issue.id}\"`);
		expect(markdown).toContain(`to: \"${story.id}\"`);
		expect(markdown).toContain(`# ${initiative.id} Console Viewer`);
		expect(markdown).toContain("## Context");
		expect(markdown).toContain("Record Rail: The fixed navigation lane.");
		expect(markdown).toContain("## Handoffs");
		expect(markdown).toContain("Continue from the failing test.");
	});

	it("renders project export with project frontmatter and nested initiative exports", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail view" });
		const adr = createEntity(db, { kind: "adr", title: "Use SVG graphs" });
		const orphanIssue = createEntity(db, { kind: "issue", title: "Loose end" });
		linkEntities(db, { fromId: initiative.id, toId: issue.id, relationType: "tracks" });
		createHandoff(db, { entityId: issue.id, body: "Resume project export." });
		upsertContext(db, { title: "Shared Context", summary: "Project-wide terminology." });
		defineContextTerm(db, { term: "Rail", definition: "Primary navigation band." });

		const markdown = renderProjectMarkdownExport({
			snapshot: getDatabaseSnapshot(db),
			handoffs: listHandoffs(db)
		});

		expect(markdown).toContain("type: \"project-export\"");
		expect(markdown).toContain("# Project Export");
		expect(markdown).toContain("## Project ADRs");
		expect(markdown).toContain(adr.id);
		expect(markdown).toContain("## Orphans");
		expect(markdown).toContain(orphanIssue.id);
		expect(markdown).toContain("## Handoffs");
		expect(markdown).toContain("Resume project export.");
		expect(markdown).toContain(`## ${initiative.id} Console Viewer`);
	});
});