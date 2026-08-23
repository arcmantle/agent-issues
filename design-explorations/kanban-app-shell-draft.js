import "./kanban-sidebar-draft.js";
import "./kanban-mobile-navigation-drawer-draft.js";
import "./kanban-header-draft.js";
import "./kanban-tabs-draft.js";
import "./kanban-entity-view-draft.js";

export class KanbanAppShellDraft extends HTMLElement {
	connectedCallback() {
		this.innerHTML = `
			<div class="app-shell"><kanban-sidebar-draft></kanban-sidebar-draft><section class="app-shell-main"><kanban-header-draft></kanban-header-draft><kanban-tab-bar-draft></kanban-tab-bar-draft><kanban-entity-view-draft view="issues"></kanban-entity-view-draft></section></div>
			<kanban-mobile-navigation-drawer-draft></kanban-mobile-navigation-drawer-draft>
		`;

		const shell = this.querySelector(".app-shell");
		const header = this.querySelector("kanban-header-draft");
		const entityView = this.querySelector("kanban-entity-view-draft");
		const mobileNavigationDrawer = this.querySelector("kanban-mobile-navigation-drawer-draft");

		this.querySelector("[data-open-mobile-navigation]").addEventListener("click", () => mobileNavigationDrawer.open());
		this.querySelector("kanban-sidebar-draft").addEventListener("sidebar-collapse", (event) => {
			shell.classList.toggle("is-sidebar-collapsed", event.detail.collapsed);
		});
		header.addEventListener("open-initiative", (event) => {
			event.stopPropagation();
			this.dispatchEvent(new CustomEvent("open-initiative", { bubbles: true, composed: true }));
		});
		this.querySelector("kanban-tab-bar-draft").addEventListener("entity-view-change", (event) => entityView.setAttribute("view", event.detail.view));
		entityView.addEventListener("open-issue", (event) => {
			event.stopPropagation();
			this.dispatchEvent(new CustomEvent("open-issue", { bubbles: true, composed: true, detail: event.detail }));
		});
	}
}

customElements.define("kanban-app-shell-draft", KanbanAppShellDraft);