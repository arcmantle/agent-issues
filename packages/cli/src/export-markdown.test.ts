import { afterEach, describe, expect, it } from "vitest";

import { renderInitiativeMarkdownExport, renderProjectMarkdownExport } from "./export-markdown.js";
import {
	createEntity,
	defineContextTerm,
	ensureDatabase,
	getDatabaseSnapshot,
	getInitiativeBundle,
	linkEntities,
	SqliteStore,
	upsertContext
} from "@agent-issues/api-local";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tempDir: string | null = null;

async function openTestDatabase() {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-export-"));
	return (await ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" })).executor;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("markdown export", () => {
	it("renders initiative export with frontmatter connections and sections", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse Records", body: "PRD body" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "Inspect Record", body: "Story body" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail view", body: "Issue body" });
		linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });
		const handoff = createEntity(db, { kind: "handoff", title: "Resume here", body: "Continue from the failing test." });
		linkEntities(db, { fromId: handoff.id, toId: issue.id, relationType: "handsOff" });
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
		expect(markdown).toContain(`### ${handoff.id} Resume here`);
		expect(markdown).toContain(`from: \"${handoff.id}\"`);
		expect(markdown).toContain(`to: \"${issue.id}\"`);
		expect(markdown).toContain("Continue from the failing test.");
	});

	it("renders a full issue conversation with creator resolution and deleted placeholders", async () => {
		const db = await openTestDatabase();
		const store = new SqliteStore(db);
		const initiative = await store.createEntity({ kind: "initiative", title: "Conversation export" });
		const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Export comments" });
		const activeComment = await store.createIssueComment({
			issueId: issue.id,
			body: "This comment remains visible.",
			referencedIssueIds: [issue.id]
		});
		const deletedComment = await store.createIssueComment({
			issueId: issue.id,
			body: "This comment is deleted."
		});
		await store.deleteIssueComment({
			commentId: deletedComment.reference,
			expectedRevision: deletedComment.revision,
			expectedContentHash: deletedComment.contentHash
		});

		const bundle = await store.getInitiativeBundle(initiative.id);
		const snapshot = await store.getDatabaseSnapshot();
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === initiative.id)!;
		const markdown = renderInitiativeMarkdownExport({
			bundle,
			commentsByIssueId: {
				[issue.id]: (await store.listIssueComments({ issueId: issue.id, all: true })).comments
			},
			context,
			relations: snapshot.relations,
			users: snapshot.users
		});

		expect(markdown).toContain("#### Conversation");
		expect(markdown).toContain(activeComment.reference);
		expect(markdown).toContain("This comment remains visible.");
		expect(markdown).toContain(`References: ${issue.id}`);
		expect(markdown).toContain(`Created by: ${snapshot.users.find((user) => user.id === activeComment.createdBy)?.displayName}`);
		expect(markdown).toContain(deletedComment.reference);
		expect(markdown).toContain("Deleted comment");
	});

	it("renders project export with project frontmatter and nested initiative exports", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail view" });
		const adr = createEntity(db, { kind: "adr", title: "Use SVG graphs" });
		const orphanIssue = createEntity(db, { kind: "issue", title: "Loose end" });
		linkEntities(db, { fromId: initiative.id, toId: issue.id, relationType: "tracks" });
		const handoff = createEntity(db, { kind: "handoff", title: "Resume project export.", body: "Resume project export." });
		linkEntities(db, { fromId: handoff.id, toId: issue.id, relationType: "handsOff" });
		upsertContext(db, { title: "Shared Context", summary: "Project-wide terminology." });
		defineContextTerm(db, { term: "Rail", definition: "Primary navigation band." });

		const markdown = renderProjectMarkdownExport({
			snapshot: getDatabaseSnapshot(db)
		});

		expect(markdown).toContain("type: \"project-export\"");
		expect(markdown).toContain("# Project Export");
		expect(markdown).toContain("## Entities");
		expect(markdown).toContain(adr.id);
		expect(markdown).toContain(orphanIssue.id);
		expect(markdown).toContain(handoff.id);
		expect(markdown).toContain(`## ${initiative.id} Console Viewer`);
	});
});