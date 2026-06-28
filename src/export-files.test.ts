import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defineContextTerm, upsertContext } from "./context-store.js";
import { ensureDatabase } from "./database.js";
import { writeInitiativeDirectoryExport, writeProjectDirectoryExport } from "./export-files.js";
import { createEntity, createHandoff, getDatabaseSnapshot, getInitiativeBundle, linkEntities, listHandoffs } from "./store.js";

let tempDir: string | null = null;

function openTestDatabase() {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-export-files-"));
	return ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" }).db;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("directory export", () => {
	it("writes an initiative folder grouped by entity kinds and relation types", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse Records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "Inspect Record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail view" });
		linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });
		createHandoff(db, { entityId: issue.id, summary: "Resume here", body: "Continue from the failing test." });
		upsertContext(db, { scopeRef: initiative.id, title: "Viewer Context", summary: "Shared language for the viewer." });
		defineContextTerm(db, { scopeRef: initiative.id, term: "Record Rail", definition: "The fixed navigation lane." });

		const snapshot = getDatabaseSnapshot(db);
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === initiative.id)!;
		const outputPath = path.join(tempDir!, "initiative-export");
		const result = writeInitiativeDirectoryExport({
			bundle: getInitiativeBundle(db, initiative.id),
			context,
			outputPath,
			relations: snapshot.relations
		});

		expect(result.mode).toBe("directory");
		expect(existsSync(path.join(outputPath, "initiative.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "context.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "prds", `${prd.id}.md`))).toBe(true);
		expect(existsSync(path.join(outputPath, "user-stories", `${story.id}.md`))).toBe(true);
		expect(existsSync(path.join(outputPath, "issues", `${issue.id}.md`))).toBe(true);
		expect(existsSync(path.join(outputPath, "handoffs", "HO1.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "relations", "fixes.md"))).toBe(true);
		expect(readFileSync(path.join(outputPath, "relations", "fixes.md"), "utf8")).toContain(issue.id);
		expect(readFileSync(path.join(outputPath, "issues", `${issue.id}.md`), "utf8")).toContain("outgoingConnections:");
	});

	it("writes a project folder with nested initiative exports and project groupings", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail view" });
		const adr = createEntity(db, { kind: "adr", title: "Use SVG graphs" });
		const orphanIssue = createEntity(db, { kind: "issue", title: "Loose end" });
		linkEntities(db, { fromId: initiative.id, toId: issue.id, relationType: "tracks" });
		createHandoff(db, { entityId: issue.id, body: "Resume project export." });
		upsertContext(db, { title: "Shared Context", summary: "Project-wide terminology." });
		defineContextTerm(db, { term: "Rail", definition: "Primary navigation band." });

		const outputPath = path.join(tempDir!, "project-export");
		const result = writeProjectDirectoryExport({
			snapshot: getDatabaseSnapshot(db),
			handoffs: listHandoffs(db),
			outputPath
		});

		expect(result.mode).toBe("directory");
		expect(existsSync(path.join(outputPath, "project.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "shared-context.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "project-adrs", `${adr.id}.md`))).toBe(true);
		expect(existsSync(path.join(outputPath, "orphans", `${orphanIssue.id}.md`))).toBe(true);
		expect(existsSync(path.join(outputPath, "relations", "tracks.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "initiatives", initiative.id, "initiative.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "initiatives", initiative.id, "issues", `${issue.id}.md`))).toBe(true);
		expect(readFileSync(path.join(outputPath, "project.md"), "utf8")).toContain("type: \"project-export\"");
	});

	it("rejects overwriting an existing export directory without force", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const snapshot = getDatabaseSnapshot(db);
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === initiative.id)!;
		const outputPath = path.join(tempDir!, "initiative-export");

		writeInitiativeDirectoryExport({
			bundle: getInitiativeBundle(db, initiative.id),
			context,
			outputPath,
			relations: snapshot.relations
		});

		expect(() =>
			writeInitiativeDirectoryExport({
				bundle: getInitiativeBundle(db, initiative.id),
				context,
				outputPath,
				relations: snapshot.relations
			})
		).toThrow(/--force/);
	});
});