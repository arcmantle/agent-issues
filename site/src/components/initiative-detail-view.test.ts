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

