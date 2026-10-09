import "./kanban-app-shell-draft.js";
import "./kanban-overlay-draft.js";
import "./kanban-issue-overlay-draft.js";

export class KanbanOverviewDraft extends HTMLElement {
	connectedCallback() {
		this.innerHTML = `
			<kanban-app-shell-draft></kanban-app-shell-draft>
			<kanban-initiative-overlay></kanban-initiative-overlay>
			<kanban-issue-overlay-draft></kanban-issue-overlay-draft>
		`;

		const appShell = this.querySelector("kanban-app-shell-draft");
		const overlay = this.querySelector("kanban-initiative-overlay");
		const issueOverlay = this.querySelector("kanban-issue-overlay-draft");
		appShell.addEventListener("open-initiative", () => overlay.open());
		overlay.querySelectorAll("[data-close-initiative]").forEach((button) => button.addEventListener("click", () => overlay.close()));
		appShell.addEventListener("open-issue", (event) => issueOverlay.setIssue(event.detail));
	}
}

customElements.define("kanban-overview-draft", KanbanOverviewDraft);
