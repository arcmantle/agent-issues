const variants = new Set(["primary", "secondary", "quiet", "destructive"]);

export class KanbanButtonDraft extends HTMLElement {
	connectedCallback() {
		const label = this.getAttribute("label") ?? "Continue";
		const requestedVariant = this.getAttribute("variant") ?? "primary";
		const variant = variants.has(requestedVariant) ? requestedVariant : "primary";
		const isLoading = this.hasAttribute("loading");
		const isDisabled = this.hasAttribute("disabled") || isLoading;
		const busy = isLoading ? ' aria-busy="true"' : "";
		const disabled = isDisabled ? " disabled" : "";
		const indicator = isLoading ? '<span class="button-spinner" aria-hidden="true"></span>' : "";

		this.innerHTML = `<button class="command-button is-${variant}" type="button"${busy}${disabled}>${indicator}<span>${label}</span></button>`;
	}
}

customElements.define("kanban-button-draft", KanbanButtonDraft);