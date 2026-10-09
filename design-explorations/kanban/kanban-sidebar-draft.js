import "./kanban-navigation-tree-draft.js";

export class KanbanSidebarDraft extends HTMLElement {
	connectedCallback() {
		this.render();
	}

	render() {
		const collapsed = this.hasAttribute("collapsed");
		this.innerHTML = `
			<aside class="sidebar-shell ${collapsed ? "is-collapsed" : ""}" aria-label="Project and initiative navigation">
				<div class="brand"><span class="brand-mark">A</span><span class="sidebar-wide">agent-issues</span><button class="sidebar-collapse" aria-label="${collapsed ? "Expand sidebar" : "Collapse sidebar"}">${collapsed ? "›" : "‹"}</button></div>
				<kanban-navigation-tree-draft${collapsed ? " hidden" : ""}></kanban-navigation-tree-draft>
			</aside>
		`;

		this.querySelector(".sidebar-collapse").addEventListener("click", () => {
			const nextCollapsed = !collapsed;
			this.toggleAttribute("collapsed", nextCollapsed);
			this.dispatchEvent(new CustomEvent("sidebar-collapse", { bubbles: true, detail: { collapsed: nextCollapsed } }));
			this.render();
		});
	}
}

customElements.define("kanban-sidebar-draft", KanbanSidebarDraft);
