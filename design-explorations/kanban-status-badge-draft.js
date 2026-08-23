const variantByStatus = {
	active: "active",
	accepted: "active",
	blocked: "blocked",
	done: "active",
	draft: "muted",
	"in progress": "active",
	open: "default",
	proposed: "muted",
	ready: "default",
	review: "default",
	todo: "default",
	triaged: "muted"
};

export class KanbanStatusBadgeDraft extends HTMLElement {
	static get observedAttributes() {
		return ["status"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const status = this.getAttribute("status") ?? "Todo";
		const variant = variantByStatus[status.toLowerCase()] ?? "default";
		this.innerHTML = `<span class="status-badge is-${variant}">${status}</span>`;
	}
}

customElements.define("kanban-status-badge-draft", KanbanStatusBadgeDraft);