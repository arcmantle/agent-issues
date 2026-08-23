import "./kanban-skeleton-draft.js";

const layouts = [
	["card", "Kanban card"],
	["table", "Record table"],
	["panel", "Record panel"]
];

export class KanbanLoadingStateDraft extends HTMLElement {
	connectedCallback() {
		this.innerHTML = `<section class="loading-state" aria-busy="true" aria-live="polite"><header class="loading-state-header"><span class="loading-state-label">Loading</span><p>Preparing record data</p></header><div class="loading-state-layouts">${layouts.map(([layout, label]) => `<section class="loading-state-layout"><h2>${label}</h2><kanban-skeleton-draft layout="${layout}"></kanban-skeleton-draft></section>`).join("")}</div></section>`;
	}
}

customElements.define("kanban-loading-state-draft", KanbanLoadingStateDraft);