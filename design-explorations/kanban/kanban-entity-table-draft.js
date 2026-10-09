import "./kanban-status-badge-draft.js";
import "./kanban-priority-badge-draft.js";
import "./kanban-skeleton-draft.js";
import "./kanban-table-toolbar-draft.js";
import "./kanban-empty-state-draft.js";
import "./kanban-no-results-state-draft.js";
import "./kanban-error-state-draft.js";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

const tableDetails = {
	plans: {
		label: "Plans",
		columns: ["Record", "Summary", "Scope", "Status"],
		rows: [
			["Plan", "Kanban runtime delivery", "Local server boundary, mutation handling, and browser recovery.", "4 issues", "In progress", "is-progress"],
			["Plan", "Board interaction polish", "Column behavior, record overlays, and saved view state.", "3 issues", "Ready", ""],
			["Plan", "Release readiness", "Verification path, migration notes, and acceptance review.", "2 issues", "Draft", "is-muted"]
		]
	},
	prds: {
		label: "Product requirements",
		columns: ["Record", "Summary", "Scope", "Status"],
		rows: [
			["PRD", "Kanban board workspace", "Make initiative work visible, editable, and safe to recover.", "5 stories", "Active", "is-progress"],
			["PRD", "Relationship-aware record overlay", "Show record fields, graph edges, and discussion in one place.", "3 stories", "Review", ""],
			["PRD", "Local development runtime", "Serve the board through the storage-driver boundary.", "2 stories", "Draft", "is-muted"]
		]
	},
	adrs: {
		label: "Architecture decisions",
		columns: ["Record", "Decision", "Status"],
		rows: [
			["ADR-014", "Serve the board through a detached local runtime", "The browser does not read the local database directly.", "", "Accepted", "is-progress"],
			["ADR-013", "Preserve pending edits across snapshot refresh", "Optimistic state stays visible while the server confirms a mutation.", "", "Accepted", "is-progress"],
			["ADR-012", "Use shared record overlays for entity detail", "Details remain in context without leaving the board workspace.", "", "Proposed", ""]
		]
	},
	debt: {
		label: "Technical debt",
		columns: ["Record", "Debt", "Priority", "Status"],
		rows: [
			["DEBT-042", "Unify detached server lifecycle messages", "Daemon startup errors need one stable, actionable form.", "High", "Open", "is-high"],
			["DEBT-039", "Persist saved board filters", "Current filters reset when the workspace reloads.", "Medium", "Open", ""],
			["DEBT-035", "Consolidate entity detail loading", "Record surfaces still prepare similar related data separately.", "Medium", "Triaged", "is-muted"]
		]
	}
};

export class KanbanEntityTableDraft extends HTMLElement {
	static get observedAttributes() {
		return ["empty", "error", "loading", "no-results", "query", "view"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const detail = tableDetails[this.getAttribute("view")] || tableDetails.plans;
		const isDebt = this.getAttribute("view") === "debt";
		const label = detail.label.toLowerCase();
		if (this.hasAttribute("error")) {
			this.innerHTML = `<section class="entity-table-state"><kanban-error-state-draft heading="We could not load ${label}" message="Try again to load ${label} for this initiative."></kanban-error-state-draft></section>`;
			return;
		}
		if (this.hasAttribute("empty")) {
			this.innerHTML = `<section class="entity-table-state"><kanban-empty-state-draft heading="No ${label} yet" message="Create the first ${detail.label.slice(0, -1).toLowerCase()} for this initiative." action-label="New ${detail.label.slice(0, -1)}"></kanban-empty-state-draft></section>`;
			return;
		}
		if (this.hasAttribute("no-results")) {
			this.innerHTML = `<section class="entity-table-state"><kanban-no-results-state-draft query="${escapeHtml(this.getAttribute("query") ?? "this search")}"></kanban-no-results-state-draft></section>`;
			return;
		}
		if (this.hasAttribute("loading")) {
			this.innerHTML = `<section class="entity-table-loading" aria-label="Loading ${detail.label}"><kanban-skeleton-draft layout="table"></kanban-skeleton-draft></section>`;
			return;
		}
		this.innerHTML = `<section class="entity-table-surface"><kanban-table-toolbar-draft label="${detail.label.toLowerCase()}" count="${detail.rows.length}" action-label="New ${detail.label.slice(0, -1)}"></kanban-table-toolbar-draft><div class="entity-table-wrap"><table class="entity-table"><caption>${detail.label}</caption><thead><tr>${detail.columns.map((column) => `<th scope="col">${column}</th>`).join("")}<th scope="col"><span class="entity-table-sr-only">Actions</span></th></tr></thead><tbody>${detail.rows.map(([reference, title, description, scope, status]) => `<tr><td><code>${reference}</code></td><td><strong>${title}</strong><span>${description}</span></td>${detail.columns.length === 4 ? `<td>${isDebt ? `<kanban-priority-badge-draft priority="${scope}"></kanban-priority-badge-draft>` : `<span class="entity-table-scope">${scope}</span>`}</td>` : ""}<td><kanban-status-badge-draft status="${status}"></kanban-status-badge-draft></td><td><button class="entity-table-row-action" type="button" data-reference="${reference}" data-title="${title}">Open<span class="entity-table-sr-only"> ${reference}</span></button></td></tr>`).join("")}</tbody></table></div></section>`;

		this.querySelectorAll(".entity-table-row-action").forEach((button) => button.addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("open-record", {
				bubbles: true,
				composed: true,
				detail: { reference: button.dataset.reference, title: button.dataset.title }
			}));
		}));
	}
}

customElements.define("kanban-entity-table-draft", KanbanEntityTableDraft);