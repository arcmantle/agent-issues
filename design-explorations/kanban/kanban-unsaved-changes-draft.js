export class KanbanUnsavedChangesDraft extends HTMLElement {
	static get observedAttributes() {
		return ["pending"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const pending = this.hasAttribute("pending");
		this.hidden = !pending;
		this.innerHTML = `<span class="unsaved-changes-indicator" role="status" aria-live="polite"><span class="unsaved-changes-marker" aria-hidden="true"></span><span>Unsaved changes</span></span>`;
	}
}

customElements.define("kanban-unsaved-changes-draft", KanbanUnsavedChangesDraft);