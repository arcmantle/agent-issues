import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDatabase, type DatabaseHandle } from "./database.js";
import { createEntity, createHandoff, deleteHandoff, getDatabaseSnapshot, getEntityDetails, getHandoffDetails, getInitiativeBundle, linkEntities, listEntities, listHandoffs, listOrphans, setEntityBody, updateEntityStatus, updateHandoff } from "./store.js";

function statusOf(db: DatabaseHandle, entityId: string): string {
	return getEntityDetails(db, entityId).entity.status;
}

let tempDir: string | null = null;

function openTestDatabase(): DatabaseHandle {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-store-"));
	const { db } = ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
	return db;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("project-scoped ADRs", () => {
	it("exposes a parentless ADR as a project-scoped ADR in the snapshot", () => {
		const db = openTestDatabase();
		const adr = createEntity(db, { kind: "adr", title: "Use deterministic SVG graphs" });

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.projectAdrs.map((entity) => entity.id)).toContain(adr.id);
	});

	it("keeps project-scoped ADRs out of the orphan list", () => {
		const db = openTestDatabase();
		const adr = createEntity(db, { kind: "adr", title: "Use deterministic SVG graphs" });

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.orphans.map((entity) => entity.id)).not.toContain(adr.id);
		expect(listOrphans(db).map((entity) => entity.id)).not.toContain(adr.id);
	});

	it("does not treat an initiative-recorded ADR as project-scoped", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const recordedAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Adopt signals" });

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.projectAdrs.map((entity) => entity.id)).not.toContain(recordedAdr.id);
	});
});

describe("record bodies", () => {
	it("persists and returns the authored body when creating an entity", () => {
		const db = openTestDatabase();
		const issue = createEntity(db, {
			kind: "issue",
			title: "Add body column",
			body: "# Heading\n\nSome **authored** markdown."
		});

		expect(issue.body).toBe("# Heading\n\nSome **authored** markdown.");
		expect(issue.bodySource).toBe("authored");

		const reloaded = getEntityDetails(db, issue.id);
		expect(reloaded.entity.body).toBe("# Heading\n\nSome **authored** markdown.");
		expect(reloaded.entity.bodySource).toBe("authored");
	});

	it("defaults the body to an empty string when none is provided", () => {
		const db = openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "No body" });

		expect(issue.body).toBe("");
		expect(issue.bodySource).toBe("authored");
	});

	it("updates the authored body of an existing entity", () => {
		const db = openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Editable" });

		const updated = setEntityBody(db, { entityId: issue.id, body: "## Rewritten body" });

		expect(updated.body).toBe("## Rewritten body");
		expect(updated.bodySource).toBe("authored");
		expect(getEntityDetails(db, issue.id).entity.body).toBe("## Rewritten body");
		expect(getEntityDetails(db, issue.id).entity.bodySource).toBe("authored");
	});

	it("clears the authored body when set to an empty string", () => {
		const db = openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Clearable", body: "Original body" });

		const cleared = setEntityBody(db, { entityId: issue.id, body: "" });

		expect(cleared.body).toBe("");
		expect(cleared.bodySource).toBe("authored");
		expect(getEntityDetails(db, issue.id).entity.body).toBe("");
		expect(getEntityDetails(db, issue.id).entity.bodySource).toBe("authored");
	});
});

describe("derived user story status", () => {
	function seedStoryWithIssues(db: DatabaseHandle, issueStatuses: string[]) {
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });

		const issues = issueStatuses.map((status, index) => {
			const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: `Slice ${index + 1}` });
			linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });
			if (status !== "todo") {
				updateEntityStatus(db, { entityId: issue.id, status });
			}
			return issue;
		});

		return { initiative, prd, story, issues };
	}

	it("derives done when every fixing issue is done", () => {
		const db = openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["done", "done"]);

		expect(statusOf(db, story.id)).toBe("done");
	});

	it("derives in-progress when some but not all fixing issues are done", () => {
		const db = openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["done", "todo"]);

		expect(statusOf(db, story.id)).toBe("in-progress");
	});

	it("derives ready when fixing issues exist but none have started", () => {
		const db = openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["todo", "todo"]);

		expect(statusOf(db, story.id)).toBe("ready");
	});

	it("keeps the stored status when the story has no fixing issues", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "Unlinked", status: "ready" });

		expect(statusOf(db, story.id)).toBe("ready");
	});

	it("surfaces the derived status in the snapshot, list, and initiative bundle", () => {
		const db = openTestDatabase();
		const { initiative, story } = seedStoryWithIssues(db, ["done", "done"]);

		const snapshot = getDatabaseSnapshot(db);
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.status).toBe("done");

		const listed = listEntities(db, "userStory").find((entity) => entity.id === story.id);
		expect(listed?.status).toBe("done");

		const bundle = getInitiativeBundle(db, initiative.id);
		expect(bundle.userStories.find((entity) => entity.id === story.id)?.status).toBe("done");
	});

	it("rejects manually setting the status of a story that has fixing issues", () => {
		const db = openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: story.id, status: "done" })).toThrow(/derived/i);
	});
});

describe("derived initiative status", () => {
	it("derives done when every tracked issue is done and every owned PRD is approved", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		updateEntityStatus(db, { entityId: prd.id, status: "approved" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		updateEntityStatus(db, { entityId: issue.id, status: "done" });

		expect(statusOf(db, initiative.id)).toBe("done");
	});
	it("keeps the stored status while tracked issues remain open", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", status: "active" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		updateEntityStatus(db, { entityId: issue.id, status: "in-progress" });

		expect(statusOf(db, initiative.id)).toBe("active");
	});

	it("rejects manually marking an initiative done while tracked issues remain open", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });

		expect(() => updateEntityStatus(db, { entityId: initiative.id, status: "done" })).toThrow(/tracked issues/i);
	});
});

describe("derived PRD status cascade", () => {
	function seedPrdWithStory(db: DatabaseHandle, fixingIssueStatuses: string[]) {
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		fixingIssueStatuses.forEach((status, index) => {
			const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: `Slice ${index + 1}` });
			linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });
			if (status !== "todo") {
				updateEntityStatus(db, { entityId: issue.id, status });
			}
		});
		return { initiative, prd, story };
	}

	it("derives approved when every created story is done", () => {
		const db = openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["done"]);

		expect(statusOf(db, prd.id)).toBe("approved");
	});

	it("derives in-progress when a created story is in progress", () => {
		const db = openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["in-progress"]);

		expect(statusOf(db, prd.id)).toBe("in-progress");
	});

	it("keeps the stored status while created stories exist but none have started", () => {
		const db = openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["todo"]);

		expect(statusOf(db, prd.id)).toBe("draft");
	});

	it("keeps the stored status when the PRD has no created stories", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Empty", status: "in-progress" });

		expect(statusOf(db, prd.id)).toBe("in-progress");
	});

	it("rejects manually setting any status on a PRD that has created stories", () => {
		const db = openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: prd.id, status: "approved" })).toThrow(/derived/i);
		expect(() => updateEntityStatus(db, { entityId: prd.id, status: "in-progress" })).toThrow(/derived/i);
	});

	it("cascades issue completion up to the initiative through stories and PRDs", () => {
		const db = openTestDatabase();
		const { initiative, prd, story } = seedPrdWithStory(db, ["done", "done"]);

		expect(statusOf(db, story.id)).toBe("done");
		expect(statusOf(db, prd.id)).toBe("approved");
		expect(statusOf(db, initiative.id)).toBe("done");
	});
});

describe("derived ADR status", () => {
	function seedAdrConstrainingIssues(db: DatabaseHandle, issueStatuses: string[]) {
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const adr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Use SQLite" });
		const issues = issueStatuses.map((status, index) => {
			const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: `Slice ${index + 1}` });
			linkEntities(db, { fromId: adr.id, toId: issue.id, relationType: "constrains" });
			if (status !== "todo") {
				updateEntityStatus(db, { entityId: issue.id, status });
			}
			return issue;
		});
		return { initiative, adr, issues };
	}

	it("derives accepted when a constrained issue is in progress", () => {
		const db = openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["in-progress"]);

		expect(statusOf(db, adr.id)).toBe("accepted");
	});

	it("derives accepted when a constrained issue is done", () => {
		const db = openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["done"]);

		expect(statusOf(db, adr.id)).toBe("accepted");
	});

	it("keeps the stored status while constrained issues exist but none have started", () => {
		const db = openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["todo"]);

		expect(statusOf(db, adr.id)).toBe("proposed");
	});

	it("keeps the stored status when the ADR constrains no issues", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const adr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Standalone", status: "accepted" });

		expect(statusOf(db, adr.id)).toBe("accepted");
	});

	it("derives superseded when another ADR supersedes it", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const oldAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Old decision", status: "accepted" });
		const newAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "New decision" });
		linkEntities(db, { fromId: newAdr.id, toId: oldAdr.id, relationType: "supersedes" });

		expect(statusOf(db, oldAdr.id)).toBe("superseded");
	});

	it("rejects manually setting the status of an ADR that constrains issues", () => {
		const db = openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: adr.id, status: "accepted" })).toThrow(/derived/i);
	});

	it("rejects manually setting the status of an ADR that has been superseded", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const oldAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Old decision", status: "accepted" });
		const newAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "New decision" });
		linkEntities(db, { fromId: newAdr.id, toId: oldAdr.id, relationType: "supersedes" });

		expect(() => updateEntityStatus(db, { entityId: oldAdr.id, status: "proposed" })).toThrow(/superseded/i);
	});
});

describe("handoffs", () => {
	it("persists a handoff anchored to the focus entity and its owning initiative", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Add handoff persistence" });

		const handoff = createHandoff(db, {
			entityId: issue.id,
			summary: "Paused mid-refactor",
			body: "## State\n\nStore layer done, UI pending."
		});

		expect(handoff.id).toMatch(/^HO\d+$/);
		expect(handoff.entityId).toBe(issue.id);
		expect(handoff.initiativeId).toBe(initiative.id);
		expect(handoff.summary).toBe("Paused mid-refactor");
		expect(handoff.body).toBe("## State\n\nStore layer done, UI pending.");
	});

	it("resolves the owning initiative when the focus is the initiative itself", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });

		const handoff = createHandoff(db, { entityId: initiative.id, body: "Initiative-level handoff." });

		expect(handoff.initiativeId).toBe(initiative.id);
	});

	it("rejects an empty handoff body", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });

		expect(() => createHandoff(db, { entityId: initiative.id, body: "   " })).toThrow(/body/i);
	});

	it("lists handoffs for an initiative newest first", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const first = createHandoff(db, { entityId: initiative.id, body: "First handoff." });
		const second = createHandoff(db, { entityId: initiative.id, body: "Second handoff." });

		const listed = listHandoffs(db, { initiativeId: initiative.id });

		expect(listed.map((handoff) => handoff.id)).toEqual([second.id, first.id]);
	});

	it("updates an existing handoff body and summary", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const handoff = createHandoff(db, {
			entityId: initiative.id,
			summary: "Paused mid-refactor",
			body: "Initial draft."
		});

		const updated = updateHandoff(db, {
			handoffId: handoff.id,
			summary: "Ready for pickup",
			body: "Updated draft."
		});

		expect(updated.id).toBe(handoff.id);
		expect(updated.summary).toBe("Ready for pickup");
		expect(updated.body).toBe("Updated draft.");
	});

	it("allows clearing a handoff summary while preserving the current body", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const handoff = createHandoff(db, {
			entityId: initiative.id,
			summary: "Temporary summary",
			body: "Resume here."
		});

		const updated = updateHandoff(db, { handoffId: handoff.id, summary: "" });

		expect(updated.summary).toBe("");
		expect(updated.body).toBe("Resume here.");
	});

	it("rejects handoff updates that do not supply any mutable fields", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const handoff = createHandoff(db, { entityId: initiative.id, body: "Resume here." });

		expect(() => updateHandoff(db, { handoffId: handoff.id })).toThrow(/provide/i);
	});

	it("deletes a handoff by id", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const handoff = createHandoff(db, { entityId: initiative.id, body: "Resume here." });

		const removed = deleteHandoff(db, { handoffId: handoff.id });

		expect(removed.handoff.id).toBe(handoff.id);
		expect(removed.removed).toBe(true);
		expect(listHandoffs(db, { initiativeId: initiative.id })).toHaveLength(0);
	});

	it("exposes handoffs in the initiative bundle and snapshot", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		const handoff = createHandoff(db, { entityId: issue.id, body: "Resume from the failing test." });

		const bundle = getInitiativeBundle(db, initiative.id);
		expect(bundle.handoffs.map((entry) => entry.id)).toContain(handoff.id);

		const snapshot = getDatabaseSnapshot(db);
		const bundled = snapshot.initiatives.find((entry) => entry.initiative.id === initiative.id);
		expect(bundled?.handoffs.map((entry) => entry.id)).toContain(handoff.id);
	});

	it("returns saved handoffs from getHandoffDetails", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		const handoff = createHandoff(db, { entityId: issue.id, body: "Resume here." });

		const details = getHandoffDetails(db, issue.id);

		expect(details.handoffs.map((entry) => entry.id)).toContain(handoff.id);
	});
});

