const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanBreadcrumbTrailDraft extends HTMLElement {
	static get observedAttributes() {
		return ["items", "label"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const items = (this.getAttribute("items") ?? "Workspace|Current record")
			.split("|")
			.map((item) => item.trim())
			.filter(Boolean);
		const label = escapeHtml(this.getAttribute("label") ?? "Breadcrumb");
		const itemMarkup = items.map((item, index) => {
			const current = index === items.length - 1 ? " aria-current=\"page\"" : "";
			return `<li${current}>${escapeHtml(item)}</li>`;
		}).join("");
		this.innerHTML = `<nav class="breadcrumb-trail" aria-label="${label}"><ol>${itemMarkup}</ol></nav>`;
	}
}

customElements.define("kanban-breadcrumb-trail-draft", KanbanBreadcrumbTrailDraft);