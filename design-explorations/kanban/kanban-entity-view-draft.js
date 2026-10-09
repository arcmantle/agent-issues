import "./kanban-board-draft.js";
import "./kanban-entity-table-draft.js";
import "./kanban-empty-state-draft.js";
import "./kanban-no-results-state-draft.js";
import "./kanban-error-state-draft.js";
import "./kanban-relationship-graph-draft.js";
import "./kanban-activity-timeline-draft.js";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

const viewDetails = {
	plans: {
		label: "Plans",
		title: "Delivery plans",
		description: "Ordered work outlines for the initiative.",
		action: "New plan",
		emptyContent: "<kanban-empty-state-draft heading=\"No plans yet\" message=\"Create the first delivery plan for this initiative to organize the work.\" action-label=\"Create plan\"></kanban-empty-state-draft>",
		content: "<kanban-entity-table-draft view=\"plans\"></kanban-entity-table-draft>"
	},
	prds: {
		label: "PRDs",
		title: "Product requirements",
		description: "Requirements that explain the user outcome before delivery begins.",
		action: "New PRD",
		content: "<kanban-entity-table-draft view=\"prds\"></kanban-entity-table-draft>"
	},
	adrs: {
		label: "ADRs",
		title: "Architecture decisions",
		description: "Durable choices that set the system constraints for this initiative.",
		action: "New ADR",
		content: "<kanban-entity-table-draft view=\"adrs\"></kanban-entity-table-draft>"
	},
	debt: {
		label: "Debt",
		title: "Technical debt",
		description: "Accepted costs and risks that need clear ownership and a later decision.",
		action: "Log debt",
		content: "<kanban-entity-table-draft view=\"debt\"></kanban-entity-table-draft>"
	},
	graph: {
		label: "Graph",
		title: "Initiative relationships",
		description: "The delivery chain from requirement to plan, issue, and decision.",
		action: "Focus graph",
		content: "<section class=\"entity-panel\"><kanban-relationship-graph-draft></kanban-relationship-graph-draft></section>"
	},
	activity: {
		label: "Activity",
		title: "Initiative activity",
		description: "Recent changes across the initiative and its active records.",
		action: "Filter activity",
		content: "<div class=\"entity-panel\"><kanban-activity-timeline-draft></kanban-activity-timeline-draft></div>"
	}
};

export class KanbanEntityViewDraft extends HTMLElement {
	static get observedAttributes() {
		return ["empty", "error", "no-results", "query", "view"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const view = this.getAttribute("view") || "issues";
		if (view === "issues") {
			this.innerHTML = "<kanban-board-draft></kanban-board-draft>";
			return;
		}

		const detail = viewDetails[view] || viewDetails.plans;
		const query = this.getAttribute("query") ?? "this search";
		const errorContent = `<kanban-error-state-draft heading="We could not load ${escapeHtml(detail.label.toLowerCase())}" message="Try again to load ${escapeHtml(detail.label.toLowerCase())} for this initiative."></kanban-error-state-draft>`;
		const content = this.hasAttribute("error")
			? errorContent
			: this.hasAttribute("empty") && detail.emptyContent
			? detail.emptyContent
			: this.hasAttribute("no-results")
				? `<kanban-no-results-state-draft query="${escapeHtml(query)}"></kanban-no-results-state-draft>`
				: detail.content;
		this.innerHTML = `<section class="entity-view entity-view-${view}" aria-label="${detail.label} view"><header class="entity-view-header"><div><span class="type-label">${detail.label}</span><h2>${detail.title}</h2><p>${detail.description}</p></div><button class="entity-view-action">${detail.action}</button></header>${content}</section>`;
	}
}

customElements.define("kanban-entity-view-draft", KanbanEntityViewDraft);