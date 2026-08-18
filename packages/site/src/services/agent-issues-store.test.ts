import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity, InitiativeBundle, Relation, Snapshot } from "../models.js";
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

function stubEventSource(): void {
	vi.stubGlobal(
		"EventSource",
		class {
			public close() {}
		}
	);
}

beforeEach(() => {
	stubEventSource();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("short entity references", () => {
	it("separates the kind prefix from the display code", () => {
		const store = new AgentIssuesStore();

		expect(store.shortRef({ id: "issue-identifier", kind: "issue" })).toMatch(/^ISS_[0-9A-HJKMNP-TV-Z]{6}$/);
	});
});

describe("debt records", () => {
		it("defaults to open debt records", () => {
			const openDebt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Replace legacy storage" });
			const resolvedDebt = makeEntity({ id: "DEBT2", kind: "debt", status: "resolved", title: "Remove temporary endpoint" });
			const store = new AgentIssuesStore();
			store.snapshot.set(makeSnapshot({ entities: [openDebt, resolvedDebt] }));

			expect(store.debtRecords.get()).toEqual([openDebt]);
		});

		it("combines lifecycle, category, and priority filters", () => {
			const matchingDebt = makeEntity({ category: "technical", id: "DEBT1", kind: "debt", priority: "high", status: "open" });
			const categoryMismatch = makeEntity({ category: "process", id: "DEBT2", kind: "debt", priority: "high", status: "open" });
			const priorityMismatch = makeEntity({ category: "technical", id: "DEBT3", kind: "debt", priority: "low", status: "open" });
			const lifecycleMismatch = makeEntity({ category: "technical", id: "DEBT4", kind: "debt", priority: "high", status: "resolved" });
			const store = new AgentIssuesStore();
			store.snapshot.set(makeSnapshot({ entities: [matchingDebt, categoryMismatch, priorityMismatch, lifecycleMismatch] }));

			store.setDebtFilter("category", "technical");
			store.setDebtFilter("priority", "high");

			expect(store.debtRecords.get()).toEqual([matchingDebt]);
		});
});

describe("initiative relationship graph model", () => {
	it("uses in-force and archived tones for ADR lifecycle states", () => {
		const store = new AgentIssuesStore();

		expect(store.statusTone("current")).toBe("success");
		expect(store.badgeTone("current")).toBe("success");
		expect(store.statusTone("archived")).toBe("neutral");
		expect(store.badgeTone("archived")).toBe("neutral");
	});

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

		expect(graph.columns).toEqual(["Initiative", "Plans, PRDs & ADRs", "User stories", "Issues", "Debt records"]);
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

	it("shows sub-issues in later columns and connects parent issues to them", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Sub-issue" });
		const bundle = makeBundle(initiative, {
			issues: [parentIssue, subIssue],
			subIssueLinks: [{ issue: subIssue, parent: parentIssue }]
		});
		const store = new AgentIssuesStore();

		const graph = store.buildInitiativeGraph(bundle);

		expect(graph.columns).toEqual(["Initiative", "Plans, PRDs & ADRs", "User stories", "Issues", "Sub-issues", "Debt records"]);
		const nodeColumns = new Map(graph.nodes.map((node) => [node.id, node.col]));
		expect(nodeColumns.get("ISS1")).toBe(3);
		expect(nodeColumns.get("ISS2")).toBe(4);
		expect(graph.edges).toContainEqual({ from: "INIT1", to: "ISS1" });
		expect(graph.edges).toContainEqual({ from: "ISS1", to: "ISS2" });
	});

	it("renders initiative-owned debt with its ownership relation", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const debt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Replace legacy storage" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, debt],
				initiatives: [makeBundle(initiative)],
				relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: debt.id, type: "records" }]
			})
		);

		const graph = store.buildInitiativeGraph(makeBundle(initiative));

		expect(graph.columns).toEqual(["Initiative", "Plans, PRDs & ADRs", "User stories", "Issues", "Debt records"]);
		expect(graph.nodes).toContainEqual(
			expect.objectContaining({ col: 4, id: debt.id, kind: "debt", label: debt.title })
		);
		expect(graph.edges).toContainEqual({ from: initiative.id, label: "records", to: debt.id });
	});

	it("renders debt remediation and context links within the initiative graph", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Replace storage" });
		const debt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Retire legacy storage" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, issue, debt],
				initiatives: [makeBundle(initiative, { issues: [issue] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: debt.id, type: "records" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: issue.id, toId: debt.id, type: "resolves" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: debt.id, toId: issue.id, type: "relatesTo" }
				]
			})
		);

		const graph = store.buildInitiativeGraph(makeBundle(initiative, { issues: [issue] }));

		expect(graph.edges).toEqual(
			expect.arrayContaining([
				{ from: issue.id, label: "resolves", to: debt.id },
				{ from: debt.id, label: "relatesTo", to: issue.id }
			])
		);
	});
});

describe("project relationship graph model", () => {
	it("lays project decisions beneath the project and work beneath each epic", () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", status: "active", title: "Viewer experience" });
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const plan = makeEntity({ id: "PLAN1", kind: "plan", status: "ready", title: "Viewer implementation plan" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const initiativeAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render graph nodes" });
		const projectAdr = makeEntity({ id: "ADR2", kind: "adr", title: "Use project snapshots" });
		const bundle = makeBundle(initiative, { adrs: [initiativeAdr], entities: [initiative, plan, prd, initiativeAdr, story, issue], fixLinks: [{ issue, userStory: story }], issues: [issue], prds: [prd], userStories: [story] });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("content-hub");
		store.selectedProjectId.set("PROJ1");
		store.snapshot.set(
			makeSnapshot({
				entities: [epic],
				initiatives: [bundle],
				projectAdrs: [projectAdr],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: initiative.id, type: "contains" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: plan.id, toId: prd.id, type: "informs" }
				]
			})
		);

		const graph = store.buildProjectGraph();

		expect(graph.columns).toEqual(["Project", "Epics", "Initiatives", "Plans, PRDs & ADRs", "User stories", "Issues"]);
		const projectNode = graph.nodes.find((node) => node.kind === "project");
		expect(projectNode?.col).toBe(0);
		const nodeColumns = new Map(graph.nodes.map((node) => [node.id, node.col]));
		expect(nodeColumns.get("EPIC1")).toBe(1);
		expect(nodeColumns.get("INIT1")).toBe(2);
		expect(nodeColumns.get("PLAN1")).toBe(3);
		expect(nodeColumns.get("PRD1")).toBe(3);
		expect(nodeColumns.get("ADR1")).toBe(3);
		expect(nodeColumns.get("ADR2")).toBe(1);
		expect(nodeColumns.get("US1")).toBe(4);
		expect(nodeColumns.get("ISS1")).toBe(5);
		expect(graph.edges).toContainEqual({ from: projectNode?.key, to: "EPIC1" });
		expect(graph.edges).toContainEqual({ from: "EPIC1", to: "INIT1" });
		expect(graph.edges).toContainEqual({ from: "INIT1", to: "INIT1:PLAN1" });
		expect(graph.edges).toContainEqual({ from: "INIT1:PLAN1", label: "informs", to: "INIT1:PRD1" });
		expect(graph.edges).toContainEqual({ from: projectNode?.key, to: "ADR2" });
		expect(graph.edges).toContainEqual({ from: "INIT1:US1", to: "INIT1:ISS1" });

		store.toggleProjectGraphKind("issue");
		const graphWithoutIssues = store.buildProjectGraph();
		expect(graphWithoutIssues.columns).toEqual(["Project", "Epics", "Initiatives", "Plans, PRDs & ADRs", "User stories"]);
		expect(graphWithoutIssues.nodes.map((node) => node.id)).not.toContain("ISS1");
		expect(graphWithoutIssues.edges).not.toContainEqual({ from: "INIT1:US1", to: "INIT1:ISS1" });
	});

	it("connects the project to each epic, epics to initiatives, and initiatives to their records", () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", status: "active", title: "Viewer experience" });
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const bundle = makeBundle(initiative, { prds: [prd] });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("content-hub");
		store.snapshot.set(
			makeSnapshot({
				entities: [epic],
				initiatives: [bundle],
				relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: initiative.id, type: "contains" }]
			})
		);

		const graph = store.buildProjectGraph();
		const projectNode = graph.nodes.find((node) => node.kind === "project");

		expect(graph.edges).toContainEqual({ from: projectNode?.key, to: "EPIC1" });
		expect(graph.edges).toContainEqual({ from: "EPIC1", to: "INIT1" });
		expect(graph.edges).toContainEqual({ from: "INIT1", to: "INIT1:PRD1" });
	});

	it("renders debt ownership, remediation, and context links", () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", status: "active", title: "Viewer experience" });
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Replace storage" });
		const debt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Retire legacy storage" });
		const store = new AgentIssuesStore();
		store.selectedProjectId.set("PROJ1");
		store.snapshot.set(
			makeSnapshot({
				entities: [epic, initiative, issue, debt],
				initiatives: [makeBundle(initiative, { issues: [issue] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: initiative.id, type: "contains" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: debt.id, type: "records" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: issue.id, toId: debt.id, type: "resolves" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: debt.id, toId: issue.id, type: "relatesTo" }
				]
			})
		);

		const graph = store.buildProjectGraph();

		expect(graph.columns).toContain("Debt records");
		expect(graph.nodes).toContainEqual(
			expect.objectContaining({ col: graph.columns.indexOf("Debt records"), id: debt.id, kind: "debt", label: debt.title })
		);
		expect(graph.edges).toEqual(
			expect.arrayContaining([
				{ from: initiative.id, label: "records", to: debt.id },
				{ from: `${initiative.id}:${issue.id}`, label: "resolves", to: debt.id },
				{ from: debt.id, label: "relatesTo", to: `${initiative.id}:${issue.id}` }
			])
		);
	});

	it("filters debt and its edges from the project graph", () => {
		const debt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Retire legacy storage" });
		const store = new AgentIssuesStore();
		store.selectedProjectId.set("PROJ1");
		store.snapshot.set(
			makeSnapshot({
				entities: [debt],
				relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "PROJ1", toId: debt.id, type: "records" }]
			})
		);

		store.toggleProjectGraphKind("debt");
		const graph = store.buildProjectGraph();

		expect(graph.nodes.map((node) => node.kind)).not.toContain("debt");
		expect(graph.edges).not.toContainEqual(expect.objectContaining({ label: "records", to: debt.id }));
	});
});

describe("project context discovery", () => {
	it("includes child sub-issues beneath a fixing parent issue in a story tree", () => {
		const store = new AgentIssuesStore();
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

		const tree = store.issueTreeForStory(bundle, story.id);

		expect(tree).toHaveLength(1);
		expect(tree[0]?.issue.id).toBe("ISS1");
		expect(tree[0]?.children.map((node) => node.issue.id)).toEqual(["ISS2"]);
	});

	it("labels decomposed issues as sub-issues and parent issues in linked sections", () => {
		const store = new AgentIssuesStore();
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", title: "Sub-issue" });

		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, parentIssue, subIssue],
				initiatives: [makeBundle(initiative, { issues: [parentIssue, subIssue] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: parentIssue.id, type: "tracks" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: parentIssue.id, toId: subIssue.id, type: "decomposes" }
				]
			})
		);

		store.selectedId.set(parentIssue.id);
		expect(store.linkedRecordSections().map((section) => section.title)).toContain("Sub-issues");

		store.selectedId.set(subIssue.id);
		expect(store.linkedRecordSections().map((section) => section.title)).toContain("Parent issue");
	});

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

describe("id-driven detail resolution", () => {
	it("resolves the owning bundle for an arbitrary entity id without using the selection", () => {
		const firstInitiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const secondInitiative = makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Status derivation" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [firstInitiative, secondInitiative, issue],
				initiatives: [
					makeBundle(firstInitiative),
					makeBundle(secondInitiative, { issues: [issue] })
				]
			})
		);

		const bundle = store.bundleForEntityId("ISS9");

		expect(bundle?.initiative.id).toBe("INIT2");
		expect(store.selectedId.get()).toBeNull();
	});
});

describe("id-driven relations resolution", () => {
	it("resolves outgoing and incoming relations for an arbitrary id without using the selection", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", title: "Wire detail" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, story, issue],
				initiatives: [makeBundle(initiative, { issues: [issue], userStories: [story] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ISS9", toId: "US1", type: "fixes" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "INIT1", toId: "ISS9", type: "tracks" }
				]
			})
		);

		expect(store.outgoingRelationsFor("ISS9").map((relation) => relation.toId)).toEqual(["US1"]);
		expect(store.incomingRelationsFor("ISS9").map((relation) => relation.fromId)).toEqual(["INIT1"]);
		expect(store.selectedId.get()).toBeNull();
	});
});

describe("id-driven linked record sections", () => {
	it("groups linked records for an arbitrary id without using the selection", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", title: "Sub-issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, parentIssue, subIssue],
				initiatives: [makeBundle(initiative, { issues: [parentIssue, subIssue] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "INIT1", toId: "ISS1", type: "tracks" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ISS1", toId: "ISS2", type: "decomposes" }
				]
			})
		);

		const titles = store.linkedRecordSectionsFor("ISS1").map((section) => section.title);

		expect(titles).toContain("Sub-issues");
		expect(store.selectedId.get()).toBeNull();
	});
});

describe("id-driven detail meta", () => {
	it("builds meta naming the owning initiative for an arbitrary id without using the selection", () => {
		const initiative = makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Status derivation" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire detail" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, issue],
				initiatives: [makeBundle(initiative, { issues: [issue] })]
			})
		);

		const meta = new Map(store.detailMetaFor("ISS9"));

		expect(meta.get("Initiative")).toBe(`${store.shortRef(initiative)} Status derivation`);
		expect(meta.get("Status")).toBe("todo");
		expect(store.selectedId.get()).toBeNull();
	});
});

describe("id-driven initiative bundle", () => {
	it("resolves an initiative bundle for an arbitrary initiative id without using the selection", () => {
		const firstInitiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const secondInitiative = makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Status derivation" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [firstInitiative, secondInitiative],
				initiatives: [makeBundle(firstInitiative), makeBundle(secondInitiative)]
			})
		);

		const bundle = store.bundleForInitiativeId("INIT2");

		expect(bundle?.initiative.id).toBe("INIT2");
		expect(store.selectedInitiativeId.get()).toBeNull();
	});
});

describe("cascade path model", () => {
	it("opens a cascade rooted at an id and derives that single column", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative], initiatives: [makeBundle(initiative)] }));

		store.openCascade("INIT4");

		expect(store.cascadePath.get()).toEqual(["INIT4"]);
		expect(store.cascadeColumns.get().map((entity) => entity.id)).toEqual(["INIT4"]);
	});

	it("derives an ordered column per id in the cascade path", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const issue = makeEntity({ id: "ISS18", kind: "issue", status: "todo", title: "Cascade skeleton" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, issue],
				initiatives: [makeBundle(initiative, { issues: [issue] })]
			})
		);

		store.cascadePath.set(["INIT4", "ISS18"]);

		expect(store.cascadeColumns.get().map((entity) => entity.id)).toEqual(["INIT4", "ISS18"]);
	});

	it("extends the path and truncates anything to the right when drilling a child", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot());

		store.cascadePath.set(["INIT4", "PRD4", "US18"]);
		store.drillCascade("INIT4", "ISS18");

		expect(store.cascadePath.get()).toEqual(["INIT4", "ISS18"]);
	});

	it("appends a child when drilling from the current leaf", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot());

		store.cascadePath.set(["INIT4", "PRD4"]);
		store.drillCascade("PRD4", "US18");

		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4", "US18"]);
	});
});

describe("cascade URL round-trip", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	it("encodes the cascade path into the URL when opening and drilling", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot());

		store.openCascade("INIT4");
		store.drillCascade("INIT4", "ISS18");

		expect(window.location.hash).toContain("cascade=INIT4~ISS18");
	});

	it("restores the cascade path from the URL on hash change", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot());
		window.location.hash = "cascade=INIT4~ISS18";

		store.onHashChange();

		expect(store.cascadePath.get()).toEqual(["INIT4", "ISS18"]);
	});
});

describe("tenant and project route scope", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	it("opens tenant-only hash links in project chooser scope", () => {
		const store = new AgentIssuesStore();
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		window.location.hash = "tenant=demo";

		store.onHashChange();

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(store.selectedId.get()).toBeNull();
		expect(window.location.hash).toBe("#tenant=demo");
	});

	it("preserves tenant and project while removing unavailable detail route keys", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [makeEntity({ id: "ISS1" })] }));
		window.location.hash = "tenant=demo&project=PROJ1&entity=ISS2&initiative=INIT2&cascade=INIT2~ISS2";

		store.onHashChange();

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBe("PROJ1");
		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.cascadePath.get()).toEqual([]);
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1");
	});

	it("migrates legacy tenant query links and existing detail hashes into the shared hash route", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [makeEntity({ id: "ISS1" })] }));
		window.history.replaceState({}, "", "?tenant=demo#entity=ISS1");

		store.onHashChange();

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedId.get()).toBe("ISS1");
		expect(window.location.search).toBe("");
		expect(window.location.hash).toBe("#tenant=demo&entity=ISS1");
	});

	it("clears project and all detail when the viewer chooses another tenant", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		store.selectedInitiativeId.set("INIT1");
		store.cascadePath.set(["INIT1", "ISS1"]);
		store.reRootTrail.set([["INIT1", "ISS1"]]);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", projects: [] }), { status: 200 })
		);

		await store.selectTenant("content-hub");

		expect(store.selectedTenant.get()).toBe("content-hub");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.cascadePath.get()).toEqual([]);
		expect(store.reRootTrail.get()).toEqual([]);
		expect(store.activeSection.get()).toBe("initiatives");
		expect(window.location.hash).toBe("#tenant=content-hub");
		fetchMock.mockRestore();
	});

	it("loads an explicitly selected project after clearing previous detail", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		store.selectedInitiativeId.set("INIT1");
		store.cascadePath.set(["INIT1", "ISS1"]);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot() }), { status: 200 })
		);

		await store.selectProject("PROJ2");

		expect(store.selectedProjectId.get()).toBe("PROJ2");
		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.cascadePath.get()).toEqual([]);
		expect(store.activeSection.get()).toBe("initiatives");
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ2");
		fetchMock.mockRestore();
	});

	it("retains the tenant chooser when an explicitly selected project is unavailable", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "unavailable" }), { status: 200 })
		);

		await store.selectProject("PROJ404");

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(store.syncLabel.get()).toBe("project unavailable");
		expect(window.location.hash).toBe("#tenant=demo");
		fetchMock.mockRestore();
	});

	it("reloads a project hash navigation after discarding prior detail scope", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		store.selectedInitiativeId.set("INIT1");
		store.cascadePath.set(["INIT1", "ISS1"]);
		window.location.hash = "tenant=demo&project=PROJ2&entity=ISS2";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot() }), { status: 200 })
		);

		await store.onBrowserNavigation();

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBe("PROJ2");
		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.cascadePath.get()).toEqual([]);
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ2");
		fetchMock.mockRestore();
	});

	it("reloads tenant and project scope when browser history changes", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		window.location.hash = "tenant=content-hub&project=PROJ2";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot() }), { status: 200 })
		);

		await store.onPopState();

		expect(store.selectedTenant.get()).toBe("content-hub");
		expect(store.selectedProjectId.get()).toBe("PROJ2");
		expect(store.selectedId.get()).toBeNull();
		expect(window.location.hash).toBe("#tenant=content-hub&project=PROJ2");
		fetchMock.mockRestore();
	});

	it("keeps an unavailable tenant in route state until the viewer chooses a replacement", () => {
		const store = new AgentIssuesStore();
		store.config.set({
			availableTenants: [{ displayName: "Demo", id: "demo" }],
			currentTenant: "demo",
			dbPath: "/tmp/agent-issues.db"
		});
		window.location.hash = "tenant=missing";

		store.onHashChange();

		expect(store.selectedTenant.get()).toBe("missing");
		expect(store.tenantOptions.get().map((tenant) => tenant.id)).toEqual(["demo", "missing"]);
		expect(window.location.hash).toBe("#tenant=missing");
	});
});

describe("epic section state", () => {
	it("keeps collapse state per selected project while a newly selected project starts expanded", () => {
		const store = new AgentIssuesStore();
		store.selectedProjectId.set("PROJ1");

		expect(store.isEpicExpanded("EPIC1")).toBe(true);
		store.toggleEpicExpanded("EPIC1");
		expect(store.isEpicExpanded("EPIC1")).toBe(false);

		store.selectedProjectId.set("PROJ2");
		expect(store.isEpicExpanded("EPIC1")).toBe(true);
		store.toggleEpicExpanded("EPIC2");
		expect(store.isEpicExpanded("EPIC2")).toBe(false);

		store.selectedProjectId.set("PROJ1");
		expect(store.isEpicExpanded("EPIC1")).toBe(false);
		expect(store.isEpicExpanded("EPIC2")).toBe(true);
	});
});

describe("deep-leaf ancestry derivation", () => {
	function makeRelation(fromId: string, type: string, toId: string): Relation {
		return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
	}

	it("derives initiative -> PRD -> story -> issue for an issue that fixes one story", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, prd, story, issue],
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("INIT4", "tracks", "ISS18"),
					makeRelation("ISS18", "fixes", "US18")
				]
			})
		);

		expect(store.cascadePathForLeaf("ISS18")).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
	});

	it("derives initiative -> issue for an issue that fixes no story", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, issue],
				relations: [makeRelation("INIT4", "tracks", "ISS18")]
			})
		);

		expect(store.cascadePathForLeaf("ISS18")).toEqual(["INIT4", "ISS18"]);
	});

	it("derives a deterministic default branch when an issue fixes multiple stories", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const firstPrd = makeEntity({ id: "PRD4", kind: "prd" });
		const secondPrd = makeEntity({ id: "PRD5", kind: "prd" });
		const defaultStory = makeEntity({ id: "US18", kind: "userStory" });
		const otherStory = makeEntity({ id: "US20", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, firstPrd, secondPrd, defaultStory, otherStory, issue],
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("INIT4", "owns", "PRD5"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("PRD5", "creates", "US20"),
					makeRelation("INIT4", "tracks", "ISS18"),
					makeRelation("ISS18", "fixes", "US20"),
					makeRelation("ISS18", "fixes", "US18")
				]
			})
		);

		expect(store.cascadePathForLeaf("ISS18")).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
	});

	it("walks decomposes up to the root issue before taking the fixes hop for a sub-issue", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const rootIssue = makeEntity({ id: "ISS18", kind: "issue" });
		const midIssue = makeEntity({ id: "ISS30", kind: "issue" });
		const leafIssue = makeEntity({ id: "ISS31", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, prd, story, rootIssue, midIssue, leafIssue],
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("INIT4", "tracks", "ISS18"),
					makeRelation("ISS18", "fixes", "US18"),
					makeRelation("ISS18", "decomposes", "ISS30"),
					makeRelation("ISS30", "decomposes", "ISS31")
				]
			})
		);

		expect(store.cascadePathForLeaf("ISS31")).toEqual(["INIT4", "PRD4", "US18", "ISS18", "ISS30", "ISS31"]);
	});
});

describe("cascade column window capacity", () => {
	it("computes how many fixed-width columns fit in the available width", () => {
		const store = new AgentIssuesStore();

		expect(store.cascadeCapacityForWidth(1000)).toBe(2);
		expect(store.cascadeCapacityForWidth(1500)).toBe(3);
		expect(store.cascadeCapacityForWidth(496)).toBe(1);
		expect(store.cascadeCapacityForWidth(50)).toBe(1);
	});

	it("splits the lineage into a left breadcrumb and a window that always ends at the leaf", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, prd, story, issue] }));
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);
		store.cascadeAvailableWidth.set(1000);

		const window = store.cascadeColumnWindow.get();

		expect(window.breadcrumb.map((entity) => entity.id)).toEqual(["INIT4", "PRD4"]);
		expect(window.columns.map((entity) => entity.id)).toEqual(["US18", "ISS18"]);
	});

	it("restores a breadcrumb ancestor into the window while keeping the leaf visible", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, prd, story, issue] }));
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);
		store.cascadeAvailableWidth.set(1000);

		store.restoreAncestor("PRD4");

		const window = store.cascadeColumnWindow.get();
		expect(window.breadcrumb.map((entity) => entity.id)).toEqual(["INIT4"]);
		expect(window.columns.map((entity) => entity.id)).toEqual(["PRD4", "US18", "ISS18"]);
	});

	it("truncates the path to a clicked ancestor so that crumb becomes the leaf and deeper columns drop", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, prd, story, issue] }));
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);
		store.cascadeAvailableWidth.set(1000);

		store.truncateCascadeTo("PRD4");

		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4"]);
		const window = store.cascadeColumnWindow.get();
		expect(window.breadcrumb).toEqual([]);
		expect(window.columns.map((entity) => entity.id)).toEqual(["INIT4", "PRD4"]);
	});

	it("ignores truncation to the leaf or an unknown id", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, issue] }));
		store.cascadePath.set(["INIT4", "ISS18"]);

		store.truncateCascadeTo("ISS18");
		expect(store.cascadePath.get()).toEqual(["INIT4", "ISS18"]);

		store.truncateCascadeTo("NOPE");
		expect(store.cascadePath.get()).toEqual(["INIT4", "ISS18"]);
	});
});

describe("cascade hop connectors", () => {
	function makeRelation(fromId: string, type: string, toId: string): Relation {
		return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
	}

	it("names the relation joining each adjacent pair in the lineage", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("ISS18", "fixes", "US18"),
					makeRelation("INIT4", "tracks", "ISS18"),
					makeRelation("ISS18", "decomposes", "ISS30")
				]
			})
		);

		expect(store.cascadeHopRelation("INIT4", "PRD4")).toBe("owns");
		expect(store.cascadeHopRelation("PRD4", "US18")).toBe("creates");
		expect(store.cascadeHopRelation("US18", "ISS18")).toBe("fixes");
		expect(store.cascadeHopRelation("INIT4", "ISS18")).toBe("tracks");
		expect(store.cascadeHopRelation("ISS18", "ISS30")).toBe("decomposes");
	});
});

describe("cascade branch selector", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	function makeRelation(fromId: string, type: string, toId: string): Relation {
		return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
	}

	function makeBranchingStore(): AgentIssuesStore {
		const entities = [
			makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" }),
			makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Other initiative" }),
			makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" }),
			makeEntity({ id: "PRD2", kind: "prd", title: "Other PRD" }),
			makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" }),
			makeEntity({ id: "US40", kind: "userStory", title: "Other story" }),
			makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" })
		];
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities,
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("INIT2", "owns", "PRD2"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("PRD2", "creates", "US40"),
					makeRelation("ISS18", "fixes", "US18"),
					makeRelation("ISS18", "fixes", "US40")
				]
			})
		);
		return store;
	}

	it("describes a branch selector at a fixes hop with multiple candidate stories", () => {
		const store = makeBranchingStore();

		const seam = store.cascadeSeamFor("US18", "ISS18");

		expect(seam.relation).toBe("fixes");
		expect(seam.branch?.options.map((entity) => entity.id)).toEqual(["US18", "US40"]);
		expect(seam.branch?.selectedIndex).toBe(0);
	});

	it("reports no branch selector at a single-candidate fixes hop or a structural hop", () => {
		const store = makeBranchingStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [
					makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" }),
					makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" }),
					makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" })
				],
				relations: [makeRelation("ISS18", "fixes", "US18"), makeRelation("PRD4", "creates", "US18")]
			})
		);

		expect(store.cascadeSeamFor("US18", "ISS18").branch).toBeNull();
		expect(store.cascadeSeamFor("PRD4", "US18").branch).toBeNull();
	});

	it("re-derives ancestor columns toward the root from the newly chosen branch and updates the URL", () => {
		const store = makeBranchingStore();
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);

		store.selectCascadeBranch("ISS18", "US40");

		expect(store.cascadePath.get()).toEqual(["INIT2", "PRD2", "US40", "ISS18"]);
		expect(window.location.hash).toBe("#cascade=INIT2~PRD2~US40~ISS18");
	});

	it("round-trips the chosen branch through the URL hash", () => {
		const store = makeBranchingStore();
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);

		store.selectCascadeBranch("ISS18", "US40");
		const hash = window.location.hash;
		store.cascadePath.set([]);
		window.location.hash = hash;
		store.onHashChange();

		expect(store.cascadePath.get()).toEqual(["INIT2", "PRD2", "US40", "ISS18"]);
		expect(store.cascadeSeamFor("US40", "ISS18").branch?.selectedIndex).toBe(1);
	});
});

describe("re-root trail", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	function makeRelation(fromId: string, type: string, toId: string): Relation {
		return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
	}

	function makeTrailStore(): AgentIssuesStore {
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [
					makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" }),
					makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" }),
					makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" }),
					makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" }),
					makeEntity({ id: "ISS40", kind: "issue", title: "Cross-linked issue" })
				],
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("ISS18", "fixes", "US18"),
					makeRelation("ISS40", "blocks", "ISS18")
				]
			})
		);
		return store;
	}

	it("replaces the cascade with the target's lineage and pushes a chip for the stack left behind", () => {
		const store = makeTrailStore();
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);

		store.reRootCascade("ISS40");

		expect(store.reRootTrail.get()).toEqual([["INIT4", "PRD4", "US18", "ISS18"]]);
		expect(store.cascadePath.get()).toEqual(["ISS40"]);
	});

	it("restores the full stack when a chip is clicked and pops the trail back to it", () => {
		const store = makeTrailStore();
		store.reRootTrail.set([["INIT4"], ["INIT4", "PRD4", "US18", "ISS18"]]);
		store.cascadePath.set(["ISS40"]);

		store.restoreReRoot(1);

		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
		expect(store.reRootTrail.get()).toEqual([["INIT4"]]);
	});

	it("updates the current stack in place when drilling or branch-switching, without pushing a chip", () => {
		const store = makeTrailStore();
		store.reRootTrail.set([["INIT4"]]);
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);

		store.drillCascade("ISS18", "ISS41");

		expect(store.reRootTrail.get()).toEqual([["INIT4"]]);
		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4", "US18", "ISS18", "ISS41"]);
	});

	it("pops the most recent chip on browser back", () => {
		const store = makeTrailStore();
		store.reRootTrail.set([["INIT4"], ["INIT4", "PRD4", "US18", "ISS18"]]);
		store.cascadePath.set(["ISS40"]);

		store.popReRoot();

		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
		expect(store.reRootTrail.get()).toEqual([["INIT4"]]);
	});
});

describe("collapse toggles and auto-collapse", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	it("keeps the master list expanded while the cascade is shallow", () => {
		const store = new AgentIssuesStore();
		store.openCascade("INIT4");

		expect(store.masterCollapsed.get()).toBe(false);
	});

	it("auto-collapses the master list once the cascade is two or more columns deep", () => {
		const store = new AgentIssuesStore();
		store.cascadePath.set(["INIT4", "PRD4"]);

		expect(store.masterCollapsed.get()).toBe(true);
	});

	it("toggles the rail collapse state independently of the master list", () => {
		const store = new AgentIssuesStore();

		expect(store.railCollapsed.get()).toBe(false);
		store.toggleRail();

		expect(store.railCollapsed.get()).toBe(true);
		expect(store.masterCollapsed.get()).toBe(false);
	});

	it("lets a manual expand override the auto-collapse while the cascade stays deep", () => {
		const store = new AgentIssuesStore();
		store.cascadePath.set(["INIT4", "PRD4"]);

		store.toggleMaster();

		expect(store.masterCollapsed.get()).toBe(false);
	});

	it("clears the manual expand override once the cascade drops below two columns deep", () => {
		const store = new AgentIssuesStore();
		store.cascadePath.set(["INIT4", "PRD4"]);
		store.toggleMaster();

		store.openCascade("INIT4");

		expect(store.masterCollapsed.get()).toBe(false);

		store.drillCascade("INIT4", "PRD4");

		expect(store.masterCollapsed.get()).toBe(true);
	});

	it("lets a manual collapse while shallow persist", () => {
		const store = new AgentIssuesStore();
		store.openCascade("INIT4");

		store.toggleMaster();

		expect(store.masterCollapsed.get()).toBe(true);
	});
});


