const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanEmptyStateDraft extends HTMLElement {
	static get observedAttributes() {
		return ["action-label", "heading", "message"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const heading = this.getAttribute("heading") ?? "No records yet";
		const message = this.getAttribute("message") ?? "Create the first record to begin this view.";
		const actionLabel = this.getAttribute("action-label") ?? "Create record";
		this.innerHTML = `<section class="empty-state" aria-labelledby="empty-state-heading"><span class="empty-state-mark" aria-hidden="true"></span><div class="empty-state-content"><h2 id="empty-state-heading">${escapeHtml(heading)}</h2><p>${escapeHtml(message)}</p></div><button class="empty-state-action" type="button">${escapeHtml(actionLabel)}</button></section>`;
		this.querySelector(".empty-state-action").addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("empty-state-action", { bubbles: true }));
		});
	}
}

customElements.define("kanban-empty-state-draft", KanbanEmptyStateDraft);