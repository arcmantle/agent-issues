const defaultMessages = {
	success: "Changes saved",
	warning: "Some changes need attention",
	failure: "Could not save changes"
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanToastNotificationDraft extends HTMLElement {
	static get observedAttributes() {
		return ["message", "tone"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const tone = ["success", "warning", "failure"].includes(this.getAttribute("tone"))
			? this.getAttribute("tone")
			: "success";
		const message = this.getAttribute("message") ?? defaultMessages[tone];
		this.innerHTML = `<section class="toast-notification toast-notification-${tone}" role="status" aria-live="polite"><span class="toast-notification-icon" aria-hidden="true"></span><p>${escapeHtml(message)}</p><button class="toast-notification-dismiss" type="button" aria-label="Dismiss notification">x</button></section>`;
		this.querySelector(".toast-notification-dismiss").addEventListener("click", () => this.dismiss());
	}

	dismiss() {
		this.hidden = true;
		this.dispatchEvent(new CustomEvent("toast-dismiss", { bubbles: true }));
	}
}

customElements.define("kanban-toast-notification-draft", KanbanToastNotificationDraft);