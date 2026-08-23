import "./kanban-breadcrumb-trail-draft.js";
import "./kanban-icon-button-draft.js";
import "./kanban-record-toolbar-draft.js";
import "./kanban-status-badge-draft.js";

export class KanbanHeaderDraft extends HTMLElement {
	connectedCallback() {
		this.innerHTML = `
			<header class="kanban-header"><kanban-breadcrumb-trail-draft items="Agent Issues|Platform foundations|INIT-05"></kanban-breadcrumb-trail-draft><div class="header-actions"><kanban-icon-button-draft class="mobile-navigation-toggle" action="overflow" label="Open navigation" data-open-mobile-navigation></kanban-icon-button-draft></div></header>
			<kanban-record-toolbar-draft reference="INIT-05" title="Editable Kanban board"></kanban-record-toolbar-draft>
			<div class="record-strip"><kanban-status-badge-draft status="Active"></kanban-status-badge-draft><code>INIT-05</code><span>7 of 12 issues done</span><span>3 open blockers</span><span>Target Aug 28</span></div>
		`;

		this.querySelector("kanban-record-toolbar-draft").addEventListener("record-toolbar-action", (event) => {
			if (event.detail.action === "details") {
				this.dispatchEvent(new CustomEvent("open-initiative", { bubbles: true, composed: true }));
			}
		});
	}
}

customElements.define("kanban-header-draft", KanbanHeaderDraft);
