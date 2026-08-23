const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanErrorStateDraft extends HTMLElement {
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
		const heading = this.getAttribute("heading") ?? "We could not load this view";
		const message = this.getAttribute("message") ?? "Check your connection and try again.";
		const actionLabel = this.getAttribute("action-label") ?? "Try again";
		this.innerHTML = `<section class="error-state" aria-labelledby="error-state-heading" role="alert"><span class="error-state-mark" aria-hidden="true">!</span><div class="error-state-content"><h2 id="error-state-heading">${escapeHtml(heading)}</h2><p>${escapeHtml(message)}</p></div><button class="error-state-action" type="button">${escapeHtml(actionLabel)}</button></section>`;
		this.querySelector(".error-state-action").addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("retry", { bubbles: true }));
		});
	}
}

customElements.define("kanban-error-state-draft", KanbanErrorStateDraft);