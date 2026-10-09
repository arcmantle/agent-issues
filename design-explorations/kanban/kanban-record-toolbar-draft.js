import "./kanban-button-draft.js";
import "./kanban-icon-button-draft.js";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanRecordToolbarDraft extends HTMLElement {
	static get observedAttributes() {
		return ["reference", "title"];
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
		const reference = this.getAttribute("reference") || "INIT-05";
		const title = this.getAttribute("title") || "Editable Kanban board";
		const escapedReference = escapeHtml(reference);
		const escapedTitle = escapeHtml(title);

		this.innerHTML = `<section class="record-toolbar" aria-label="${escapedTitle} controls"><header class="record-toolbar-header"><div class="record-toolbar-title"><code>${escapedReference}</code><h2>${escapedTitle}</h2></div><div class="record-toolbar-title-actions"><kanban-button-draft label="Record details" variant="secondary" data-action="details"></kanban-button-draft><kanban-icon-button-draft action="create" label="Create issue" data-action="create"></kanban-icon-button-draft></div></header><div class="record-toolbar-controls"><form class="record-toolbar-search" role="search"><label for="record-toolbar-query"><span class="record-toolbar-sr-only">Search records</span><input id="record-toolbar-query" type="search" placeholder="Search records" /></label></form><label class="record-toolbar-filter">Filter<select name="filter"><option value="all">All issues</option><option value="todo">Todo</option><option value="in-progress">In progress</option><option value="blocked">Blocked</option></select></label><div class="record-toolbar-views" role="group" aria-label="Record view"><button type="button" class="is-selected" data-view="board" aria-pressed="true">Board</button><button type="button" data-view="table" aria-pressed="false">Table</button></div></div></section>`;

		this.querySelector("form").addEventListener("submit", (event) => event.preventDefault());
		this.querySelector("input").addEventListener("input", (event) => this.emit("record-toolbar-search", { query: event.target.value }));
		this.querySelector('[name="filter"]').addEventListener("change", (event) => this.emit("record-toolbar-filter", { filter: event.target.value }));
		this.querySelectorAll("[data-action]").forEach((control) => control.addEventListener("click", () => this.emit("record-toolbar-action", { action: control.dataset.action })));
		this.querySelectorAll("[data-view]").forEach((control) => control.addEventListener("click", () => {
			this.querySelectorAll("[data-view]").forEach((button) => {
				const selected = button === control;
				button.classList.toggle("is-selected", selected);
				button.setAttribute("aria-pressed", String(selected));
			});
			this.emit("record-toolbar-view", { view: control.dataset.view });
		}));
	}
}

customElements.define("kanban-record-toolbar-draft", KanbanRecordToolbarDraft);