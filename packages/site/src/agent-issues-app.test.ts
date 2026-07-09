import { afterEach, describe, expect, it, vi } from "vitest";

import "./agent-issues-app.js";
import type { ContextDetails, Entity, InitiativeBundle, SiteConfig, Snapshot } from "./models.js";
import { AgentIssuesStore } from "./services/agent-issues-store.js";

function makeEntity(overrides: Partial<Entity> & Pick<Entity, "id">): Entity {
	return {
		body: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		kind: "initiative",
		status: "draft",
		title: `Title for ${overrides.id}`,
		updatedAt: "2026-01-01T00:00:00.000Z",
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

function makeConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
	return {
		availableTenants: [{ displayName: "Demo", id: "demo" }],
		currentTenant: "demo",
		dbPath: "/tmp/agent-issues.db",
		...overrides
	};
}

function makeStore(config: SiteConfig, snapshot: Snapshot): AgentIssuesStore {
	const store = new AgentIssuesStore();
	store.connected = true;
	store.config.set(config);
	store.snapshot.set(snapshot);
	store.selectedTenant.set(config.currentTenant);
	return store;
}

async function mountApp(store: AgentIssuesStore) {
	const app = document.createElement("agent-issues-app");
	app.store = store;
	document.body.appendChild(app);
	await app.updateComplete;
	return app;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("three-pane console shell", () => {
	it("renders a project rail, an initiative master list, and a detail pane simultaneously", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		const root = app.shadowRoot;
		expect(root?.querySelector('[data-pane="rail"]')).not.toBeNull();
		expect(root?.querySelector('[data-pane="master"]')).not.toBeNull();
		expect(root?.querySelector('[data-pane="detail"]')).not.toBeNull();
	});

	it("lists every available project in the rail", async () => {
		const config = makeConfig({
			availableTenants: [
				{ displayName: "Demo", id: "demo" },
				{ displayName: "Content Hub", id: "content-hub" }
			],
			currentTenant: "demo"
		});
		const store = makeStore(config, makeSnapshot());
		const app = await mountApp(store);

		const railTenants = app.shadowRoot?.querySelectorAll('[data-pane="rail"] [data-tenant]');
		const tenantIds = [...(railTenants ?? [])].map((element) => element.getAttribute("data-tenant"));
		expect(tenantIds).toEqual(["content-hub", "demo"]);
	});

	it("renders one master-list entry per initiative in the snapshot", async () => {
		const snapshot = makeSnapshot({
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" })),
				makeBundle(makeEntity({ id: "INIT2", title: "Search" }))
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		const masterItems = app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-initiative]');
		const initiativeIds = [...(masterItems ?? [])].map((element) => element.getAttribute("data-initiative"));
		expect(initiativeIds).toEqual(["INIT1", "INIT2"]);
	});

	it("opens the selected initiative in the detail pane while keeping the rail and master list", async () => {
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const snapshot = makeSnapshot({
			entities: [initiative],
			initiatives: [makeBundle(initiative)]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		const masterItem = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="master"] [data-initiative="INIT1"]');
		masterItem?.click();
		await app.updateComplete;

		const root = app.shadowRoot;
		const cascade = root?.querySelector('[data-pane="detail"] agent-issues-cascade-view') as HTMLElement & { updateComplete: Promise<unknown> };
		await cascade?.updateComplete;
		expect(store.selectedInitiativeId.get()).toBe("INIT1");
		expect(cascade?.shadowRoot?.querySelector('agent-issues-initiative-detail-view')).not.toBeNull();
		expect(root?.querySelector('[data-pane="rail"] [data-tenant]')).not.toBeNull();
		expect(root?.querySelector('[data-pane="master"] [data-initiative]')).not.toBeNull();
	});

	it("opens the selected initiative as the root column of a cascade", async () => {
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const snapshot = makeSnapshot({
			entities: [initiative],
			initiatives: [makeBundle(initiative)]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		const masterItem = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="master"] [data-initiative="INIT1"]');
		masterItem?.click();
		await app.updateComplete;

		const cascade = app.shadowRoot?.querySelector('[data-pane="detail"] agent-issues-cascade-view') as HTMLElement & {
			updateComplete: Promise<unknown>;
		};
		expect(cascade).not.toBeNull();
		expect(store.cascadePath.get()).toEqual(["INIT1"]);

		await cascade.updateComplete;
		const columns = cascade.shadowRoot?.querySelectorAll(".cascade-column");
		expect(columns?.length).toBe(1);
		expect(columns?.[0]?.getAttribute("data-column-id")).toBe("INIT1");
	});

	it("opens a new cascade column when a child reference is clicked, without a reload", async () => {
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "ready", title: "Drill the lineage" });
		const snapshot = makeSnapshot({
			entities: [initiative, story],
			initiatives: [makeBundle(initiative, { userStories: [story] })]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="master"] [data-initiative="INIT1"]')?.click();
		await app.updateComplete;

		const cascade = app.shadowRoot?.querySelector('[data-pane="detail"] agent-issues-cascade-view') as HTMLElement & {
			updateComplete: Promise<unknown>;
		};
		await cascade.updateComplete;
		const initiativeView = cascade.shadowRoot?.querySelector('agent-issues-initiative-detail-view') as HTMLElement & {
			updateComplete: Promise<unknown>;
		};
		await initiativeView.updateComplete;
		initiativeView.shadowRoot?.querySelector<HTMLButtonElement>('.story-head')?.click();
		await app.updateComplete;
		await cascade.updateComplete;

		expect(store.cascadePath.get()).toEqual(["INIT1", "US1"]);
		const columnIds = [...(cascade.shadowRoot?.querySelectorAll('.cascade-column') ?? [])].map((column) =>
			column.getAttribute("data-column-id")
		);
		expect(columnIds).toEqual(["INIT1", "US1"]);
	});

	it("switches the active project when a rail item is clicked", async () => {
		const config = makeConfig({
			availableTenants: [
				{ displayName: "Demo", id: "demo" },
				{ displayName: "Content Hub", id: "content-hub" }
			],
			currentTenant: "demo"
		});
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify(makeSnapshot()), { status: 200 }));
		const store = makeStore(config, makeSnapshot());
		const app = await mountApp(store);

		const railItem = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="rail"] [data-tenant="content-hub"]');
		railItem?.click();
		await app.updateComplete;

		expect(store.selectedTenant.get()).toBe("content-hub");
		expect(app.shadowRoot?.querySelector('[data-pane="master"]')).not.toBeNull();
		fetchMock.mockRestore();
	});

	it("offers Initiatives, ADRs, Context, and Graph navigation in the rail", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		const sections = [...(app.shadowRoot?.querySelectorAll('[data-pane="rail"] [data-section]') ?? [])].map(
			(element) => element.getAttribute("data-section")
		);
		expect(sections).toEqual(["initiatives", "adrs", "context", "graph"]);
	});

	it("lists architecture decisions in the master list when the ADRs section is active", async () => {
		const snapshot = makeSnapshot({
			projectAdrs: [
				makeEntity({ id: "ADR1", kind: "adr", status: "accepted", title: "Use cytoscape" }),
				makeEntity({ id: "ADR2", kind: "adr", status: "proposed", title: "Adopt signals" })
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		const adrNav = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="rail"] [data-section="adrs"]');
		adrNav?.click();
		await app.updateComplete;

		const adrCards = [...(app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-id]') ?? [])].map(
			(element) => element.getAttribute("data-id")
		);
		expect(adrCards).toEqual(["ADR1", "ADR2"]);
	});

	it("labels a project-scoped ADR as a project-level decision in the ADRs section", async () => {
		const snapshot = makeSnapshot({
			projectAdrs: [makeEntity({ id: "ADR1", kind: "adr", status: "accepted", title: "Use deterministic SVG" })]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("adrs");
		await app.updateComplete;

		const card = app.shadowRoot?.querySelector('[data-pane="master"] [data-id="ADR1"]');
		expect(card?.getAttribute("data-scope")).toBe("project");
		expect(card?.querySelector(".m-meta")?.textContent).toContain("project decision");
	});

	it("labels an initiative-scoped ADR with its initiative in the ADRs section", async () => {
		const snapshot = makeSnapshot({
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), {
					adrs: [makeEntity({ id: "ADR2", kind: "adr", status: "accepted", title: "Render graphs by hand" })]
				})
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("adrs");
		await app.updateComplete;

		const card = app.shadowRoot?.querySelector('[data-pane="master"] [data-id="ADR2"]');
		expect(card?.getAttribute("data-scope")).toBe("initiative");
		expect(card?.querySelector(".m-meta")?.textContent).toContain("initiative Console Viewer");
	});

	it("renders KPI cards and overview/graph subtabs in the initiative detail", async () => {
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const snapshot = makeSnapshot({
			entities: [initiative],
			initiatives: [
				makeBundle(initiative, {
					issues: [
						makeEntity({ id: "ISS1", kind: "issue", status: "done" }),
						makeEntity({ id: "ISS2", kind: "issue", status: "todo" })
					],
					userStories: [makeEntity({ id: "US1", kind: "story" })]
				})
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectInitiative("INIT1");
		await app.updateComplete;

		const cascade = app.shadowRoot?.querySelector('[data-pane="detail"] agent-issues-cascade-view') as HTMLElement & { updateComplete: Promise<unknown> };
		await cascade?.updateComplete;
		const initiativeView = cascade?.shadowRoot?.querySelector('agent-issues-initiative-detail-view') as HTMLElement & { updateComplete: Promise<unknown> };
		await initiativeView?.updateComplete;
		const detail = initiativeView?.shadowRoot;

		const kpis = detail?.querySelectorAll(".kpi");
		const subtabs = [...(detail?.querySelectorAll(".subtab") ?? [])].map((element) => element.textContent?.trim());
		expect(kpis?.length).toBe(4);
		expect(subtabs).toEqual(["Overview", "Graph", "Context", "Handoffs"]);
	});

	it("keeps the owning initiative highlighted in the master rail while one of its records is open", async () => {
		const story = makeEntity({ id: "US7", kind: "story", title: "Open any record" });
		const snapshot = makeSnapshot({
			entities: [makeEntity({ id: "INIT1", title: "Console Viewer" }), story],
			initiatives: [makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), { userStories: [story] })]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectEntity("US7");
		await app.updateComplete;

		const masterItem = app.shadowRoot?.querySelector('[data-pane="master"] [data-initiative="INIT1"]');
		expect(masterItem?.classList.contains("active")).toBe(true);
		expect(app.shadowRoot?.querySelector('[data-pane="detail"] agent-issues-detail-view')).not.toBeNull();
	});

	it("re-anchors the master rail to the target initiative when a cross-reference crosses initiatives", async () => {
		const storyA = makeEntity({ id: "US7", kind: "story", title: "Open any record" });
		const issueB = makeEntity({ id: "ISS9", kind: "issue", status: "done", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [
				makeEntity({ id: "INIT1", title: "Console Viewer" }),
				makeEntity({ id: "INIT2", title: "Search" }),
				storyA,
				issueB
			],
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), { userStories: [storyA] }),
				makeBundle(makeEntity({ id: "INIT2", title: "Search" }), { issues: [issueB] })
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectEntity("US7");
		await app.updateComplete;
		store.selectEntity("ISS9");
		await app.updateComplete;

		const anchoredInit1 = app.shadowRoot?.querySelector('[data-pane="master"] [data-initiative="INIT1"]');
		const anchoredInit2 = app.shadowRoot?.querySelector('[data-pane="master"] [data-initiative="INIT2"]');
		expect(anchoredInit1?.classList.contains("active")).toBe(false);
		expect(anchoredInit2?.classList.contains("active")).toBe(true);
	});
});

describe("collapse toggles", () => {
	it("collapses the rail when its collapse toggle is clicked", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		const toggle = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-collapse="rail"]');
		toggle?.click();
		await app.updateComplete;

		expect(store.railCollapsed.get()).toBe(true);
		expect(app.shadowRoot?.querySelector(".console")?.classList.contains("rail-collapsed")).toBe(true);
	});

	it("collapses the master list when its collapse toggle is clicked", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		const toggle = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-collapse="master"]');
		toggle?.click();
		await app.updateComplete;

		expect(store.masterCollapsed.get()).toBe(true);
		expect(app.shadowRoot?.querySelector(".console")?.classList.contains("master-collapsed")).toBe(true);
	});

	it("auto-collapses the master list while drilling two columns deep", async () => {
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const child = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const snapshot = makeSnapshot({
			entities: [initiative, child],
			initiatives: [makeBundle(initiative)]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.cascadePath.set(["INIT1", "PRD1"]);
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector(".console")?.classList.contains("master-collapsed")).toBe(true);
	});
});

describe("project relationship graph section", () => {
	it("renders a node for the project, each initiative, and their PRDs and ADRs", async () => {
		const snapshot = makeSnapshot({
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), {
					adrs: [makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" })],
					prds: [makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" })]
				})
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("graph");
		await app.updateComplete;

		const graph = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(graph).not.toBeNull();
		const nodes = graph?.shadowRoot?.querySelectorAll(".ai-node") ?? [];
		expect(nodes.length).toBe(4);
	});

	it("opens an initiative when its node is clicked and a record when a PRD node is clicked", async () => {
		const snapshot = makeSnapshot({
			entities: [makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" })],
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), {
					prds: [makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" })]
				})
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("graph");
		await app.updateComplete;

		const graph = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const initiativeNode = graph?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="INIT1"]');
		initiativeNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		expect(store.selectedInitiativeId.get()).toBe("INIT1");

		store.selectSection("graph");
		await app.updateComplete;
		const graphAgain = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const prdNode = graphAgain?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="PRD1"]');
		prdNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		expect(store.selectedId.get()).toBe("PRD1");
	});
});

describe("project context section", () => {
	it("shows the shared term count on the Context nav item", async () => {
		const shared = makeSharedContext();
		shared.context.summary = "Project glossary.";
		shared.terms = [{ avoid: [], createdAt: "", definition: "An issue.", term: "Issue", updatedAt: "" }];
		const store = makeStore(makeConfig(), makeSnapshot({ contexts: { initiatives: [], shared } }));
		const app = await mountApp(store);

		const contextNav = app.shadowRoot?.querySelector<HTMLElement>('[data-section="context"]');
		expect(contextNav).not.toBeNull();
		expect(contextNav?.querySelector(".nav-count")?.textContent).toBe("1");
	});

	it("renders the shared context summary and glossary in the detail pane", async () => {
		const shared = makeSharedContext();
		shared.context.title = "Content Hub";
		shared.context.summary = "Shared language for the whole project.";
		shared.terms = [{ avoid: ["settings"], createdAt: "", definition: "Privileged product area.", term: "Administration", updatedAt: "" }];
		const store = makeStore(makeConfig(), makeSnapshot({ contexts: { initiatives: [], shared } }));
		const app = await mountApp(store);

		store.selectSection("context");
		await app.updateComplete;

		const contextView = app.shadowRoot?.querySelector("agent-issues-context-view");
		expect(contextView).not.toBeNull();
		const text = contextView?.shadowRoot?.textContent ?? "";
		expect(text).toContain("Shared language for the whole project.");
		expect(text).toContain("Administration");
		expect(text).toContain("Privileged product area.");
		expect(text).toContain("settings");
	});

	it("renders initiative-scoped discovery and duplicate warnings in the detail pane", async () => {
		const shared = makeSharedContext();
		shared.context.title = "Content Hub";
		shared.context.summary = "Shared language for the whole project.";
		shared.terms = [{ avoid: [], createdAt: "", definition: "Canonical order.", term: "Order", updatedAt: "" }];
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				contexts: {
					shared,
					initiatives: [
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT2",
								scopeEntityId: "INIT2",
								scopeKind: "initiative",
								scopeLabel: "Payments",
								summary: "Payments terms.",
								title: "Payments Context",
								updatedAt: null
							},
							terms: [
								{ avoid: [], createdAt: "", definition: "Payment-specific order.", term: "Order", updatedAt: "" },
								{ avoid: ["queued run"], createdAt: "", definition: "A captured payment.", term: "Settlement", updatedAt: "" }
							]
						}
					]
				}
			})
		);
		const app = await mountApp(store);

		store.selectSection("context");
		await app.updateComplete;

		const text = app.shadowRoot?.textContent ?? "";
		expect(text).toContain("Initiative term index");
		expect(text).toContain("Payments");
		expect(text).toContain("Settlement");
		expect(text).toContain("conflicting definitions across 2 scopes");
		expect(text).toContain("queued run");
	});

	it("uses one search bar across context tabs and scopes the results to the active tab", async () => {
		const shared = makeSharedContext();
		shared.context.title = "Content Hub";
		shared.context.summary = "Shared language for the whole project.";
		shared.terms = [{ avoid: [], createdAt: "", definition: "Privileged product area.", term: "Administration", updatedAt: "" }];
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				contexts: {
					shared,
					initiatives: [
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT2",
								scopeEntityId: "INIT2",
								scopeKind: "initiative",
								scopeLabel: "Payments",
								summary: "Payments terms.",
								title: "Payments Context",
								updatedAt: null
							},
							terms: [{ avoid: [], createdAt: "", definition: "Captured funds.", term: "Settlement", updatedAt: "" }]
						}
					]
				}
			})
		);
		const app = await mountApp(store);

		store.selectSection("context");
		await app.updateComplete;

		const initiativesTab = app.shadowRoot?.querySelector<HTMLElement>('[data-context-tab="initiatives"]');
		initiativesTab?.click();
		await app.updateComplete;

		const search = app.shadowRoot?.querySelector<HTMLInputElement>('.ctx-controls .master-search');
		expect(search?.placeholder).toBe("Search initiative terminology…");
		if (search) {
			search.value = "Settlement";
			search.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		}
		await app.updateComplete;

		const initiativeText = app.shadowRoot?.textContent ?? "";
		expect(initiativeText).toContain("Settlement");
		expect(app.shadowRoot?.querySelector("agent-issues-context-view")).toBeNull();

		const globalTab = app.shadowRoot?.querySelector<HTMLElement>('[data-context-tab="global"]');
		globalTab?.click();
		await app.updateComplete;

		const globalSearch = app.shadowRoot?.querySelector<HTMLInputElement>('.ctx-controls .master-search');
		expect(globalSearch?.placeholder).toBe("Search shared context…");
		const contextView = app.shadowRoot?.querySelector("agent-issues-context-view");
		expect(contextView).not.toBeNull();
		const globalText = contextView?.shadowRoot?.textContent ?? "";
		expect(globalText).toContain("No shared context matches the current search.");
	});
});

