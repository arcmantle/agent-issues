const variantByPriority = {
	design: "medium",
	high: "high",
	medium: "medium",
	low: "low",
	product: "medium",
	technical: "low"
};

export class KanbanPriorityBadgeDraft extends HTMLElement {
	static get observedAttributes() {
		return ["priority"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const priority = this.getAttribute("priority") ?? "Medium";
		const variant = variantByPriority[priority.toLowerCase()] ?? "low";
		this.innerHTML = `<span class="priority-badge is-${variant}">${priority}</span>`;
	}
}

customElements.define("kanban-priority-badge-draft", KanbanPriorityBadgeDraft);