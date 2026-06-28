import { afterEach, describe, expect, it } from "vitest";

import "./cascade-view.js";
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

function makeStore(snapshot: Snapshot): AgentIssuesStore {
	const store = new AgentIssuesStore();
	store.connected = true;
	store.snapshot.set(snapshot);
	return store;
}

async function mountCascade(store: AgentIssuesStore) {
	const view = document.createElement("agent-issues-cascade-view") as HTMLElement & {
		store: AgentIssuesStore;
		updateComplete: Promise<unknown>;
	};
	view.store = store;
	document.body.appendChild(view);
	await view.updateComplete;
	return view;
}

afterEach(() => {
	document.body.replaceChildren();
	window.location.hash = "";
});

describe("cascade view columns", () => {
	it("renders one full-document column per id in the cascade path", async () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const issue = makeEntity({ id: "ISS18", kind: "issue", status: "todo", title: "Cascade skeleton" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT4", "ISS18"]);

		const view = await mountCascade(store);

		const columns = view.shadowRoot?.querySelectorAll(".cascade-column");
		expect(columns?.length).toBe(2);
		expect(columns?.[0]?.querySelector("agent-issues-initiative-detail-view")).not.toBeNull();
		expect(columns?.[1]?.querySelector("agent-issues-detail-view")).not.toBeNull();
	});

	it("drills into the next column when a child reference inside a column is clicked", async () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const issue = makeEntity({ id: "ISS18", kind: "issue", status: "todo", title: "Cascade skeleton" });
		const story = makeEntity({ id: "US18", kind: "userStory", status: "ready", title: "Drill the lineage as columns" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue, story],
			initiatives: [makeBundle(initiative, { issues: [issue], userStories: [story] })],
			relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ISS18", toId: "US18", type: "fixes" }]
		});
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT4", "ISS18"]);

		const view = await mountCascade(store);

		const secondColumn = view.shadowRoot?.querySelectorAll(".cascade-column")[1];
		const issueView = secondColumn?.querySelector("agent-issues-detail-view") as HTMLElement & { updateComplete: Promise<unknown> };
		await issueView.updateComplete;
		const ref = issueView.shadowRoot?.querySelector<HTMLButtonElement>(".ai-ref");
		ref?.click();
		await view.updateComplete;

		expect(store.cascadePath.get()).toEqual(["INIT4", "ISS18", "US18"]);
	});

	it("drills from the initiative column when a child reference is clicked", async () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const story = makeEntity({ id: "US18", kind: "userStory", status: "ready", title: "Drill the lineage as columns" });
		const issue = makeEntity({ id: "ISS18", kind: "issue", status: "todo", title: "Cascade skeleton" });
		const snapshot = makeSnapshot({
			entities: [initiative, story, issue],
			initiatives: [
				makeBundle(initiative, {
					fixLinks: [{ issue, userStory: story }],
					issues: [issue],
					userStories: [story]
				})
			]
		});
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT4"]);

		const view = await mountCascade(store);

		const firstColumn = view.shadowRoot?.querySelectorAll(".cascade-column")[0];
		const initiativeView = firstColumn?.querySelector("agent-issues-initiative-detail-view") as HTMLElement & {
			updateComplete: Promise<unknown>;
		};
		await initiativeView.updateComplete;
		const storyHead = initiativeView.shadowRoot?.querySelector<HTMLButtonElement>(".story-head");
		storyHead?.click();
		await view.updateComplete;

		expect(store.cascadePath.get()).toEqual(["INIT4", "US18"]);
		const columnIdsAfterDrill = [...(view.shadowRoot?.querySelectorAll(".cascade-column") ?? [])].map((column) =>
			column.getAttribute("data-column-id")
		);
		expect(columnIdsAfterDrill).toEqual(["INIT4", "US18"]);
	});

	it("opens a constrained issue when its reference is clicked inside an ADR column", async () => {
		const initiative = makeEntity({ id: "INIT3", kind: "initiative", status: "active", title: "Design documents" });
		const adr = makeEntity({ id: "ADR3", kind: "adr", status: "accepted", title: "Dedicated design table" });
		const story = makeEntity({ id: "US15", kind: "userStory", status: "ready", title: "Author design documents" });
		const issue = makeEntity({ id: "ISS12", kind: "issue", status: "todo", title: "Primary design tracer bullet" });
		const snapshot = makeSnapshot({
			entities: [initiative, adr, story, issue],
			initiatives: [makeBundle(initiative, { adrs: [adr], issues: [issue], userStories: [story] })],
			relations: [
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "INIT3", toId: "ADR3", type: "records" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ADR3", toId: "ISS12", type: "constrains" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "INIT3", toId: "ISS12", type: "tracks" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ISS12", toId: "US15", type: "fixes" }
			]
		});
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT3", "ADR3"]);

		const view = await mountCascade(store);

		const adrColumn = view.shadowRoot?.querySelectorAll(".cascade-column")[1];
		const adrView = adrColumn?.querySelector("agent-issues-detail-view") as HTMLElement & { updateComplete: Promise<unknown> };
		await adrView.updateComplete;
		const ref = adrView.shadowRoot?.querySelector<HTMLButtonElement>('.ai-ref[data-id="ISS12"]');
		expect(ref).not.toBeNull();
		ref?.click();
		await view.updateComplete;

		expect(store.cascadePath.get()).toEqual(["INIT3", "ADR3", "ISS12"]);
		expect(store.reRootTrail.get()).toEqual([]);
	});
});

describe("persistent lineage breadcrumb", () => {
	function makeLineageStore() {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const prd = makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" });
		const story = makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" });
		const issue = makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" });
		const snapshot = makeSnapshot({ entities: [initiative, prd, story, issue] });
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);
		store.cascadeAvailableWidth.set(1000);
		return store;
	}

	it("renders one crumb per record in the full path with the leaf highlighted, even when every column fits", async () => {
		const store = makeLineageStore();
		store.cascadeAvailableWidth.set(5000);

		const view = await mountCascade(store);

		const columnIds = [...(view.shadowRoot?.querySelectorAll(".cascade-column") ?? [])].map((column) =>
			column.getAttribute("data-column-id")
		);
		const crumbIds = [...(view.shadowRoot?.querySelectorAll(".cascade-crumb") ?? [])].map((crumb) =>
			crumb.getAttribute("data-id")
		);
		const currentCrumb = view.shadowRoot?.querySelector(".cascade-crumb.is-current");

		expect(columnIds).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
		expect(crumbIds).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
		expect(currentCrumb?.getAttribute("data-id")).toBe("ISS18");
	});

	it("truncates the path to the clicked ancestor crumb, dropping the deeper columns", async () => {
		const store = makeLineageStore();

		const view = await mountCascade(store);

		expect([...(view.shadowRoot?.querySelectorAll(".cascade-column") ?? [])].map((column) => column.getAttribute("data-column-id"))).toEqual([
			"US18",
			"ISS18"
		]);

		const crumb = view.shadowRoot?.querySelector<HTMLButtonElement>('.cascade-crumb[data-id="PRD4"]');
		crumb?.click();
		await view.updateComplete;

		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4"]);
		const columnIds = [...(view.shadowRoot?.querySelectorAll(".cascade-column") ?? [])].map((column) =>
			column.getAttribute("data-column-id")
		);
		const crumbIds = [...(view.shadowRoot?.querySelectorAll(".cascade-crumb") ?? [])].map((crumb) =>
			crumb.getAttribute("data-id")
		);
		const currentCrumb = view.shadowRoot?.querySelector(".cascade-crumb.is-current");

		expect(columnIds).toEqual(["INIT4", "PRD4"]);
		expect(crumbIds).toEqual(["INIT4", "PRD4"]);
		expect(currentCrumb?.getAttribute("data-id")).toBe("PRD4");
	});
});

describe("cascade lineage connectors", () => {
	it("renders a labeled seam between adjacent columns naming the relation for that hop", async () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const prd = makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" });
		const story = makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" });
		const issue = makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" });
		const snapshot = makeSnapshot({
			entities: [initiative, prd, story, issue],
			relations: [
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "INIT4", toId: "PRD4", type: "owns" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "PRD4", toId: "US18", type: "creates" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ISS18", toId: "US18", type: "fixes" }
			]
		});
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);

		const view = await mountCascade(store);

		const connectorLabels = [...(view.shadowRoot?.querySelectorAll(".cascade-connector") ?? [])].map((seam) =>
			seam.textContent?.trim()
		);
		expect(connectorLabels).toEqual(["owns", "creates", "fixes"]);
	});
});

describe("cascade source-reference highlight", () => {
	it("highlights the originating reference in the parent column when its child column is open", async () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const story = makeEntity({ id: "US18", kind: "userStory", status: "ready", title: "Drill the lineage as columns" });
		const snapshot = makeSnapshot({
			entities: [initiative, story],
			initiatives: [makeBundle(initiative, { userStories: [story] })]
		});
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT4", "US18"]);

		const view = await mountCascade(store);

		const firstColumn = view.shadowRoot?.querySelectorAll(".cascade-column")[0];
		const initiativeView = firstColumn?.querySelector("agent-issues-initiative-detail-view") as HTMLElement & {
			updateComplete: Promise<unknown>;
		};
		await initiativeView.updateComplete;
		const storyHead = initiativeView.shadowRoot?.querySelector<HTMLButtonElement>('.story-head[data-id="US18"]');
		expect(storyHead?.classList.contains("is-active-ref")).toBe(true);
	});
});

describe("lineage breadcrumb branch control", () => {
	function makeBranchingStore(): AgentIssuesStore {
		const snapshot = makeSnapshot({
			entities: [
				makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" }),
				makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Other initiative" }),
				makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" }),
				makeEntity({ id: "PRD2", kind: "prd", title: "Other PRD" }),
				makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" }),
				makeEntity({ id: "US40", kind: "userStory", title: "Other story" }),
				makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" })
			],
			relations: [
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "INIT4", toId: "PRD4", type: "owns" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "INIT2", toId: "PRD2", type: "owns" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "PRD4", toId: "US18", type: "creates" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "PRD2", toId: "US40", type: "creates" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ISS18", toId: "US18", type: "fixes" },
				{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ISS18", toId: "US40", type: "fixes" }
			]
		});
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);
		return store;
	}

	it("marks the forking crumb with a fork badge showing the current position, and no badge on other crumbs", async () => {
		const store = makeBranchingStore();

		const view = await mountCascade(store);

		const toggles = [...(view.shadowRoot?.querySelectorAll(".crumb-fork-toggle") ?? [])];
		expect(toggles.length).toBe(1);
		expect(toggles[0]?.textContent).toContain("1/2");
		expect(view.shadowRoot?.querySelector(".crumb-fork-menu")).toBeNull();
		expect(view.shadowRoot?.querySelector("select")).toBeNull();
	});

	it("opens a custom variant menu listing the variants by title with the current one selected", async () => {
		const store = makeBranchingStore();

		const view = await mountCascade(store);

		const toggle = view.shadowRoot?.querySelector<HTMLButtonElement>(".crumb-fork-toggle");
		toggle?.click();
		await view.updateComplete;

		const options = [...(view.shadowRoot?.querySelectorAll(".crumb-fork-option") ?? [])];
		expect(options.map((option) => option.getAttribute("data-story-id"))).toEqual(["US18", "US40"]);
		expect(options.map((option) => option.textContent?.replace(/\s+/g, " ").trim())).toEqual([
			"✓ Drill the lineage",
			"Other story"
		]);
		const selected = view.shadowRoot?.querySelector(".crumb-fork-option.is-selected");
		expect(selected?.getAttribute("data-story-id")).toBe("US18");
	});

	it("re-derives the lineage toward the root when a variant is chosen and closes the menu", async () => {
		const store = makeBranchingStore();

		const view = await mountCascade(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>(".crumb-fork-toggle")?.click();
		await view.updateComplete;

		const other = [...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>(".crumb-fork-option") ?? [])].find(
			(option) => option.getAttribute("data-story-id") === "US40"
		);
		other?.click();
		await view.updateComplete;

		expect(store.cascadePath.get()).toEqual(["INIT2", "PRD2", "US40", "ISS18"]);
		expect(view.shadowRoot?.querySelector(".crumb-fork-menu")).toBeNull();
	});

	it("keeps the connector seam a plain relation label at the branching hop", async () => {
		const store = makeBranchingStore();

		const view = await mountCascade(store);

		expect(view.shadowRoot?.querySelector(".cascade-branch")).toBeNull();
		const connectorLabels = [...(view.shadowRoot?.querySelectorAll(".cascade-connector") ?? [])].map((seam) =>
			seam.textContent?.trim()
		);
		expect(connectorLabels).toEqual(["owns", "creates", "fixes"]);
	});
});

describe("re-root trail strip", () => {
	function makeTrailStore(): AgentIssuesStore {
		const snapshot = makeSnapshot({
			entities: [
				makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" }),
				makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" }),
				makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" }),
				makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" }),
				makeEntity({ id: "ISS30", kind: "issue", title: "Another issue" }),
				makeEntity({ id: "ISS40", kind: "issue", title: "Cross-linked issue" })
			]
		});
		const store = makeStore(snapshot);
		store.reRootTrail.set([
			["INIT4", "PRD4", "US18", "ISS18"],
			["INIT4", "ISS30"]
		]);
		store.cascadePath.set(["ISS40"]);
		return store;
	}

	it("renders one chip per stack left behind, newest on the right, labeled by its latest context", async () => {
		const store = makeTrailStore();

		const view = await mountCascade(store);

		const chipIds = [...(view.shadowRoot?.querySelectorAll(".re-root-chip") ?? [])].map((chip) => chip.textContent?.trim());
		expect(chipIds).toEqual(["ISS18", "ISS30"]);
	});

	it("restores the whole stack when a chip is clicked", async () => {
		const store = makeTrailStore();

		const view = await mountCascade(store);

		const firstChip = view.shadowRoot?.querySelector<HTMLButtonElement>(".re-root-chip");
		firstChip?.click();
		await view.updateComplete;

		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
		expect(store.reRootTrail.get()).toEqual([]);
	});
});




