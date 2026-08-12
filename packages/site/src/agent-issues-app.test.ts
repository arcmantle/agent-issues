import { afterEach, describe, expect, it, vi } from "vitest";

import "./agent-issues-app.js";
import type { ContextDetails, Entity, InitiativeBundle, ProjectDiscovery, ProjectRollup, SiteConfig, Snapshot } from "./models.js";
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
	const initiatives = overrides.initiatives ?? [];
	const relations = overrides.relations ?? [];
	const ownedInitiativeIds = new Set(relations.filter((relation) => relation.type === "contains").map((relation) => relation.toId));
	const defaultEpic = makeEntity({ id: "EPIC0", kind: "epic", status: "active", title: "Default Epic" });
	const defaultEpicRelations = initiatives
		.filter((bundle) => !ownedInitiativeIds.has(bundle.initiative.id))
		.map((bundle) => ({
			createdAt: "2026-01-01T00:00:00.000Z",
			fromId: defaultEpic.id,
			toId: bundle.initiative.id,
			type: "contains"
		}));
	const entities = defaultEpicRelations.length > 0 ? [defaultEpic, ...(overrides.entities ?? [])] : overrides.entities ?? [];

	return {
		...overrides,
		contexts: overrides.contexts ?? { initiatives: [], shared: makeSharedContext() },
		entities,
		generatedAt: overrides.generatedAt ?? "2026-01-01T00:00:00.000Z",
		initiatives,
		issueComments: overrides.issueComments ?? {},
		orphans: overrides.orphans ?? [],
		projectAdrs: overrides.projectAdrs ?? [],
		relations: [...relations, ...defaultEpicRelations],
		users: overrides.users ?? []
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

function makeProjectDiscovery(projects: ProjectRollup[]): ProjectDiscovery {
	return { kind: "available", projects };
}

function makeStore(config: SiteConfig, snapshot: Snapshot): AgentIssuesStore {
	const store = new AgentIssuesStore();
	store.connected = true;
	store.config.set(config);
	store.snapshot.set(snapshot);
	store.selectedTenant.set(config.currentTenant);
	store.selectedProjectId.set("PROJ1");
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
	vi.unstubAllGlobals();
});

describe("three-pane console shell", () => {
	it("renders the selected tenant's project chooser when no project is selected", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		store.selectedProjectId.set(null);
		const app = await mountApp(store);

		expect(app.shadowRoot?.querySelector('[data-view="project-chooser"]')).not.toBeNull();
		expect(app.shadowRoot?.querySelector('[data-pane="rail"]')).toBeNull();
	});

	it("shows each discovered project with its epic, initiative, and completion rollups", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		store.selectedProjectId.set(null);
		store.projectDiscovery.set(
			makeProjectDiscovery([
				{
					completedInitiativeCount: 3,
					epicCount: 2,
					initiativeCount: 4,
					project: makeEntity({ id: "PROJ1", kind: "project", status: "active", title: "Console Viewer" })
				}
			])
		);
		const app = await mountApp(store);

		const card = app.shadowRoot?.querySelector<HTMLElement>('[data-project="PROJ1"]');
		expect(card?.textContent).toContain("2 epics");
		expect(card?.textContent).toContain("4 initiatives");
		expect(card?.textContent).toContain("3/4 completed");
		expect(card?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("75");
	});

	it("keeps empty and unavailable tenants distinct without offering a project to open", async () => {
		const emptyStore = makeStore(makeConfig(), makeSnapshot());
		emptyStore.selectedProjectId.set(null);
		emptyStore.projectDiscovery.set(makeProjectDiscovery([]));
		const emptyApp = await mountApp(emptyStore);

		expect(emptyApp.shadowRoot?.textContent).toContain("has no available projects");
		expect(emptyApp.shadowRoot?.querySelector("[data-project]")).toBeNull();

		const unavailableStore = makeStore(makeConfig(), makeSnapshot());
		unavailableStore.selectedProjectId.set(null);
		unavailableStore.projectDiscovery.set({ kind: "unavailable" });
		const unavailableApp = await mountApp(unavailableStore);

		expect(unavailableApp.shadowRoot?.textContent).toContain("tenant is unavailable");
		expect(unavailableApp.shadowRoot?.querySelector("[data-project]")).toBeNull();
	});

	it("opens a chosen project and returns to the same tenant's chooser from the project switcher", async () => {
		vi.stubGlobal(
			"EventSource",
			class {
				public close() {}
			}
		);
		const store = makeStore(makeConfig(), makeSnapshot());
		store.selectedProjectId.set(null);
		store.projectDiscovery.set(
			makeProjectDiscovery([
				{
					completedInitiativeCount: 0,
					epicCount: 1,
					initiativeCount: 1,
					project: makeEntity({ id: "PROJ2", kind: "project", status: "active", title: "Payments" })
				}
			])
		);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot() }), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(
						makeProjectDiscovery([
							{
								completedInitiativeCount: 0,
								epicCount: 1,
								initiativeCount: 1,
								project: makeEntity({ id: "PROJ2", kind: "project", status: "active", title: "Payments" })
							}
						])
					),
					{ status: 200 }
				)
			);
		const app = await mountApp(store);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-project="PROJ2"]')?.click();
		await vi.waitFor(() => expect(store.selectedProjectId.get()).toBe("PROJ2"));
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector('[data-pane="rail"]')).not.toBeNull();
		expect(app.shadowRoot?.querySelector<HTMLButtonElement>(".projects-button")).toBeNull();
		app.shadowRoot?.querySelector<HTMLButtonElement>(".switcher-button")?.click();
		await app.updateComplete;

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(app.shadowRoot?.querySelector('[data-view="project-chooser"]')).not.toBeNull();
		await vi.waitFor(() => expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/projects?tenant=demo"));
		fetchMock.mockRestore();
	});

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

	it("groups initiatives beneath their owning epic", async () => {
		const discovery = makeProjectDiscovery([
			{
				completedInitiativeCount: 0,
				epicCount: 2,
				initiativeCount: 2,
				project: makeEntity({ id: "PROJ1", kind: "project", status: "active", title: "Console Viewer" })
			}
		]);
		const platformEpic = makeEntity({ id: "EPIC1", kind: "epic", status: "active", title: "Platform" });
		const deliveryEpic = makeEntity({ id: "EPIC2", kind: "epic", status: "active", title: "Delivery" });
		const platformInitiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const deliveryInitiative = makeEntity({ id: "INIT2", title: "Search" });
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				entities: [platformEpic, deliveryEpic, platformInitiative, deliveryInitiative],
				initiatives: [makeBundle(platformInitiative), makeBundle(deliveryInitiative)],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "EPIC1", toId: "INIT1", type: "contains" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "EPIC2", toId: "INIT2", type: "contains" }
				]
			})
		);
		store.projectDiscovery.set(discovery);
		const app = await mountApp(store);

		const platformSection = app.shadowRoot?.querySelector<HTMLElement>('[data-epic="EPIC1"]');
		const deliverySection = app.shadowRoot?.querySelector<HTMLElement>('[data-epic="EPIC2"]');
		expect(platformSection?.querySelector('[data-initiative="INIT1"]')).not.toBeNull();
		expect(platformSection?.querySelector('[data-initiative="INIT2"]')).toBeNull();
		expect(deliverySection?.querySelector('[data-initiative="INIT2"]')).not.toBeNull();
		expect(deliverySection?.querySelector('[data-initiative="INIT1"]')).toBeNull();
	});

	it("shows epic rollups, names the default epic, and collapses its initiative list", async () => {
		const completedInitiative = makeEntity({ id: "INIT1", status: "done", title: "Closed work" });
		const openInitiative = makeEntity({ id: "INIT2", title: "Open work" });
		const defaultEpic = makeEntity({ id: "EPIC0", kind: "epic", status: "active", title: "Default Epic" });
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				entities: [defaultEpic, completedInitiative, openInitiative],
				initiatives: [makeBundle(completedInitiative), makeBundle(openInitiative)],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "EPIC0", toId: "INIT1", type: "contains" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "EPIC0", toId: "INIT2", type: "contains" }
				]
			})
		);
		const app = await mountApp(store);

		const epicSection = app.shadowRoot?.querySelector<HTMLElement>('[data-epic="EPIC0"]');
		const toggle = epicSection?.querySelector<HTMLButtonElement>('[data-epic-toggle="EPIC0"]');
		expect(epicSection?.textContent).toContain("Uncategorized work");
		expect(epicSection?.textContent).toContain("2 initiatives");
		expect(epicSection?.textContent).toContain("1/2 completed");
		expect(epicSection?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");

		toggle?.click();
		await app.updateComplete;

		expect(epicSection?.querySelector('[data-initiative]')).toBeNull();
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
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
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", projects: [] }), { status: 200 })
		);
		const store = makeStore(config, makeSnapshot());
		const app = await mountApp(store);

		const railItem = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="rail"] [data-tenant="content-hub"]');
		railItem?.click();
		await app.updateComplete;

		expect(store.selectedTenant.get()).toBe("content-hub");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(app.shadowRoot?.querySelector('[data-view="project-chooser"]')).not.toBeNull();
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
				makeEntity({ id: "ADR1", kind: "adr", status: "current", title: "Use cytoscape" }),
				makeEntity({ id: "ADR2", kind: "adr", status: "archived", title: "Adopt signals" })
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
		expect([...app.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-master-section="adrs"]') ?? []].map((button) => button.textContent?.trim())).toEqual([
			"All",
			"Archived",
			"Current"
		]);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-master-section="adrs"][data-master-status="archived"]')?.click();
		await app.updateComplete;

		expect([...app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-id]') ?? []].map((element) => element.getAttribute("data-id"))).toEqual(["ADR2"]);
	});

	it("filters initiatives in the master list by status", async () => {
		const doneInitiative = makeEntity({ id: "INIT_DONE", kind: "initiative", status: "done", title: "Completed work" });
		const activeInitiative = makeEntity({ id: "INIT_ACTIVE", kind: "initiative", status: "active", title: "Current work" });
		const snapshot = makeSnapshot({
			initiatives: [makeBundle(doneInitiative), makeBundle(activeInitiative)]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		expect([...app.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-master-section="initiatives"]') ?? []].map((button) => button.textContent?.trim())).toEqual([
			"All",
			"Active",
			"Done"
		]);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-master-section="initiatives"][data-master-status="done"]')?.click();
		await app.updateComplete;

		expect([...app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-initiative]') ?? []].map((element) => element.getAttribute("data-initiative"))).toEqual(["INIT_DONE"]);
	});

	it("labels a project-scoped ADR as a project-level decision in the ADRs section", async () => {
		const snapshot = makeSnapshot({
			projectAdrs: [makeEntity({ id: "ADR1", kind: "adr", status: "current", title: "Use deterministic SVG" })]
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
					adrs: [makeEntity({ id: "ADR2", kind: "adr", status: "current", title: "Render graphs by hand" })]
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
		expect(subtabs).toEqual(["Overview", "Graph", "Context"]);
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
	it("renders project decisions and project-scoped epic hierarchy nodes only", async () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", title: "Viewer experience" });
		const projectAdr = makeEntity({ id: "ADR2", kind: "adr", title: "Use project snapshots" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", title: "Render graph nodes" });
		const snapshot = makeSnapshot({
			entities: [epic],
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), {
					adrs: [makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" })],
					fixLinks: [{ issue, userStory: story }],
					issues: [issue],
					prds: [makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" })],
					userStories: [story]
				})
			],
			projectAdrs: [projectAdr],
			relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: "INIT1", type: "contains" }]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("graph");
		await app.updateComplete;

		const graph = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(graph).not.toBeNull();
		const nodes = graph?.shadowRoot?.querySelectorAll(".ai-node") ?? [];
		expect([...nodes].map((node) => node.getAttribute("data-id")).sort()).toEqual(["", "ADR1", "ADR2", "EPIC1", "INIT1", "ISS1", "PRD1", "US1"]);
		const filters = app.shadowRoot?.querySelector("agent-issues-relationship-graph-filters");
		expect([...filters?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".graph-kind-chip") ?? []].map((chip) => chip.textContent?.trim())).toEqual([
			"Project",
			"Epic",
			"Initiative",
			"PRD",
			"ADR",
			"User story",
			"Issue"
		]);

		filters?.shadowRoot?.querySelector<HTMLButtonElement>('[data-graph-kind="issue"]')?.click();
		await app.updateComplete;

		const graphWithoutIssues = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(graphWithoutIssues?.shadowRoot?.querySelector('.ai-node[data-id="ISS1"]')).toBeNull();
		expect([...graphWithoutIssues?.shadowRoot?.querySelectorAll<SVGTextElement>(".ai-colhead") ?? []].map((node) => node.textContent?.trim())).not.toContain("Issues");
	});

	it("opens graph nodes while preserving the selected tenant and project route", async () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", title: "Viewer experience" });
		const projectAdr = makeEntity({ id: "ADR2", kind: "adr", title: "Use project snapshots" });
		const snapshot = makeSnapshot({
			entities: [epic, makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" })],
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), {
					prds: [makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" })]
				})
			],
			projectAdrs: [projectAdr],
			relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: "INIT1", type: "contains" }]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("graph");
		await app.updateComplete;

		const graph = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const initiativeNode = graph?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="INIT1"]');
		initiativeNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		expect(store.selectedInitiativeId.get()).toBe("INIT1");
		expect(window.location.hash).toContain("tenant=demo");
		expect(window.location.hash).toContain("project=PROJ1");
		expect(window.location.hash).toContain("initiative=INIT1");

		store.selectSection("graph");
		await app.updateComplete;
		const graphAgain = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const prdNode = graphAgain?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="PRD1"]');
		prdNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		await app.updateComplete;
		expect(store.selectedId.get()).toBe("PRD1");
		expect(window.location.hash).toContain("tenant=demo");
		expect(window.location.hash).toContain("project=PROJ1");
		expect(window.location.hash).toContain("entity=PRD1");
		expect(app.shadowRoot?.querySelector("agent-issues-detail-view")).not.toBeNull();

		store.selectSection("graph");
		await app.updateComplete;
		const graphWithProjectAdr = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const projectAdrNode = graphWithProjectAdr?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="ADR2"]');
		projectAdrNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		await app.updateComplete;
		expect(store.selectedId.get()).toBe("ADR2");
		expect(window.location.hash).toContain("tenant=demo");
		expect(window.location.hash).toContain("project=PROJ1");
		expect(window.location.hash).toContain("entity=ADR2");
		expect(app.shadowRoot?.querySelector("agent-issues-detail-view")).not.toBeNull();

		store.selectSection("graph");
		await app.updateComplete;
		const graphWithEpic = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const epicNode = graphWithEpic?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="EPIC1"]');
		epicNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		expect(store.selectedId.get()).toBe("EPIC1");
		expect(window.location.hash).toContain("tenant=demo");
		expect(window.location.hash).toContain("project=PROJ1");
		expect(window.location.hash).toContain("entity=EPIC1");
	});

	it("opens bundle-only project graph records", async () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", title: "Viewer experience" });
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", title: "Console Viewer" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", title: "Render nodes" });
		const snapshot = makeSnapshot({
			entities: [epic],
			initiatives: [makeBundle(initiative, { adrs: [adr], issues: [issue], prds: [prd], userStories: [story] })],
			relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: initiative.id, type: "contains" }]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		for (const entityId of [prd.id, adr.id, story.id, issue.id]) {
			store.selectSection("graph");
			await app.updateComplete;
			const graph = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
			const node = graph?.shadowRoot?.querySelector<SVGGElement>(`.ai-node[data-id="${entityId}"]`);
			node?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
			await app.updateComplete;

			expect(store.selectedEntity.get()?.id).toBe(entityId);
			expect(window.location.hash).toContain(`entity=${entityId}`);
			expect(app.shadowRoot?.querySelector("agent-issues-detail-view")).not.toBeNull();
		}
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

	it("filters the Initiatives context tab to a selected initiative", async () => {
		const shared = makeSharedContext();
		const analytics = makeEntity({ id: "INIT_ANALYTICS", kind: "initiative", status: "draft", title: "Analytics" });
		const payments = makeEntity({ id: "INIT_PAYMENTS", kind: "initiative", status: "active", title: "Payments" });
		const shipping = makeEntity({ id: "INIT_SHIPPING", kind: "initiative", status: "active", title: "Shipping" });
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
								key: "INIT_PAYMENTS",
								scopeEntityId: "INIT_PAYMENTS",
								scopeKind: "initiative",
								scopeLabel: "Payments",
								summary: "Payments terms.",
								title: "Payments Context",
								updatedAt: null
							},
							terms: [{ avoid: [], createdAt: "", definition: "Captured funds.", term: "Settlement", updatedAt: "" }]
						},
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT_SHIPPING",
								scopeEntityId: "INIT_SHIPPING",
								scopeKind: "initiative",
								scopeLabel: "Shipping",
								summary: "Shipping terms.",
								title: "Shipping Context",
								updatedAt: null
							},
							terms: [{ avoid: [], createdAt: "", definition: "A grouped dispatch.", term: "Shipment batch", updatedAt: "" }]
						}
					]
				},
				initiatives: [makeBundle(analytics), makeBundle(payments), makeBundle(shipping)]
			})
		);
		const app = await mountApp(store);

		store.selectSection("context");
		await app.updateComplete;
		app.shadowRoot?.querySelector<HTMLElement>('[data-context-tab="initiatives"]')?.click();
		await app.updateComplete;

		const initiativeTabs = [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".ctx-initiative-tab") ?? [])];
		expect(initiativeTabs.map((tab) => tab.textContent?.trim())).toEqual([
			"All initiatives",
			"Analytics",
			"Payments",
			"Shipping"
		]);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-context-initiative="INIT_SHIPPING"]')?.click();
		await app.updateComplete;

		const filteredText = app.shadowRoot?.querySelector(".ctx-block")?.textContent ?? "";
		expect(filteredText).toContain("Shipment batch");
		expect(filteredText).not.toContain("Settlement");
	});
});

