import "./kanban-icon-button-draft.js";

const escapeHtml = (value) => String(value)
	.replaceAll("&", "&amp;")
	.replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;")
	.replaceAll('"', "&quot;")
	.replaceAll("'", "&#39;");

export class KanbanColumnHeaderDraft extends HTMLElement {
	connectedCallback() {
		const title = this.getAttribute("title") ?? "Todo";
		const count = this.getAttribute("count") ?? "00";
		const escapedTitle = escapeHtml(title);
		const escapedCount = escapeHtml(count);

		this.innerHTML = `
			<link rel="stylesheet" href="kanban-column-header-draft.css" />
			<link rel="stylesheet" href="kanban-icon-button-draft.css" />
			<header class="kanban-column-header" aria-label="${escapedTitle} column">
				<span class="column-title">${escapedTitle}</span>
				<code class="column-count">${escapedCount}</code>
				<div class="column-header-actions">
					<kanban-icon-button-draft action="overflow" label="More ${escapedTitle} column actions" data-column-actions></kanban-icon-button-draft>
					<kanban-icon-button-draft action="create" label="Create ${escapedTitle} issue" data-create-issue></kanban-icon-button-draft>
				</div>
			</header>
		`;

		this.querySelector("[data-column-actions]").addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("column-actions", {
				bubbles: true,
				composed: true,
				detail: { title, count }
			}));
		});
		this.querySelector("[data-create-issue]").addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("column-create", {
				bubbles: true,
				composed: true,
				detail: { title, count }
			}));
		});
	}
}

customElements.define("kanban-column-header-draft", KanbanColumnHeaderDraft);