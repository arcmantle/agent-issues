import "./kanban-graph-edge-draft.js";
import "./kanban-graph-node-draft.js";

const defaultRelationships = [
	{ source: { reference: "Initiative", title: "Kanban board", tone: "root" }, label: "defines", target: { reference: "PRD-26", title: "Board workspace" } },
	{ source: { reference: "PRD-26", title: "Board workspace" }, label: "guides", target: { reference: "Plan-12", title: "Runtime delivery" } },
	{ source: { reference: "Plan-12", title: "Runtime delivery" }, label: "contains", target: { reference: "ISS-318", title: "Snapshot refresh", tone: "accent" } },
	{ source: { reference: "ADR-014", title: "Detached runtime" }, label: "constrains", target: { reference: "ISS-319", title: "Start server", tone: "warning" } }
];

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanRelationshipGraphDraft extends HTMLElement {
	static get observedAttributes() {
		return ["empty", "focus-reference"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	focusReference(reference) {
		if (reference) {
			this.setAttribute("focus-reference", reference);
			return;
		}

		this.removeAttribute("focus-reference");
	}

	render() {
		const focusedReference = this.getAttribute("focus-reference");
		const relationships = this.hasAttribute("empty") ? [] : defaultRelationships;
		const controlsDisabled = relationships.length === 0 ? " disabled" : "";
		const status = relationships.length === 0
			? "No related records can be focused."
			: focusedReference
			? `Focused on ${escapeHtml(focusedReference)}.`
			: "Select a record to focus it in the graph.";
		const rows = relationships.map(({ source, label, target }) => `
			<div class="relationship-graph-row">
				<kanban-graph-node-draft data-reference="${escapeHtml(source.reference)}"${source.reference === focusedReference ? " data-focused" : ""} reference="${escapeHtml(source.reference)}" title="${escapeHtml(source.title)}"${source.tone ? ` tone="${source.tone}"` : ""}></kanban-graph-node-draft>
				<kanban-graph-edge-draft label="${escapeHtml(label)}"></kanban-graph-edge-draft>
				<kanban-graph-node-draft data-reference="${escapeHtml(target.reference)}"${target.reference === focusedReference ? " data-focused" : ""} reference="${escapeHtml(target.reference)}" title="${escapeHtml(target.title)}"${target.tone ? ` tone="${target.tone}"` : ""}></kanban-graph-node-draft>
			</div>`).join("");

		this.innerHTML = `
			<section class="relationship-graph" aria-label="Initiative relationship graph">
				<header class="relationship-graph-header">
					<div class="relationship-graph-legend" aria-label="Graph legend"><span><i class="is-root"></i>Root record</span><span><i class="is-accent"></i>Active work</span><span><i class="is-warning"></i>Blocked work</span></div>
					<div class="relationship-graph-controls"><button type="button" data-focus-active${controlsDisabled}>Focus active issue</button><button type="button" data-clear-focus${focusedReference && relationships.length ? "" : " disabled"}>Clear focus</button></div>
				</header>
				<p class="relationship-graph-status" aria-live="polite">${status}</p>
				<div class="relationship-graph-viewport" tabindex="0">${rows || "<p>No related records to display.</p>"}</div>
			</section>`;

		this.querySelector("[data-focus-active]").addEventListener("click", () => this.focusReference("ISS-318"));
		this.querySelector("[data-clear-focus]").addEventListener("click", () => this.focusReference());
		this.querySelectorAll("kanban-graph-node-draft").forEach((node) => node.addEventListener("click", () => this.focusReference(node.dataset.reference)));
	}
}

customElements.define("kanban-relationship-graph-draft", KanbanRelationshipGraphDraft);