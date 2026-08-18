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
		entities: [initiative],
		fixLinks: [],
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
		issueComments: overrides.issueComments ?? {},
		orphans: [],
		projectAdrs: [],
		relations: [],
		users: overrides.users ?? [],
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

	it("renders unassigned issues that are not linked to a user story", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Explore the graph" });
		const directIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Direct initiative issue" });
		const childIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Direct issue child" });
		const storyIssue = makeEntity({ id: "ISS3", kind: "issue", status: "todo", title: "Story issue" });
		const directLeafIssue = makeEntity({ id: "ISS4", kind: "issue", status: "todo", title: "Direct leaf issue" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue: storyIssue, userStory: story }],
			issues: [directIssue, childIssue, storyIssue, directLeafIssue],
			subIssueLinks: [{ issue: childIssue, parent: directIssue }],
			userStories: [story]
		});
		const store = makeStore(bundle);

		const view = await mountView(store);
		await view.updateComplete;

		const directIssueButtons = [...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>(".direct-issues .child") ?? [])];
		expect(directIssueButtons.map((button) => button.dataset.id)).toEqual(["ISS1", "ISS2", "ISS4"]);
		expect(view.shadowRoot?.textContent).toContain("Unassigned issues");
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>(".direct-issues .branch-toggle")?.getAttribute("aria-label")).toBe(
			"Collapse sub-issues for Direct initiative issue"
		);
		const directLeafRow = view.shadowRoot?.querySelector('.direct-issues .child[data-id="ISS4"]')?.closest(".issue-branch-row");
		expect(directLeafRow?.querySelector(".branch-spacer")).toBeNull();
	});

	it("renders owned and resolved debt in distinct initiative sections", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const ownedDebt = makeEntity({ category: "technical", id: "DEBT1", kind: "debt", priority: "high", status: "open", title: "Replace legacy storage" });
		const resolvedDebt = makeEntity({ category: "process", id: "DEBT2", kind: "debt", priority: "medium", status: "resolved", title: "Document incident response" });
		const store = new AgentIssuesStore();
		store.connected = true;
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, ownedDebt, resolvedDebt],
				initiatives: [makeBundle(initiative)],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: ownedDebt.id, type: "records" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: resolvedDebt.id, type: "resolves" }
				]
			})
		);
		store.selectInitiative(initiative.id);
		const view = await mountView(store);

		const sectionTitles = [...(view.shadowRoot?.querySelectorAll(".sec-title") ?? [])].map((title) => title.textContent?.trim());
		expect(sectionTitles).toEqual(expect.arrayContaining(["Owned debt", "Resolves debt"]));
		expect(view.shadowRoot?.querySelector('.line[data-id="DEBT1"]')?.textContent).toContain("Replace legacy storage");
		expect(view.shadowRoot?.querySelector('.line[data-id="DEBT2"]')?.textContent).toContain("Document incident response");
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
		const adr = makeEntity({ id: "ADR1", kind: "adr", status: "current", title: "SVG graph layout" });
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

	it("uses the shared graph filter controls to hide an initiative graph column", async () => {
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

		const filters = view.shadowRoot?.querySelector("agent-issues-relationship-graph-filters");
		expect([...filters?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".graph-kind-chip") ?? []].map((chip) => chip.textContent?.trim())).toEqual([
			"Initiative",
			"Plan",
			"PRD",
			"ADR",
			"User story",
			"Issue",
			"Debt"
		]);

		filters?.shadowRoot?.querySelector<HTMLButtonElement>('[data-graph-kind="issue"]')?.click();
		await view.updateComplete;

		const graph = view.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(graph?.shadowRoot?.querySelector('.ai-node[data-id="ISS1"]')).toBeNull();
		expect([...graph?.shadowRoot?.querySelectorAll<SVGTextElement>(".ai-colhead") ?? []].map((node) => node.textContent?.trim())).not.toContain("Issues");
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
