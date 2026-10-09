import "./kanban-column-header-draft.js";

const escapeHtml = (value) => String(value)
	.replaceAll("&", "&amp;")
	.replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;")
	.replaceAll('"', "&quot;")
	.replaceAll("'", "&#39;");

export class KanbanColumnDraft extends HTMLElement {
	connectedCallback() {
		const title = this.getAttribute("title") ?? "Todo";
		const count = this.getAttribute("count") ?? "00";
		const escapedTitle = escapeHtml(title);
		const escapedCount = escapeHtml(count);
		const cards = [...this.children];
		const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
		root.innerHTML = `
			<link rel="stylesheet" href="kanban-column-draft.css" />
			<section class="kanban-column" aria-label="${escapedTitle} issues">
				<kanban-column-header-draft title="${escapedTitle}" count="${escapedCount}"></kanban-column-header-draft>
				<div class="column-cards"><slot></slot></div>
			</section>
		`;
		this.replaceChildren(...cards);
	}
}

customElements.define("kanban-column-draft", KanbanColumnDraft);
