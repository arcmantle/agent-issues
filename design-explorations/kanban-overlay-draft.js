import "./kanban-status-badge-draft.js";
import "./kanban-record-detail-panel-draft.js";

export class KanbanInitiativeOverlay extends HTMLElement {
	connectedCallback() {
		this.innerHTML = `<kanban-record-detail-panel-draft label="Initiative details"${this.hasAttribute("open") ? " open" : ""}><div data-record-detail-panel-header class="overlay-header"><div><div class="breadcrumbs"><span>Initiative record</span><span>INIT-05</span></div><h2>Editable Kanban board</h2></div><button data-close-initiative aria-label="Close initiative details">×</button></div><div data-record-detail-panel-meta class="overlay-meta"><kanban-status-badge-draft status="Active"></kanban-status-badge-draft><span>Platform foundations</span><span>Target Aug 28</span></div><div data-record-detail-panel-content class="overlay-content"><h3>Purpose</h3><p>Define the first editable Kanban board for agent-issues projects in local and cloud workspaces.</p><h3>Scope</h3><ul><li>Status-grouped issues with Todo, In progress, Blocked, and Done lanes.</li><li>Live edits, comments, and valid record relationships.</li><li>A detached <code>agent-issues kanban</code> runtime with daemon-only local storage.</li></ul><h3>Related records</h3><div class="related-records"><div>PRD · Editable Kanban board <small>Draft</small></div><div>ADR · Daemon-only local runtime <small>Current</small></div><div>Issue · Start detached Kanban server <small>Blocked</small></div></div></div></kanban-record-detail-panel-draft>`;
		this.querySelector("kanban-record-detail-panel-draft").addEventListener("record-detail-panel-close", () => this.removeAttribute("open"));
		if (this.hasAttribute("open")) {
			this.open();
		}
	}

	open() {
		this.setAttribute("open", "");
		this.querySelector("kanban-record-detail-panel-draft").open();
	}

	close() {
		this.querySelector("kanban-record-detail-panel-draft").close();
	}
}

customElements.define("kanban-initiative-overlay", KanbanInitiativeOverlay);
