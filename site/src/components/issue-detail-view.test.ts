import { afterEach, describe, expect, it } from "vitest";

import "./issue-detail-view.js";
import type { ContextDetails, Entity, InitiativeBundle, Relation, Snapshot } from "../models.js";
import { AgentIssuesStore } from "../services/agent-issues-store.js";

function makeEntity(overrides: Partial<Entity> & Pick<Entity, "id">): Entity {
	return {
		body: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		kind: "issue",
		status: "todo",
		title: `Title for ${overrides.id}`,
		updatedAt: "2026-01-02T00:00:00.000Z",
		...overrides
	};
}

function makeRelation(fromId: string, type: string, toId: string): Relation {
	return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
}

function makeBundle(initiative: Entity, overrides: Partial<InitiativeBundle> = {}): InitiativeBundle {
	return {
		adrs: [],
		blockerLinks: [],
		constrainsLinks: [],
		fixLinks: [],
		handoffs: [],
		initiative,
		issues: [],
		prds: [],
		subIssueLinks: [],
		userStories: [],
		...overrides
	};
}

function makeSharedContext(): ContextDetails {
	return {
		context: {
			createdAt: null,
			exists: false,
			key: "shared",
			scopeEntityId: null,
			scopeKind: "default",
			scopeLabel: "Shared",
			summary: "",
			title: "Shared Context",
			updatedAt: null
		},
		terms: []
	};
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		contexts: { initiatives: [], shared: makeSharedContext() },
		entities: [],
		generatedAt: "2026-01-01T00:00:00.000Z",
		initiatives: [],
		orphans: [],
		projectAdrs: [],
		relations: [],
		...overrides
	};
}

function makeStore(snapshot: Snapshot): AgentIssuesStore {
	const store = new AgentIssuesStore();
	store.connected = true;
	store.snapshot.set(snapshot);
	return store;
}

async function mountDetail(store: AgentIssuesStore) {
	const view = document.createElement("agent-issues-detail-view");
	view.store = store;
	document.body.appendChild(view);
	await view.updateComplete;
	return view;
}

afterEach(() => {
	document.body.replaceChildren();
	window.location.hash = "";
});

describe("entity detail pane", () => {
	it("renders the kind label, title, id, and a status badge for the open record", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		const root = view.shadowRoot;
		expect(root?.querySelector(".ai-kind")?.textContent?.trim()).toBe("Issue");
		expect(root?.querySelector(".ai-d-title")?.textContent).toContain("Wire the detail pane");
		expect(root?.querySelector(".ai-d-title .ai-id")?.textContent?.trim()).toBe("ISS9");
		expect(root?.querySelector(".ai-d-title .badge")?.textContent?.trim()).toBe("todo");
	});

	it("uses the real status vocabulary for the title badge across record kinds", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const adr = makeEntity({ id: "ADR4", kind: "adr", status: "accepted", title: "Adopt signals" });
		const snapshot = makeSnapshot({
			entities: [initiative, adr],
			initiatives: [makeBundle(initiative, { adrs: [adr] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ADR4");
		const view = await mountDetail(store);

		const badge = view.shadowRoot?.querySelector(".ai-d-title .badge");
		expect(badge?.textContent?.trim()).toBe("accepted");
		expect(badge?.classList.contains("success")).toBe(true);
	});

	it("renders an explicitly supplied entity id without relying on the global selection", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		const view = document.createElement("agent-issues-detail-view") as HTMLElement & {
			store: AgentIssuesStore;
			entityId: string | null;
			updateComplete: Promise<unknown>;
		};
		view.store = store;
		view.entityId = "ISS9";
		document.body.appendChild(view);
		await view.updateComplete;

		const root = view.shadowRoot;
		expect(root?.querySelector(".ai-d-title")?.textContent).toContain("Wire the detail pane");
		expect(root?.querySelector(".ai-d-title .ai-id")?.textContent?.trim()).toBe("ISS9");
		expect(store.selectedId.get()).toBeNull();
	});

	it("renders derived linked-record sections grouped by relation from the record's relations", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US7", kind: "userStory", status: "draft", title: "Open any record" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "done", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, story, issue],
			initiatives: [makeBundle(initiative, { issues: [issue], userStories: [story] })],
			relations: [makeRelation("ISS9", "fixes", "US7")]
		});
		const store = makeStore(snapshot);
		store.selectEntity("US7");
		const view = await mountDetail(store);

		const sectionTitle = view.shadowRoot?.querySelector(".ai-sec h2");
		const ref = view.shadowRoot?.querySelector(".ai-sec .ai-ref");
		expect(sectionTitle?.textContent?.trim()).toBe("Fixed by");
		expect(ref?.querySelector(".r-id")?.textContent?.trim()).toBe("ISS9");
		expect(ref?.querySelector(".r-title")?.textContent?.trim()).toBe("Wire the detail pane");
	});

	it("opens a linked child record in the detail pane when its ref is clicked", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US7", kind: "userStory", status: "draft", title: "Open any record" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "done", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, story, issue],
			initiatives: [makeBundle(initiative, { issues: [issue], userStories: [story] })],
			relations: [makeRelation("ISS9", "fixes", "US7")]
		});
		const store = makeStore(snapshot);
		store.selectEntity("US7");
		const view = await mountDetail(store);

		const ref = view.shadowRoot?.querySelector<HTMLButtonElement>(".ai-sec .ai-ref");
		ref?.click();
		await view.updateComplete;

		expect(store.selectedId.get()).toBe("ISS9");
		expect(view.shadowRoot?.querySelector(".ai-d-title")?.textContent).toContain("Wire the detail pane");
	});

	it("renders sub-issues as a nested tree for a parent issue", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Sub-issue" });
		const nestedSubIssue = makeEntity({ id: "ISS3", kind: "issue", status: "done", title: "Nested sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, parentIssue, subIssue, nestedSubIssue],
			initiatives: [
				makeBundle(initiative, {
					issues: [parentIssue, subIssue, nestedSubIssue],
					subIssueLinks: [
						{ issue: subIssue, parent: parentIssue },
						{ issue: nestedSubIssue, parent: subIssue }
					]
				})
			]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS1");
		const view = await mountDetail(store);

		const sectionTitles = [...(view.shadowRoot?.querySelectorAll(".ai-sec h2") ?? [])].map((node) => node.textContent?.trim());
		expect(sectionTitles).toContain("Sub-issues");
		const nestedRefs = [...(view.shadowRoot?.querySelectorAll(".ai-issue-tree .ai-ref .r-id") ?? [])].map((node) => node.textContent?.trim());
		expect(nestedRefs).toEqual(["ISS2", "ISS3"]);
		expect(view.shadowRoot?.querySelector(".ai-issue-tree-children .ai-ref .r-id")?.textContent?.trim()).toBe("ISS3");
	});

	it("renders the parent issue section when a sub-issue is open", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, parentIssue, subIssue],
			initiatives: [makeBundle(initiative, { issues: [parentIssue, subIssue], subIssueLinks: [{ issue: subIssue, parent: parentIssue }] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS2");
		const view = await mountDetail(store);

		const sectionTitles = [...(view.shadowRoot?.querySelectorAll(".ai-sec h2") ?? [])].map((node) => node.textContent?.trim());
		expect(sectionTitles).toContain("Parent issue");
		expect(view.shadowRoot?.querySelector(".ai-refs .ai-ref .r-id")?.textContent?.trim()).toBe("ISS1");
	});

	it("highlights the child reference matching the active child id", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Sub-issue" });
		const otherSubIssue = makeEntity({ id: "ISS3", kind: "issue", status: "done", title: "Other sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, parentIssue, subIssue, otherSubIssue],
			initiatives: [
				makeBundle(initiative, {
					issues: [parentIssue, subIssue, otherSubIssue],
					subIssueLinks: [
						{ issue: subIssue, parent: parentIssue },
						{ issue: otherSubIssue, parent: parentIssue }
					]
				})
			]
		});
		const store = makeStore(snapshot);
		const view = document.createElement("agent-issues-detail-view");
		view.store = store;
		view.entityId = "ISS1";
		view.activeChildId = "ISS2";
		document.body.appendChild(view);
		await view.updateComplete;

		const activeRef = view.shadowRoot?.querySelector('.ai-ref[data-id="ISS2"]');
		const otherRef = view.shadowRoot?.querySelector('.ai-ref[data-id="ISS3"]');
		expect(activeRef?.classList.contains("is-active-ref")).toBe(true);
		expect(otherRef?.classList.contains("is-active-ref")).toBe(false);
	});

	it("re-roots the cascade when a cross-link reference is clicked", async () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const issue = makeEntity({ id: "ISS18", kind: "issue", status: "todo", title: "Cascade skeleton" });
		const blocker = makeEntity({ id: "ISS40", kind: "issue", status: "todo", title: "Cross-linked issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue, blocker],
			initiatives: [makeBundle(initiative, { issues: [issue, blocker] })],
			relations: [makeRelation("ISS40", "blocks", "ISS18")]
		});
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT4", "ISS18"]);
		const view = document.createElement("agent-issues-detail-view");
		view.store = store;
		view.entityId = "ISS18";
		view.cascade = true;
		document.body.appendChild(view);
		await view.updateComplete;

		const crossRef = view.shadowRoot?.querySelector<HTMLButtonElement>('.ai-sec .ai-ref[data-id="ISS40"]');
		crossRef?.click();
		await view.updateComplete;

		expect(store.reRootTrail.get()).toEqual([["INIT4", "ISS18"]]);
		expect(store.cascadePath.get()).toEqual(["ISS40"]);
	});

	it("renders created user stories with their issue trees in PRD detail view", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", status: "draft", title: "Console graph PRD" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Explore the graph" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, prd, story, parentIssue, subIssue],
			initiatives: [
				makeBundle(initiative, {
					fixLinks: [{ issue: parentIssue, userStory: story }],
					issues: [parentIssue, subIssue],
					prds: [prd],
					subIssueLinks: [{ issue: subIssue, parent: parentIssue }],
					userStories: [story]
				})
			],
			relations: [makeRelation("PRD1", "creates", "US1")]
		});
		const store = makeStore(snapshot);
		store.selectEntity("PRD1");
		const view = await mountDetail(store);

		const sectionTitles = [...(view.shadowRoot?.querySelectorAll(".ai-sec h2") ?? [])].map((node) => node.textContent?.trim());
		expect(sectionTitles).toContain("Creates");
		expect(view.shadowRoot?.querySelector('.ai-story-list .ai-ref[data-id="US1"]')).not.toBeNull();
		expect([...view.shadowRoot?.querySelectorAll('.ai-story-issues .ai-ref .r-id') ?? []].map((node) => node.textContent?.trim())).toEqual(["ISS1", "ISS2"]);
	});

	it("collapses and expands nested sub-issues in the issue detail tree", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Sub-issue" });
		const nestedSubIssue = makeEntity({ id: "ISS3", kind: "issue", status: "done", title: "Nested sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, parentIssue, subIssue, nestedSubIssue],
			initiatives: [
				makeBundle(initiative, {
					issues: [parentIssue, subIssue, nestedSubIssue],
					subIssueLinks: [
						{ issue: subIssue, parent: parentIssue },
						{ issue: nestedSubIssue, parent: subIssue }
					]
				})
			]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS1");
		const view = await mountDetail(store);

		const toggle = view.shadowRoot?.querySelector<HTMLButtonElement>('.branch-toggle[data-id="ISS2"]');
		toggle?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.ai-issue-tree-children .ai-ref .r-id')?.textContent?.trim()).not.toBe("ISS3");
		expect([...view.shadowRoot?.querySelectorAll('.ai-issue-tree .ai-ref .r-id') ?? []].map((node) => node.textContent?.trim())).toEqual(["ISS2"]);

		toggle?.click();
		await view.updateComplete;
		expect([...view.shadowRoot?.querySelectorAll('.ai-issue-tree .ai-ref .r-id') ?? []].map((node) => node.textContent?.trim())).toEqual(["ISS2", "ISS3"]);
	});

	it("offers a back control that closes the open record", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		const back = view.shadowRoot?.querySelector<HTMLButtonElement>(".ai-back");
		expect(back?.textContent).toContain("Console Viewer");
		back?.click();
		await view.updateComplete;

		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBe("INIT1");
	});

	it("omits the back control when rendered as a cascade column", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		const view = document.createElement("agent-issues-detail-view");
		view.store = store;
		view.entityId = "ISS9";
		view.cascade = true;
		document.body.appendChild(view);
		await view.updateComplete;

		expect(view.shadowRoot?.querySelector(".ai-back")).toBeNull();
	});

	it("renders the authored markdown body of the open record", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({
			body: "Overview of the work.\n\n## Plan\n\nShip the **detail** pane.",
			bodySource: "authored",
			id: "ISS9",
			kind: "issue",
			status: "todo",
			title: "Wire the detail pane"
		});
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		const body = view.shadowRoot?.querySelector(".ai-body");
		expect(body?.querySelector("h2")?.textContent?.trim()).toBe("Plan");
		expect(body?.querySelector("strong")?.textContent?.trim()).toBe("detail");
		expect(view.shadowRoot?.querySelector(".ai-body-source")).toBeNull();
	});

	it("marks generated bodies so fallback content is distinguishable from authored prose", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({
			body: "Overview of the work.\n\n## Plan\n\nInfer the next slice from linked records.",
			bodySource: "generated",
			id: "ISS9",
			kind: "issue",
			status: "todo",
			title: "Wire the detail pane"
		});
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		expect(view.shadowRoot?.querySelector(".ai-body-source-badge")?.textContent?.trim()).toBe("Generated fallback");
		expect(view.shadowRoot?.querySelector(".ai-body-source-copy")?.textContent).toContain("no authored body was present");
	});

	it("omits the body section when the record has no authored body", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ body: "", id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		expect(view.shadowRoot?.querySelector(".ai-body")).toBeNull();
	});
});
