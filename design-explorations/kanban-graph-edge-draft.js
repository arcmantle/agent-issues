const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanGraphEdgeDraft extends HTMLElement {
	connectedCallback() {
		const label = this.getAttribute("label") ?? "relates to";
		const safeLabel = escapeHtml(label);
		this.innerHTML = `<div class="graph-edge" role="img" aria-label="Relationship: ${safeLabel}"><span>${safeLabel}</span></div>`;
	}
}

customElements.define("kanban-graph-edge-draft", KanbanGraphEdgeDraft);