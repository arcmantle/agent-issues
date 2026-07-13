import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDatabase, type DatabaseHandle } from "../../db/database.js";
import { createEntity, createHandoff, deleteHandoff, getDatabaseSnapshot, getEntityDetails, getHandoffDetails, getInitiativeBundle, linkEntities, listEntities, listEntityHistory, listHandoffs, listOrphans, moveEntity, setEntityBody, unlinkEntities, updateEntityStatus, updateHandoff } from "./store.js";

function statusOf(db: DatabaseHandle, entityId: string): string {
	return getEntityDetails(db, entityId).entity.status;
}

let tempDir: string | null = null;

async function openTestDatabase(): Promise<DatabaseHandle> {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-store-"));
	const { db } = await ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
	return db;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("project-scoped ADRs", () => {
	it("exposes a parentless ADR as a project-scoped ADR in the snapshot", async () => {
		const db = await openTestDatabase();
		const adr = createEntity(db, { kind: "adr", title: "Use deterministic SVG graphs" });

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.projectAdrs.map((entity) => entity.id)).toContain(adr.id);
	});

	it("keeps project-scoped ADRs out of the orphan list", async () => {
		const db = await openTestDatabase();
		const adr = createEntity(db, { kind: "adr", title: "Use deterministic SVG graphs" });

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.orphans.map((entity) => entity.id)).not.toContain(adr.id);
		expect(listOrphans(db).map((entity) => entity.id)).not.toContain(adr.id);
	});

	it("does not treat an initiative-recorded ADR as project-scoped", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const recordedAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Adopt signals" });

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.projectAdrs.map((entity) => entity.id)).not.toContain(recordedAdr.id);
	});
});

describe("record bodies", () => {
	it("persists and returns the authored body when creating an entity", async () => {
		const db = await openTestDatabase();
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

	it("defaults the body to an empty string when none is provided", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "No body" });

		expect(issue.body).toBe("");
		expect(issue.bodySource).toBe("authored");
	});

	it("updates the authored body of an existing entity", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Editable" });

		const updated = setEntityBody(db, { entityId: issue.id, body: "## Rewritten body" });

		expect(updated.body).toBe("## Rewritten body");
		expect(updated.bodySource).toBe("authored");
		expect(getEntityDetails(db, issue.id).entity.body).toBe("## Rewritten body");
		expect(getEntityDetails(db, issue.id).entity.bodySource).toBe("authored");
	});

	it("clears the authored body when set to an empty string", async () => {
		const db = await openTestDatabase();
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

	it("derives done when every fixing issue is done", async () => {
		const db = await openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["done", "done"]);

		expect(statusOf(db, story.id)).toBe("done");
	});

	it("derives in-progress when some but not all fixing issues are done", async () => {
		const db = await openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["done", "todo"]);

		expect(statusOf(db, story.id)).toBe("in-progress");
	});

	it("derives ready when fixing issues exist but none have started", async () => {
		const db = await openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["todo", "todo"]);

		expect(statusOf(db, story.id)).toBe("ready");
	});

	it("keeps the stored status when the story has no fixing issues", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "Unlinked", status: "ready" });

		expect(statusOf(db, story.id)).toBe("ready");
	});

	it("surfaces the derived status in the snapshot, list, and initiative bundle", async () => {
		const db = await openTestDatabase();
		const { initiative, story } = seedStoryWithIssues(db, ["done", "done"]);

		const snapshot = getDatabaseSnapshot(db);
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.status).toBe("done");

		const listed = listEntities(db, "userStory").find((entity) => entity.id === story.id);
		expect(listed?.status).toBe("done");

		const bundle = getInitiativeBundle(db, initiative.id);
		expect(bundle.userStories.find((entity) => entity.id === story.id)?.status).toBe("done");
	});

	it("rejects manually setting the status of a story that has fixing issues", async () => {
		const db = await openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: story.id, status: "done" })).toThrow(/derived/i);
	});
});

describe("derived initiative status", () => {
	it("derives done when every tracked issue is done and every owned PRD is approved", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		updateEntityStatus(db, { entityId: prd.id, status: "approved" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		updateEntityStatus(db, { entityId: issue.id, status: "done" });

		expect(statusOf(db, initiative.id)).toBe("done");
	});
	it("keeps the stored status while tracked issues remain open", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", status: "active" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		updateEntityStatus(db, { entityId: issue.id, status: "in-progress" });

		expect(statusOf(db, initiative.id)).toBe("active");
	});

	it("promotes a draft initiative to active once a tracked issue starts", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		expect(statusOf(db, initiative.id)).toBe("draft");

		updateEntityStatus(db, { entityId: issue.id, status: "in-progress" });

		expect(statusOf(db, initiative.id)).toBe("active");
	});

	it("promotes a draft initiative to active once an owned PRD starts", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });

		updateEntityStatus(db, { entityId: issue.id, status: "in-progress" });

		expect(statusOf(db, initiative.id)).toBe("active");
	});

	it("does not promote a draft initiative while its tracked issues and owned PRDs are all still untouched", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });

		expect(statusOf(db, initiative.id)).toBe("draft");
	});

	it("leaves a manually paused initiative paused even once a tracked issue starts (pausing stays a human decision)", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", status: "paused" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });

		updateEntityStatus(db, { entityId: issue.id, status: "in-progress" });

		expect(statusOf(db, initiative.id)).toBe("paused");
	});

	it("rejects manually marking an initiative done while tracked issues remain open", async () => {
		const db = await openTestDatabase();
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

	it("derives approved when every created story is done", async () => {
		const db = await openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["done"]);

		expect(statusOf(db, prd.id)).toBe("approved");
	});

	it("derives in-progress when a created story is in progress", async () => {
		const db = await openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["in-progress"]);

		expect(statusOf(db, prd.id)).toBe("in-progress");
	});

	it("keeps the stored status while created stories exist but none have started", async () => {
		const db = await openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["todo"]);

		expect(statusOf(db, prd.id)).toBe("draft");
	});

	it("keeps the stored status when the PRD has no created stories", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Empty", status: "in-progress" });

		expect(statusOf(db, prd.id)).toBe("in-progress");
	});

	it("rejects manually setting any status on a PRD that has created stories", async () => {
		const db = await openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: prd.id, status: "approved" })).toThrow(/derived/i);
		expect(() => updateEntityStatus(db, { entityId: prd.id, status: "in-progress" })).toThrow(/derived/i);
	});

	it("cascades issue completion up to the initiative through stories and PRDs", async () => {
		const db = await openTestDatabase();
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

	it("derives accepted when a constrained issue is in progress", async () => {
		const db = await openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["in-progress"]);

		expect(statusOf(db, adr.id)).toBe("accepted");
	});

	it("derives accepted when a constrained issue is done", async () => {
		const db = await openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["done"]);

		expect(statusOf(db, adr.id)).toBe("accepted");
	});

	it("keeps the stored status while constrained issues exist but none have started", async () => {
		const db = await openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["todo"]);

		expect(statusOf(db, adr.id)).toBe("proposed");
	});

	it("keeps the stored status when the ADR constrains no issues", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const adr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Standalone", status: "accepted" });

		expect(statusOf(db, adr.id)).toBe("accepted");
	});

	it("derives superseded when another ADR supersedes it", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const oldAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Old decision", status: "accepted" });
		const newAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "New decision" });
		linkEntities(db, { fromId: newAdr.id, toId: oldAdr.id, relationType: "supersedes" });

		expect(statusOf(db, oldAdr.id)).toBe("superseded");
	});

	it("rejects manually setting the status of an ADR that constrains issues", async () => {
		const db = await openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: adr.id, status: "accepted" })).toThrow(/derived/i);
	});

	it("rejects manually setting the status of an ADR that has been superseded", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const oldAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Old decision", status: "accepted" });
		const newAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "New decision" });
		linkEntities(db, { fromId: newAdr.id, toId: oldAdr.id, relationType: "supersedes" });

		expect(() => updateEntityStatus(db, { entityId: oldAdr.id, status: "proposed" })).toThrow(/superseded/i);
	});
});

describe("derived issue status from sub-issues", () => {
	function seedIssueWithSubIssues(db: DatabaseHandle, subIssueStatuses: string[]) {
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", status: "active" });
		const parentIssue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship the parent workflow" });
		const subIssues = subIssueStatuses.map((status, index) => {
			const subIssue = createEntity(db, {
				kind: "issue",
				parentId: parentIssue.id,
				title: `Sub-issue ${index + 1}`
			});

			if (status !== "todo") {
				updateEntityStatus(db, { entityId: subIssue.id, status });
			}

			return subIssue;
		});

		return { initiative, parentIssue, subIssues };
	}

	it("derives blocked while any sub-issue remains open", async () => {
		const db = await openTestDatabase();
		const { parentIssue } = seedIssueWithSubIssues(db, ["done", "todo"]);

		expect(statusOf(db, parentIssue.id)).toBe("blocked");
	});

	it("returns to todo once every sub-issue is done", async () => {
		const db = await openTestDatabase();
		const { parentIssue } = seedIssueWithSubIssues(db, ["done", "done"]);

		expect(statusOf(db, parentIssue.id)).toBe("todo");
	});

	it("counts nested issues when deriving initiative completion", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", status: "active" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const parentIssue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship parent issue" });
		const subIssue = createEntity(db, { kind: "issue", parentId: parentIssue.id, title: "Ship sub-issue" });

		updateEntityStatus(db, { entityId: prd.id, status: "approved" });
		updateEntityStatus(db, { entityId: subIssue.id, status: "done" });

		expect(statusOf(db, parentIssue.id)).toBe("todo");
		expect(statusOf(db, initiative.id)).toBe("active");

		updateEntityStatus(db, { entityId: parentIssue.id, status: "done" });

		expect(statusOf(db, initiative.id)).toBe("done");
	});

	it("rejects moving a parent issue forward while sub-issues remain open", async () => {
		const db = await openTestDatabase();
		const { parentIssue } = seedIssueWithSubIssues(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: parentIssue.id, status: "in-progress" })).toThrow(/sub-issues remain open/i);
		expect(() => updateEntityStatus(db, { entityId: parentIssue.id, status: "done" })).toThrow(/sub-issues remain open/i);
	});

	it("includes nested sub-issues in the initiative bundle", async () => {
		const db = await openTestDatabase();
		const { initiative, parentIssue, subIssues } = seedIssueWithSubIssues(db, ["todo", "todo"]);

		const bundle = getInitiativeBundle(db, initiative.id);

		expect(bundle.issues.map((issue) => issue.id)).toEqual([parentIssue.id, ...subIssues.map((issue) => issue.id)].sort());
		expect(bundle.subIssueLinks).toEqual(
			subIssues.map((issue) => ({
				parent: expect.objectContaining({ id: parentIssue.id }),
				issue: expect.objectContaining({ id: issue.id })
			}))
		);
	});
});

describe("handoffs", () => {
	it("persists a handoff anchored to the focus entity and its owning initiative", async () => {
		const db = await openTestDatabase();
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

	it("resolves the owning initiative when the focus is the initiative itself", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });

		const handoff = createHandoff(db, { entityId: initiative.id, body: "Initiative-level handoff." });

		expect(handoff.initiativeId).toBe(initiative.id);
	});

	it("rejects an empty handoff body", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });

		expect(() => createHandoff(db, { entityId: initiative.id, body: "   " })).toThrow(/body/i);
	});

	it("lists handoffs for an initiative newest first", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const first = createHandoff(db, { entityId: initiative.id, body: "First handoff." });
		const second = createHandoff(db, { entityId: initiative.id, body: "Second handoff." });

		const listed = listHandoffs(db, { initiativeId: initiative.id });

		expect(listed.map((handoff) => handoff.id)).toEqual([second.id, first.id]);
	});

	it("updates an existing handoff body and summary", async () => {
		const db = await openTestDatabase();
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

	it("allows clearing a handoff summary while preserving the current body", async () => {
		const db = await openTestDatabase();
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

	it("rejects handoff updates that do not supply any mutable fields", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const handoff = createHandoff(db, { entityId: initiative.id, body: "Resume here." });

		expect(() => updateHandoff(db, { handoffId: handoff.id })).toThrow(/provide/i);
	});

	it("deletes a handoff by id", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const handoff = createHandoff(db, { entityId: initiative.id, body: "Resume here." });

		const removed = deleteHandoff(db, { handoffId: handoff.id });

		expect(removed.handoff.id).toBe(handoff.id);
		expect(removed.removed).toBe(true);
		expect(listHandoffs(db, { initiativeId: initiative.id })).toHaveLength(0);
	});

	it("exposes handoffs in the initiative bundle and snapshot", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		const handoff = createHandoff(db, { entityId: issue.id, body: "Resume from the failing test." });

		const bundle = getInitiativeBundle(db, initiative.id);
		expect(bundle.handoffs.map((entry) => entry.id)).toContain(handoff.id);

		const snapshot = getDatabaseSnapshot(db);
		const bundled = snapshot.initiatives.find((entry) => entry.initiative.id === initiative.id);
		expect(bundled?.handoffs.map((entry) => entry.id)).toContain(handoff.id);
	});

	it("returns saved handoffs from getHandoffDetails", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		const handoff = createHandoff(db, { entityId: issue.id, body: "Resume here." });

		const details = getHandoffDetails(db, issue.id);

		expect(details.handoffs.map((entry) => entry.id)).toContain(handoff.id);
	});
});

describe("project and epic tiers", () => {
	it("attaches a parentless initiative to the tenant's default project and epic", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments platform" });

		const initiativeDetails = getEntityDetails(db, initiative.id);
		const epicParent = initiativeDetails.incoming.find((entry) => entry.relationType === "contains");
		expect(epicParent?.entity.id).toBe("EPIC0");
		expect(epicParent?.entity.kind).toBe("epic");

		const epicDetails = getEntityDetails(db, "EPIC0");
		const projectParent = epicDetails.incoming.find((entry) => entry.relationType === "contains");
		expect(projectParent?.entity.id).toBe("PROJ0");
		expect(projectParent?.entity.kind).toBe("project");
	});

	it("creates an explicit project -> epic -> initiative chain through the generic create path", async () => {
		const db = await openTestDatabase();
		const project = createEntity(db, { kind: "project", title: "Platform" });
		const epic = createEntity(db, { kind: "epic", title: "Checkout revamp", parentId: project.id });
		const initiative = createEntity(db, { kind: "initiative", title: "Checkout redesign", parentId: epic.id });

		const epicDetails = getEntityDetails(db, epic.id);
		const projectParent = epicDetails.incoming.find((entry) => entry.relationType === "contains");
		expect(projectParent?.entity.id).toBe(project.id);
		expect(projectParent?.entity.kind).toBe("project");

		const initiativeDetails = getEntityDetails(db, initiative.id);
		const epicParent = initiativeDetails.incoming.find((entry) => entry.relationType === "contains");
		expect(epicParent?.entity.id).toBe(epic.id);
		expect(epicParent?.entity.kind).toBe("epic");
	});

	it("moves an initiative from one epic to another", async () => {
		const db = await openTestDatabase();
		const sourceEpic = createEntity(db, { kind: "epic", title: "Source epic", parentId: "PROJ0" });
		const targetEpic = createEntity(db, { kind: "epic", title: "Target epic", parentId: "PROJ0" });
		const initiative = createEntity(db, { kind: "initiative", title: "Nomadic initiative", parentId: sourceEpic.id });

		const result = moveEntity(db, { entityId: initiative.id, newParentId: targetEpic.id });
		expect(result.previousParentId).toBe(sourceEpic.id);
		expect(result.newParentId).toBe(targetEpic.id);
		expect(result.relationType).toBe("contains");

		const details = getEntityDetails(db, initiative.id);
		const epicParent = details.incoming.find((entry) => entry.relationType === "contains");
		expect(epicParent?.entity.id).toBe(targetEpic.id);
	});

	it("blocks unlinking an initiative's sole remaining epic parent", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Anchored initiative" });

		expect(() => unlinkEntities(db, { fromId: "EPIC0", toId: initiative.id, relationType: "contains" })).toThrow(
			/only remaining structural parent/
		);

		const details = getEntityDetails(db, initiative.id);
		expect(details.incoming.some((entry) => entry.relationType === "contains" && entry.entity.id === "EPIC0")).toBe(true);
	});

	it("blocks unlinking an epic's sole remaining project parent", async () => {
		const db = await openTestDatabase();

		expect(() => unlinkEntities(db, { fromId: "PROJ0", toId: "EPIC0", relationType: "contains" })).toThrow(
			/only remaining structural parent/
		);

		const details = getEntityDetails(db, "EPIC0");
		expect(details.incoming.some((entry) => entry.relationType === "contains" && entry.entity.id === "PROJ0")).toBe(true);
	});

	it("never lists the default project or epic as orphans", async () => {
		const db = await openTestDatabase();

		const orphanIds = listOrphans(db).map((entity) => entity.id);
		expect(orphanIds).not.toContain("PROJ0");
		expect(orphanIds).not.toContain("EPIC0");
	});
});

describe("version as first-class entity", () => {
	it("creates a version entity with its own id prefix and status flow", async () => {
		const db = await openTestDatabase();
		const version = createEntity(db, { kind: "version", title: "2.0" });

		expect(version.id).toMatch(/^VER\d+$/);
		expect(version.kind).toBe("version");
		expect(version.status).toBe("draft");
	});

	it("scopes a version under a project via the owns relation, and can move it to another project", async () => {
		const db = await openTestDatabase();
		const project = createEntity(db, { kind: "project", title: "Platform" });
		const otherProject = createEntity(db, { kind: "project", title: "Other platform" });
		const version = createEntity(db, { kind: "version", title: "2.0", parentId: project.id });

		const versionDetails = getEntityDetails(db, version.id);
		const projectParent = versionDetails.incoming.find((entry) => entry.relationType === "owns");
		expect(projectParent?.entity.id).toBe(project.id);

		const moveResult = moveEntity(db, { entityId: version.id, newParentId: otherProject.id });
		expect(moveResult.previousParentId).toBe(project.id);
		expect(moveResult.newParentId).toBe(otherProject.id);
		expect(moveResult.relationType).toBe("owns");
	});

	it("tags an initiative with a version, and allows multiple initiatives to tag the same version", async () => {
		const db = await openTestDatabase();
		const version = createEntity(db, { kind: "version", title: "2.0" });
		const initiativeA = createEntity(db, { kind: "initiative", title: "Payments" });
		const initiativeB = createEntity(db, { kind: "initiative", title: "Billing" });

		linkEntities(db, { fromId: initiativeA.id, toId: version.id, relationType: "taggedWith" });
		linkEntities(db, { fromId: initiativeB.id, toId: version.id, relationType: "taggedWith" });

		const versionDetails = getEntityDetails(db, version.id);
		const taggers = versionDetails.incoming
			.filter((entry) => entry.relationType === "taggedWith")
			.map((entry) => entry.entity.id);
		expect(taggers.sort()).toEqual([initiativeA.id, initiativeB.id].sort());
	});

	it("tags an issue with a version", async () => {
		const db = await openTestDatabase();
		const version = createEntity(db, { kind: "version", title: "2.0" });
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });
		const issue = createEntity(db, { kind: "issue", title: "Fix bug", parentId: initiative.id });

		linkEntities(db, { fromId: issue.id, toId: version.id, relationType: "taggedWith" });

		const versionDetails = getEntityDetails(db, version.id);
		const tagger = versionDetails.incoming.find((entry) => entry.relationType === "taggedWith");
		expect(tagger?.entity.id).toBe(issue.id);
	});

	it("allows cross-version supersedes between initiatives, and rejects a cycle", async () => {
		const db = await openTestDatabase();
		const initiativeA = createEntity(db, { kind: "initiative", title: "Payments v1" });
		const initiativeB = createEntity(db, { kind: "initiative", title: "Payments v2" });

		linkEntities(db, { fromId: initiativeB.id, toId: initiativeA.id, relationType: "supersedes" });

		expect(() => linkEntities(db, { fromId: initiativeA.id, toId: initiativeB.id, relationType: "supersedes" })).toThrow(
			"would create a cycle"
		);
	});

	it("surfaces an untagged version as an orphan, but excludes versions reachable via tagging", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });
		const issue = createEntity(db, { kind: "issue", title: "Fix bug", parentId: initiative.id });

		const untaggedVersion = createEntity(db, { kind: "version", title: "Untagged" });
		const versionTaggedToInitiative = createEntity(db, { kind: "version", title: "Tagged to initiative" });
		const versionTaggedToIssue = createEntity(db, { kind: "version", title: "Tagged to issue" });

		linkEntities(db, { fromId: initiative.id, toId: versionTaggedToInitiative.id, relationType: "taggedWith" });
		linkEntities(db, { fromId: issue.id, toId: versionTaggedToIssue.id, relationType: "taggedWith" });

		const orphanVersionIds = listOrphans(db, "version").map((entity) => entity.id);
		expect(orphanVersionIds).toEqual([untaggedVersion.id]);
	});
});

describe("append-only history", () => {
	it("appends a version-1 history entry with a globally-unique id when an entity is created", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		const history = listEntityHistory(db, initiative.id);
		expect(history).toHaveLength(1);
		expect(history[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(history[0]).toMatchObject({
			version: 1,
			author: "system",
			title: "Payments",
			status: "draft",
			parentId: "EPIC0"
		});
	});

	it("captures an explicit author instead of the reserved system default", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments", author: "kris" });

		const history = listEntityHistory(db, initiative.id);
		expect(history[0]?.author).toBe("kris");
	});

	it("appends a new history version when an entity's status changes, carrying forward its other facts", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Fix bug" });

		updateEntityStatus(db, { entityId: issue.id, status: "in-progress", author: "kris" });

		const history = listEntityHistory(db, issue.id);
		expect(history).toHaveLength(2);
		expect(history[0]).toMatchObject({ version: 1, status: "todo", author: "system" });
		expect(history[1]).toMatchObject({ version: 2, status: "in-progress", author: "kris", title: "Fix bug" });
		expect(history[0]?.id).not.toBe(history[1]?.id);
	});

	it("appends a new history version when an entity's body changes", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Fix bug" });

		setEntityBody(db, { entityId: issue.id, body: "Repro steps here.", author: "kris" });

		const history = listEntityHistory(db, issue.id);
		expect(history).toHaveLength(2);
		expect(history[1]).toMatchObject({ version: 2, body: "Repro steps here.", bodySource: "authored", author: "kris" });
	});

	it("appends a new history version capturing the new parent when an entity is moved, but not on a no-op move", async () => {
		const db = await openTestDatabase();
		const projectA = createEntity(db, { kind: "project", title: "Project A" });
		const projectB = createEntity(db, { kind: "project", title: "Project B" });
		const version = createEntity(db, { kind: "version", title: "2.0", parentId: projectA.id });

		moveEntity(db, { entityId: version.id, newParentId: projectB.id, author: "kris" });

		const history = listEntityHistory(db, version.id);
		expect(history).toHaveLength(2);
		expect(history[0]).toMatchObject({ version: 1, parentId: projectA.id });
		expect(history[1]).toMatchObject({ version: 2, parentId: projectB.id, author: "kris" });

		moveEntity(db, { entityId: version.id, newParentId: projectB.id });
		expect(listEntityHistory(db, version.id)).toHaveLength(2);
	});
});


