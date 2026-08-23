import "./kanban-status-badge-draft.js";
import "./kanban-priority-badge-draft.js";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanCardMetadataDraft extends HTMLElement {
	static get observedAttributes() {
		return ["reference", "status", "priority", "owner", "due", "blockers", "relationships"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const reference = this.getAttribute("reference") ?? "ISS-322";
		const status = this.getAttribute("status") ?? "Todo";
		const priority = this.getAttribute("priority") ?? "Medium";
		const owner = this.getAttribute("owner") ?? "Unassigned";
		const due = this.getAttribute("due") ?? "No due date";
		const blockers = this.getAttribute("blockers") ?? "0";
		const relationships = this.getAttribute("relationships") ?? "0";
		const isOverdue = due.toLowerCase() === "overdue";
		const blockerLabel = blockers === "1" ? "1 blocker" : `${blockers} blockers`;
		const relationshipLabel = relationships === "1" ? "1 relationship" : `${relationships} relationships`;

		this.innerHTML = `<section class="kanban-card-metadata" aria-label="Metadata for ${escapeHtml(reference)}"><div class="kanban-card-metadata-header"><span class="kanban-card-metadata-reference">${escapeHtml(reference)}</span><div class="kanban-card-metadata-badges"><kanban-status-badge-draft status="${escapeHtml(status)}"></kanban-status-badge-draft><kanban-priority-badge-draft priority="${escapeHtml(priority)}"></kanban-priority-badge-draft></div></div><dl class="kanban-card-metadata-details"><div><dt>Owner</dt><dd>${escapeHtml(owner)}</dd></div><div><dt>Due</dt><dd class="${isOverdue ? "is-overdue" : ""}">${escapeHtml(due)}</dd></div><div><dt>Blockers</dt><dd class="${blockers === "0" ? "" : "is-blocked"}">${escapeHtml(blockerLabel)}</dd></div><div><dt>Relationships</dt><dd>${escapeHtml(relationshipLabel)}</dd></div></dl></section>`;
	}
}

customElements.define("kanban-card-metadata-draft", KanbanCardMetadataDraft);