import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { backfillBodies } from "./body-backfill.js";
import { ensureDatabase, type DatabaseHandle } from "./database.js";
import { createEntity, getDatabaseSnapshot, linkEntities } from "./store.js";

let tempDir: string | null = null;

function openTestDatabase(): DatabaseHandle {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backfill-"));
	const { db } = ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
	return db;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("body backfill", () => {
	it("fills empty initiative, issue, PRD, and user story bodies from tracker metadata", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });
		linkEntities(db, { fromId: issue.id, relationType: "fixes", toId: story.id });

		const result = backfillBodies(db);
		const snapshot = getDatabaseSnapshot(db);
		const reloadedInitiative = snapshot.entities.find((entity) => entity.id === initiative.id);
		const reloadedIssue = snapshot.entities.find((entity) => entity.id === issue.id);
		const reloadedPrd = snapshot.entities.find((entity) => entity.id === prd.id);
		const reloadedStory = snapshot.entities.find((entity) => entity.id === story.id);

		expect(result.updated).toBe(4);
		expect(reloadedInitiative?.body).toContain("## Product Commitments");
		expect(reloadedInitiative?.bodySource).toBe("generated");
		expect(reloadedInitiative?.body).toContain(prd.id);
		expect(reloadedInitiative?.body).toContain(issue.id);
		expect(reloadedIssue?.body).toContain("## User Stories");
		expect(reloadedIssue?.bodySource).toBe("generated");
		expect(reloadedIssue?.body).toContain(story.id);
		expect(reloadedPrd?.body).toContain("## User Stories");
		expect(reloadedPrd?.bodySource).toBe("generated");
		expect(reloadedPrd?.body).toContain(story.id);
		expect(reloadedPrd?.body).toContain(issue.id);
		expect(reloadedStory?.body).toContain("## Delivery Slices");
		expect(reloadedStory?.bodySource).toBe("generated");
		expect(reloadedStory?.body).toContain(issue.id);
	});

	it("does not overwrite existing bodies unless force is enabled", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, {
			kind: "issue",
			parentId: initiative.id,
			title: "Render detail pane",
			body: "Existing authored issue body."
		});

		const first = backfillBodies(db, { kinds: ["issue"] });
		let snapshot = getDatabaseSnapshot(db);
		expect(first.updated).toBe(0);
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toBe("Existing authored issue body.");

		const second = backfillBodies(db, { force: true, kinds: ["issue"] });
		snapshot = getDatabaseSnapshot(db);
		expect(second.updated).toBe(1);
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).not.toBe("Existing authored issue body.");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toContain(issue.title);
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.bodySource).toBe("generated");
	});

	it("reclassifies legacy generated bodies without overwriting authored prose", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });

		const first = backfillBodies(db, { kinds: ["issue"] });
		expect(first.updated).toBe(1);

		db.prepare(`UPDATE entities SET body_source = 'authored' WHERE tenant_id = @tenantId AND id = @entityId`).run({
			tenantId: db.tenantId,
			entityId: issue.id
		});

		const legacySnapshot = getDatabaseSnapshot(db);
		const legacyIssue = legacySnapshot.entities.find((entity) => entity.id === issue.id);
		expect(legacyIssue?.bodySource).toBe("authored");

		const second = backfillBodies(db, { kinds: ["issue"] });
		const snapshot = getDatabaseSnapshot(db);
		expect(second.updated).toBe(1);
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.bodySource).toBe("generated");
	});

	it("supports filtering by kind", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });
		linkEntities(db, { fromId: issue.id, relationType: "fixes", toId: story.id });

		const result = backfillBodies(db, { kinds: ["userStory"] });
		const snapshot = getDatabaseSnapshot(db);

		expect(result.updated).toBe(1);
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.body).toContain(story.title);
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.bodySource).toBe("generated");
		expect(snapshot.entities.find((entity) => entity.id === prd.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toBe("");
	});

	it("supports filtering initiative backfills by kind", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });

		const result = backfillBodies(db, { kinds: ["initiative"] });
		const snapshot = getDatabaseSnapshot(db);

		expect(result.updated).toBe(1);
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.body).toContain("## Implementation Slices");
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.body).toContain(prd.id);
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.body).toContain(issue.id);
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.bodySource).toBe("generated");
		expect(snapshot.entities.find((entity) => entity.id === prd.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toBe("");
	});

	it("backfills ADR bodies from constrained work and supersession links", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const olderAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Use HTML templates" });
		const adr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Use deterministic SVG graphs" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship the graph" });
		linkEntities(db, { fromId: adr.id, relationType: "constrains", toId: issue.id });
		linkEntities(db, { fromId: adr.id, relationType: "supersedes", toId: olderAdr.id });

		const result = backfillBodies(db, { kinds: ["adr"] });
		const snapshot = getDatabaseSnapshot(db);
		const reloadedAdr = snapshot.entities.find((entity) => entity.id === adr.id);

		expect(result.updated).toBe(2);
		expect(reloadedAdr?.body).toContain("## Governed Work");
		expect(reloadedAdr?.bodySource).toBe("generated");
		expect(reloadedAdr?.body).toContain(issue.id);
		expect(reloadedAdr?.body).toContain(olderAdr.id);
	});

	it("reports updates during dry-run without mutating stored bodies", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });
		linkEntities(db, { fromId: issue.id, relationType: "fixes", toId: story.id });

		const result = backfillBodies(db, { dryRun: true });
		const snapshot = getDatabaseSnapshot(db);

		expect(result.dryRun).toBe(true);
		expect(result.updated).toBe(4);
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.bodySource).toBe("authored");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.bodySource).toBe("authored");
		expect(snapshot.entities.find((entity) => entity.id === prd.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === prd.id)?.bodySource).toBe("authored");
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.bodySource).toBe("authored");
	});
});