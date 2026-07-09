import { afterEach, describe, expect, it } from "vitest";

import "./initiative-detail-view.js";
import type { Entity, InitiativeBundle, Snapshot } from "../models.js";
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

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		contexts: {
			initiatives: [],
			shared: {
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
			}
		},
		entities: [],
		generatedAt: "2026-01-01T00:00:00.000Z",
		initiatives: [],
		orphans: [],
		projectAdrs: [],
		relations: [],
		...overrides
	};
}

function makeStore(bundle: InitiativeBundle): AgentIssuesStore {
	const store = new AgentIssuesStore();
	store.connected = true;
	store.snapshot.set(makeSnapshot({ initiatives: [bundle] }));
	store.selectInitiative(bundle.initiative.id);
	return store;
}

async function mountView(store: AgentIssuesStore) {
	const view = document.createElement("agent-issues-initiative-detail-view");
	view.store = store;
	document.body.appendChild(view);
	await view.updateComplete;
	return view;
}

afterEach(() => {
	document.body.replaceChildren();
	window.location.hash = "";
});

describe("initiative detail overview tab", () => {
	it("renders an explicitly supplied initiative id without relying on the global selection", async () => {
		const initiative = makeEntity({
			body: "Overview of the work.",
			bodySource: "authored",
			id: "INIT2",
			kind: "initiative",
			status: "active",
			title: "Status derivation"
		});
		const store = new AgentIssuesStore();
		store.connected = true;
		store.snapshot.set(makeSnapshot({ initiatives: [makeBundle(initiative)] }));
		const view = document.createElement("agent-issues-initiative-detail-view") as HTMLElement & {
			store: AgentIssuesStore;
			initiativeId: string | null;
			updateComplete: Promise<unknown>;
		};
		view.store = store;
		view.initiativeId = "INIT2";
		document.body.appendChild(view);
		await view.updateComplete;

		expect(view.shadowRoot?.querySelector(".d-title")?.textContent).toContain("Status derivation");
		expect(store.selectedInitiativeId.get()).toBeNull();
	});

	it("renders the authored markdown body of the selected initiative", async () => {
		const initiative = makeEntity({
			body: "Overview of the work.\n\n## Plan\n\nShip the **initiative** detail pane.",
			bodySource: "authored",
			id: "INIT1",
			kind: "initiative",
			status: "active",
			title: "Console Viewer"
		});
		const store = makeStore(makeBundle(initiative));

		const view = await mountView(store);
		await view.updateComplete;

		const body = view.shadowRoot?.querySelector(".initiative-body .ai-body");
		expect(body?.querySelector("h2")?.textContent?.trim()).toBe("Plan");
		expect(body?.querySelector("strong")?.textContent?.trim()).toBe("initiative");
		expect(view.shadowRoot?.querySelector(".initiative-body .ai-body-source")).toBeNull();
	});

	it("renders the overview body flat, without a boxed collapsible section", async () => {
		const initiative = makeEntity({
			body: "Overview of the work.\n\n## Plan\n\nShip the **initiative** detail pane.",
			bodySource: "authored",
			id: "INIT1",
			kind: "initiative",
			status: "active",
			title: "Console Viewer"
		});
		const store = makeStore(makeBundle(initiative));

		const view = await mountView(store);
		await view.updateComplete;

		const overview = view.shadowRoot?.querySelector(".initiative-body");
		expect(overview?.classList.contains("sec")).toBe(false);
		expect(view.shadowRoot?.querySelector('.sec-toggle[data-section-id="overview-body"]')).toBeNull();
	});

	it("renders sub-issues nested beneath their parent issue in the story overview", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Explore the graph" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Sub-issue" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue: subIssue, userStory: story }],
			issues: [parentIssue, subIssue],
			subIssueLinks: [{ issue: subIssue, parent: parentIssue }],
			userStories: [story]
		});
		const store = makeStore(bundle);

		const view = await mountView(store);
		await view.updateComplete;

		const issueButtons = [...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>(".issue-tree .child") ?? [])];
		expect(issueButtons.map((button) => button.dataset.id)).toEqual(["ISS1", "ISS2"]);
		expect(view.shadowRoot?.querySelector(".issue-branch-children .child")?.getAttribute("data-id")).toBe("ISS2");
	});

	it("shows child issues when the parent issue itself fixes the story", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Explore the graph" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const childIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Child issue" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue: parentIssue, userStory: story }],
			issues: [parentIssue, childIssue],
			subIssueLinks: [{ issue: childIssue, parent: parentIssue }],
			userStories: [story]
		});
		const store = makeStore(bundle);

		const view = await mountView(store);
		await view.updateComplete;

		expect([...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>(".issue-tree .child") ?? [])].map((button) => button.dataset.id)).toEqual(["ISS1", "ISS2"]);
		expect(view.shadowRoot?.querySelector('.issue-branch-children .child[data-id="ISS2"]')).not.toBeNull();
	});

	it("collapses and expands nested sub-issues in the story overview", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Explore the graph" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Sub-issue" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue: subIssue, userStory: story }],
			issues: [parentIssue, subIssue],
			subIssueLinks: [{ issue: subIssue, parent: parentIssue }],
			userStories: [story]
		});
		const store = makeStore(bundle);

		const view = await mountView(store);
		await view.updateComplete;

		const toggle = view.shadowRoot?.querySelector<HTMLButtonElement>('.branch-toggle[data-id="ISS1"]');
		toggle?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.issue-branch-children .child[data-id="ISS2"]')).toBeNull();

		toggle?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.issue-branch-children .child[data-id="ISS2"]')).not.toBeNull();
	});

	it("collapses large overview sections independently", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render nodes" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", status: "draft", title: "Graph PRD" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", status: "proposed", title: "SVG graph layout" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue, userStory: story }],
			issues: [issue],
			prds: [prd],
			adrs: [adr],
			userStories: [story]
		});
		const store = makeStore(bundle);

		const view = await mountView(store);
		await view.updateComplete;

		const prdToggle = view.shadowRoot?.querySelector<HTMLButtonElement>('.sec-toggle[data-section-id="prds"]');
		const storyToggle = view.shadowRoot?.querySelector<HTMLButtonElement>('.sec-toggle[data-section-id="stories"]');
		const adrToggle = view.shadowRoot?.querySelector<HTMLButtonElement>('.sec-toggle[data-section-id="adrs"]');

		prdToggle?.click();
		await view.updateComplete;
		expect(prdToggle?.getAttribute("aria-expanded")).toBe("false");
		expect(view.shadowRoot?.querySelector('.line[data-id="PRD1"]')).toBeNull();
		expect(view.shadowRoot?.querySelector('.story-head[data-id="US1"]')).not.toBeNull();

		storyToggle?.click();
		await view.updateComplete;
		expect(storyToggle?.getAttribute("aria-expanded")).toBe("false");
		expect(view.shadowRoot?.querySelector('.story-head[data-id="US1"]')).toBeNull();

		adrToggle?.click();
		await view.updateComplete;
		expect(adrToggle?.getAttribute("aria-expanded")).toBe("false");
		expect(view.shadowRoot?.querySelector('.line[data-id="ADR1"]')).toBeNull();

		prdToggle?.click();
		await view.updateComplete;
		expect(prdToggle?.getAttribute("aria-expanded")).toBe("true");
		expect(view.shadowRoot?.querySelector('.line[data-id="PRD1"]')).not.toBeNull();
	});
});

describe("initiative detail graph tab", () => {
	it("renders the relationship graph with a node per record on the graph subtab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "done", title: "Render nodes" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue, userStory: story }],
			issues: [issue],
			userStories: [story]
		});
		const store = makeStore(bundle);
		store.setInitTab("graph");

		const view = await mountView(store);
		await view.updateComplete;

		const nodes = view.shadowRoot?.querySelectorAll("agent-issues-relationship-graph") ?? [];
		expect(nodes.length).toBe(1);
		const svgNodes = nodes[0]?.shadowRoot?.querySelectorAll(".ai-node") ?? [];
		expect(svgNodes.length).toBe(3);
	});

	it("renders sub-issues in their own graph column", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Sub-issue" });
		const bundle = makeBundle(initiative, {
			issues: [parentIssue, subIssue],
			subIssueLinks: [{ issue: subIssue, parent: parentIssue }]
		});
		const store = makeStore(bundle);
		store.setInitTab("graph");

		const view = await mountView(store);
		await view.updateComplete;

		const graph = view.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const labels = [...(graph?.shadowRoot?.querySelectorAll<SVGTextElement>(".ai-colhead") ?? [])].map((node) => node.textContent?.trim());

		expect(labels).toContain("Sub-issues");
	});

	it("opens a record when its graph node is clicked", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render nodes" });
		const bundle = makeBundle(initiative, { issues: [issue] });
		const store = makeStore(bundle);
		store.setInitTab("graph");

		const view = await mountView(store);
		await view.updateComplete;

		const graph = view.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const issueNode = graph?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="ISS1"]');
		issueNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

		expect(store.selectedId.get()).toBe("ISS1");
	});
});

describe("initiative detail context tab", () => {
	it("renders the initiative glossary on the context subtab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const bundle = makeBundle(initiative);
		const store = new AgentIssuesStore();
		store.connected = true;
		store.snapshot.set(
			makeSnapshot({
				contexts: {
					initiatives: [
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT1",
								scopeEntityId: "INIT1",
								scopeKind: "initiative",
								scopeLabel: "Console Viewer",
								summary: "How the console viewer is structured.",
								title: "Console Viewer Context",
								updatedAt: null
							},
							terms: [{ avoid: ["dashboard"], createdAt: "", definition: "The three-pane browser.", term: "Console", updatedAt: "" }]
						}
					],
					shared: makeSnapshot().contexts.shared
				},
				initiatives: [bundle]
			})
		);
		store.selectInitiative(initiative.id);
		store.setInitTab("context");

		const view = await mountView(store);
		await view.updateComplete;

		const contextView = view.shadowRoot?.querySelector("agent-issues-context-view");
		expect(contextView).not.toBeNull();
		const text = contextView?.shadowRoot?.textContent ?? "";
		expect(text).toContain("How the console viewer is structured.");
		expect(text).toContain("Console");
		expect(text).toContain("The three-pane browser.");
		expect(text).toContain("dashboard");
	});
});

describe("initiative detail handoffs tab", () => {
	it("renders saved handoffs with their summary and rendered body on the handoffs subtab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "in-progress", title: "Add handoff persistence" });
		const bundle = makeBundle(initiative, {
			issues: [issue],
			handoffs: [
				{
					id: "HO1",
					entityId: "ISS1",
					initiativeId: "INIT1",
					summary: "Paused mid-refactor",
					body: "Store layer done. Resume from the failing UI test.",
					createdAt: "2026-06-11T10:00:00.000Z"
				}
			]
		});
		const store = makeStore(bundle);
		store.setInitTab("handoffs");

		const view = await mountView(store);
		await view.updateComplete;

		const handoff = view.shadowRoot?.querySelector('[data-handoff="HO1"]');
		expect(handoff).not.toBeNull();
		const text = handoff?.textContent ?? "";
		expect(text).toContain("Paused mid-refactor");
		expect(text).toContain("Store layer done.");
		expect(text).toContain("Add handoff persistence");
	});

	it("shows an empty message when no handoffs are saved", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const bundle = makeBundle(initiative);
		const store = makeStore(bundle);
		store.setInitTab("handoffs");

		const view = await mountView(store);
		await view.updateComplete;

		const text = view.shadowRoot?.textContent ?? "";
		expect(text).toContain("No handoffs have been saved");
	});
});

