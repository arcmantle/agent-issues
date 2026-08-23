const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanRelationshipItemDraft extends HTMLElement {
	static get observedAttributes() {
		return ["kind", "title", "relation", "action-label"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const kind = this.getAttribute("kind") ?? "Issue";
		const title = this.getAttribute("title") ?? "Untitled record";
		const relation = this.getAttribute("relation") ?? "Related";
		const actionLabel = this.getAttribute("action-label") ?? "Open record";
		this.innerHTML = `<article class="relationship-item"><div class="relationship-item-summary"><span>${escapeHtml(kind)}</span><strong>${escapeHtml(title)}</strong></div><div class="relationship-item-action"><small>${escapeHtml(relation)}</small><button type="button">${escapeHtml(actionLabel)}</button></div></article>`;
		this.querySelector("button").addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("relationship-action", {
				bubbles: true,
				detail: { kind, title, relation }
			}));
		});
	}
}

customElements.define("kanban-relationship-item-draft", KanbanRelationshipItemDraft);