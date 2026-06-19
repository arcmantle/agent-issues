import { afterEach, describe, expect, it } from "vitest";

import "./relationship-graph.js";
import type { RelationshipGraph } from "../models.js";

function makeGraph(): RelationshipGraph {
	return {
		columns: ["Initiative", "PRDs & ADRs", "User stories", "Issues"],
		edges: [
			{ from: "INIT1", to: "US1" },
			{ from: "US1", to: "ISS1" }
		],
		nodes: [
			{ col: 0, fullLabel: "Console Viewer", id: "INIT1", key: "INIT1", kind: "initiative", label: "Console Viewer" },
			{ col: 2, fullLabel: "Explore the graph", id: "US1", key: "US1", kind: "story", label: "Explore the graph" },
			{ col: 3, fullLabel: "Render nodes", id: "ISS1", key: "ISS1", kind: "issue", label: "Render nodes", status: "done" }
		]
	};
}

async function mountGraph(graph: RelationshipGraph | null) {
	const view = document.createElement("agent-issues-relationship-graph");
	view.graph = graph;
	document.body.appendChild(view);
	await view.updateComplete;
	return view;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("relationship graph", () => {
	it("renders one SVG node per graph node", async () => {
		const view = await mountGraph(makeGraph());

		const nodes = view.shadowRoot?.querySelectorAll(".ai-node") ?? [];
		expect(nodes.length).toBe(3);
	});

	it("emits node-open with the record id when a node is clicked", async () => {
		const view = await mountGraph(makeGraph());
		let openedId: string | null = null;
		view.addEventListener("node-open", (event) => {
			openedId = (event as CustomEvent<{ id: string }>).detail.id;
		});

		const issueNode = view.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="ISS1"]');
		issueNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

		expect(openedId).toBe("ISS1");
	});
});
