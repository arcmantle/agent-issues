const layoutContent = {
	card: `<div class="skeleton-card" aria-hidden="true"><span class="skeleton-block skeleton-title"></span><span class="skeleton-block skeleton-line"></span><span class="skeleton-block skeleton-line is-short"></span><div class="skeleton-card-meta"><span class="skeleton-block skeleton-chip"></span><span class="skeleton-block skeleton-meta"></span></div></div>`,
	table: `<div class="skeleton-table" aria-hidden="true"><div class="skeleton-table-head"><span class="skeleton-block skeleton-heading"></span><span class="skeleton-block skeleton-heading"></span><span class="skeleton-block skeleton-heading"></span></div><div class="skeleton-table-row"><span class="skeleton-block skeleton-cell"></span><span class="skeleton-block skeleton-cell"></span><span class="skeleton-block skeleton-cell is-short"></span></div><div class="skeleton-table-row"><span class="skeleton-block skeleton-cell"></span><span class="skeleton-block skeleton-cell"></span><span class="skeleton-block skeleton-cell is-short"></span></div><div class="skeleton-table-row"><span class="skeleton-block skeleton-cell"></span><span class="skeleton-block skeleton-cell"></span><span class="skeleton-block skeleton-cell is-short"></span></div></div>`,
	panel: `<div class="skeleton-panel" aria-hidden="true"><div class="skeleton-panel-header"><span class="skeleton-block skeleton-kicker"></span><span class="skeleton-block skeleton-panel-title"></span></div><span class="skeleton-block skeleton-line"></span><span class="skeleton-block skeleton-line"></span><span class="skeleton-block skeleton-line is-short"></span><div class="skeleton-panel-section"><span class="skeleton-block skeleton-kicker"></span><span class="skeleton-block skeleton-line"></span><span class="skeleton-block skeleton-line is-short"></span></div></div>`
};

export class KanbanSkeletonDraft extends HTMLElement {
	static get observedAttributes() {
		return ["layout"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const layout = this.getAttribute("layout") ?? "card";
		const content = layoutContent[layout] ?? layoutContent.card;
		this.setAttribute("role", "status");
		this.setAttribute("aria-label", `Loading ${layout === "panel" ? "record panel" : layout}`);
		this.setAttribute("aria-busy", "true");
		this.innerHTML = content;
	}
}

customElements.define("kanban-skeleton-draft", KanbanSkeletonDraft);