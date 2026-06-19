import { describe, expect, it } from "vitest";

import type { Entity, InitiativeBundle, Snapshot } from "../models.js";
import { AgentIssuesStore } from "./agent-issues-store.js";

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

describe("initiative relationship graph model", () => {
	it("lays the initiative, its PRDs/ADRs, stories, and issues into ordered columns", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "done", title: "Render nodes" });
		const bundle = makeBundle(initiative, {
			adrs: [adr],
			fixLinks: [{ issue, userStory: story }],
			issues: [issue],
			prds: [prd],
			userStories: [story]
		});
		const store = new AgentIssuesStore();

		const graph = store.buildInitiativeGraph(bundle);

		expect(graph.columns).toEqual(["Initiative", "PRDs & ADRs", "User stories", "Issues"]);
		const nodeColumns = new Map(graph.nodes.map((node) => [node.id, node.col]));
		expect(nodeColumns.get("INIT1")).toBe(0);
		expect(nodeColumns.get("PRD1")).toBe(1);
		expect(nodeColumns.get("ADR1")).toBe(1);
		expect(nodeColumns.get("US1")).toBe(2);
		expect(nodeColumns.get("ISS1")).toBe(3);
	});

	it("connects each issue to the user story it fixes", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render nodes" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue, userStory: story }],
			issues: [issue],
			userStories: [story]
		});
		const store = new AgentIssuesStore();

		const graph = store.buildInitiativeGraph(bundle);

		expect(graph.edges).toContainEqual({ from: "US1", to: "ISS1" });
	});
});

describe("project relationship graph model", () => {
	it("lays the project, its initiatives, and their PRDs/ADRs into ordered columns", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" });
		const bundle = makeBundle(initiative, { adrs: [adr], prds: [prd] });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("content-hub");
		store.snapshot.set(makeSnapshot({ initiatives: [bundle] }));

		const graph = store.buildProjectGraph();

		expect(graph.columns).toEqual(["Project", "Initiatives", "PRDs & ADRs"]);
		const projectNode = graph.nodes.find((node) => node.kind === "project");
		expect(projectNode?.col).toBe(0);
		const nodeColumns = new Map(graph.nodes.map((node) => [node.id, node.col]));
		expect(nodeColumns.get("INIT1")).toBe(1);
		expect(nodeColumns.get("PRD1")).toBe(2);
		expect(nodeColumns.get("ADR1")).toBe(2);
	});

	it("connects the project to each initiative and each initiative to its PRDs and ADRs", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const bundle = makeBundle(initiative, { prds: [prd] });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("content-hub");
		store.snapshot.set(makeSnapshot({ initiatives: [bundle] }));

		const graph = store.buildProjectGraph();
		const projectNode = graph.nodes.find((node) => node.kind === "project");

		expect(graph.edges).toContainEqual({ from: projectNode?.key, to: "INIT1" });
		expect(graph.edges).toContainEqual({ from: "INIT1", to: "INIT1:PRD1" });
	});
});

describe("project context discovery", () => {
	it("groups shared and initiative-scoped terms and flags duplicates", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				contexts: {
					shared: {
						context: {
							createdAt: null,
							exists: true,
							key: "default",
							scopeEntityId: null,
							scopeKind: "default",
							scopeLabel: "Shared",
							summary: "Project language.",
							title: "Shared Context",
							updatedAt: null
						},
						terms: [{ avoid: [], createdAt: "", definition: "Canonical order.", term: "Order", updatedAt: "" }]
					},
					initiatives: [
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT1",
								scopeEntityId: "INIT1",
								scopeKind: "initiative",
								scopeLabel: "Payments",
								summary: "Payments terms.",
								title: "Payments Context",
								updatedAt: null
							},
							terms: [
								{ avoid: [], createdAt: "", definition: "Payment-specific order.", term: "Order", updatedAt: "" },
								{ avoid: [], createdAt: "", definition: "Captured funds.", term: "Settlement", updatedAt: "" }
							]
						}
					]
				}
			})
		);

		const entries = store.projectContextTerms.get();
		expect(entries.map((entry) => entry.term)).toEqual(["Order", "Settlement"]);

		const order = entries.find((entry) => entry.term === "Order");
		expect(order?.hasDuplicates).toBe(true);
		expect(order?.hasSharedSource).toBe(true);
		expect(order?.hasConflictingDefinitions).toBe(true);
		expect(order?.sources.map((source) => source.scopeLabel)).toEqual(["Shared", "Payments"]);
	});
});
