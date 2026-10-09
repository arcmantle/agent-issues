import "./kanban-relationship-item-draft.js";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

const defaultRelationships = [
	{ kind: "Initiative", title: "Editable Kanban board", relation: "Parent" },
	{ kind: "Issue", title: "Start detached Kanban server", relation: "Blocks" },
	{ kind: "PRD", title: "Editable Kanban board", relation: "Context" }
];

export class KanbanRelationshipListDraft extends HTMLElement {
	static get observedAttributes() {
		return ["label", "empty"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	setRelationships(relationships) {
		this.relationships = relationships;
		this.render();
	}

	render() {
		const label = this.getAttribute("label") ?? "Relationships";
		const relationships = this.hasAttribute("empty") ? [] : (this.relationships ?? defaultRelationships);
		const content = relationships.length === 0
			? "<p class=\"relationship-list-empty\">No related records yet.</p>"
			: `<ol>${relationships.map(({ kind, title, relation }) => `<li><kanban-relationship-item-draft kind="${escapeHtml(kind)}" title="${escapeHtml(title)}" relation="${escapeHtml(relation)}"></kanban-relationship-item-draft></li>`).join("")}</ol>`;

		this.innerHTML = `<section class="relationship-list" aria-label="${escapeHtml(label)}" aria-live="polite">${content}</section>`;
	}
}

customElements.define("kanban-relationship-list-draft", KanbanRelationshipListDraft);