const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanConfirmDialogDraft extends HTMLElement {
	constructor() {
		super();
		this.handleKeydown = this.handleKeydown.bind(this);
	}

	static get observedAttributes() {
		return ["confirm-label", "message", "open", "title"];
	}

	connectedCallback() {
		document.addEventListener("keydown", this.handleKeydown);
		this.render();
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this.handleKeydown);
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	handleKeydown(event) {
		if (event.key === "Escape" && this.hasAttribute("open")) this.close("cancel");
	}

	close(action) {
		this.removeAttribute("open");
		this.dispatchEvent(new CustomEvent(action, { bubbles: true }));
	}

	render() {
		if (!this.hasAttribute("open")) {
			this.innerHTML = "";
			return;
		}

		const title = this.getAttribute("title") ?? "Delete issue?";
		const message = this.getAttribute("message") ?? "This action cannot be undone.";
		const confirmLabel = this.getAttribute("confirm-label") ?? "Delete issue";
		this.innerHTML = `<div class="confirm-dialog-scrim" aria-hidden="true"></div><section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="confirm-dialog-mark" aria-hidden="true">!</div><div class="confirm-dialog-content"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></div><div class="confirm-dialog-actions"><button class="confirm-dialog-cancel" type="button">Cancel</button><button class="confirm-dialog-confirm" type="button">${escapeHtml(confirmLabel)}</button></div></section>`;
		this.querySelector(".confirm-dialog-scrim").addEventListener("click", () => this.close("cancel"));
		this.querySelector(".confirm-dialog-cancel").addEventListener("click", () => this.close("cancel"));
		this.querySelector(".confirm-dialog-confirm").addEventListener("click", () => this.close("confirm"));
		requestAnimationFrame(() => this.querySelector(".confirm-dialog-cancel")?.focus());
	}
}

customElements.define("kanban-confirm-dialog-draft", KanbanConfirmDialogDraft);