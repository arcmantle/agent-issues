export class KanbanTabBarDraft extends HTMLElement {
	connectedCallback() {
		this.innerHTML = `<nav class="entity-tabs" aria-label="Initiative entity views">${[
			["issues", "Issues"],
			["plans", "Plans"],
			["prds", "PRDs"],
			["adrs", "ADRs"],
			["debt", "Debt"],
			["graph", "Graph"],
			["activity", "Activity"]
		].map(([view, label], index) => `<button class="entity-tab ${index === 0 ? "is-active" : ""}" data-view="${view}">${label}</button>`).join("")}</nav>`;
		this.querySelectorAll(".entity-tab").forEach((tab) => {
			tab.addEventListener("click", () => {
				this.querySelectorAll(".entity-tab").forEach((item) => item.classList.remove("is-active"));
				tab.classList.add("is-active");
				this.dispatchEvent(new CustomEvent("entity-view-change", {
					bubbles: true,
					composed: true,
					detail: { view: tab.dataset.view }
				}));
			});
		});
	}
}

customElements.define("kanban-tab-bar-draft", KanbanTabBarDraft);
