import "./kanban-status-badge-draft.js";
import "./kanban-priority-badge-draft.js";
import "./kanban-card-metadata-draft.js";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanCardDraft extends HTMLElement {
	connectedCallback() {
		const reference = this.getAttribute("reference") ?? "ISS-322";
		const title = this.getAttribute("title") ?? "Define the board-server write contract";
		const category = this.getAttribute("category") ?? "High";
		const detail = this.getAttribute("detail") ?? "2 blockers";
		const status = this.getAttribute("status") ?? "Todo";
		const isBlocked = this.hasAttribute("blocked");
		const owner = this.getAttribute("owner") ?? (reference === "ISS-318" ? "R. Lee" : "Unassigned");
		const due = this.getAttribute("due") ?? "Today";
		const blockers = this.getAttribute("blockers") ?? (isBlocked ? "1" : "0");
		const relationships = this.getAttribute("relationships") ?? "0";
		const escapedReference = escapeHtml(reference);
		const escapedTitle = escapeHtml(title);
		const escapedCategory = escapeHtml(category);
		const escapedStatus = escapeHtml(status);
		const escapedOwner = escapeHtml(owner);
		const escapedDue = escapeHtml(due);
		const escapedBlockers = escapeHtml(blockers);
		const escapedRelationships = escapeHtml(relationships);
		this.innerHTML = `
			<article class="kanban-card ${isBlocked ? "is-blocked" : ""}" role="button" tabindex="0" aria-label="Open ${escapedReference}: ${escapedTitle}">
				${isBlocked ? '<span class="blocked-label">Waiting on daemon</span>' : ""}
				<h3>${escapedTitle}</h3>
				<kanban-card-metadata-draft reference="${escapedReference}" status="${escapedStatus}" priority="${escapedCategory}" owner="${escapedOwner}" due="${escapedDue}" blockers="${escapedBlockers}" relationships="${escapedRelationships}"></kanban-card-metadata-draft>
			</article>
		`;

		const openIssue = () => this.dispatchEvent(new CustomEvent("open-issue", {
			bubbles: true,
			detail: { reference, title, category, detail, status }
		}));
		this.querySelector(".kanban-card").addEventListener("click", openIssue);
		this.querySelector(".kanban-card").addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				openIssue();
			}
		});
	}
}

customElements.define("kanban-card-draft", KanbanCardDraft);
