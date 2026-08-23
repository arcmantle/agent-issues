const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanTableToolbarDraft extends HTMLElement {
	static get observedAttributes() {
		return ["action-label", "count", "label"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	emit(name, detail) {
		this.dispatchEvent(new CustomEvent(name, {
			bubbles: true,
			composed: true,
			detail
		}));
	}

	render() {
		const count = this.getAttribute("count") || "0";
		const label = this.getAttribute("label") || "records";
		const actionLabel = this.getAttribute("action-label") || "New record";
		const escapedLabel = escapeHtml(label);

		this.innerHTML = `<section class="table-toolbar" aria-label="${escapedLabel} table controls"><form class="table-toolbar-search" role="search"><label for="table-toolbar-query"><span class="table-toolbar-sr-only">Search ${escapedLabel}</span><input id="table-toolbar-query" type="search" placeholder="Search ${escapedLabel}" /></label></form><div class="table-toolbar-controls"><label>Filter<select name="filter"><option value="all">All records</option><option value="active">Active</option><option value="draft">Draft</option><option value="blocked">Blocked</option></select></label><label>Sort<select name="sort"><option value="updated">Last updated</option><option value="title">Title</option><option value="status">Status</option></select></label></div><output class="table-toolbar-count" aria-live="polite">${escapeHtml(count)} ${escapedLabel}</output><button class="table-toolbar-action" type="button">${escapeHtml(actionLabel)}</button></section>`;

		this.querySelector("form").addEventListener("submit", (event) => event.preventDefault());
		this.querySelector("input").addEventListener("input", (event) => this.emit("table-toolbar-search", { query: event.target.value }));
		this.querySelector('[name="filter"]').addEventListener("change", (event) => this.emit("table-toolbar-filter", { filter: event.target.value }));
		this.querySelector('[name="sort"]').addEventListener("change", (event) => this.emit("table-toolbar-sort", { sort: event.target.value }));
		this.querySelector("button").addEventListener("click", () => this.emit("table-toolbar-action", { action: actionLabel }));
	}
}

customElements.define("kanban-table-toolbar-draft", KanbanTableToolbarDraft);