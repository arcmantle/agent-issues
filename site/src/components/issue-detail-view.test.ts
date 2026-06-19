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
