const iconByAction = {
	close: "&times;",
	create: "+",
	collapse: "&lsaquo;",
	overflow: "&hellip;"
};

const defaultLabelByAction = {
	close: "Close",
	create: "Create",
	collapse: "Collapse",
	overflow: "More actions"
};

export class KanbanIconButtonDraft extends HTMLElement {
	connectedCallback() {
		const action = this.getAttribute("action") ?? "overflow";
		const label = this.getAttribute("label") ?? defaultLabelByAction[action] ?? defaultLabelByAction.overflow;
		const isDisabled = this.hasAttribute("disabled");
		const isLoading = this.hasAttribute("loading");
		const icon = iconByAction[action] ?? iconByAction.overflow;
		const state = isLoading ? " is-loading" : "";
		const disabled = isDisabled || isLoading ? " disabled" : "";
		const busy = isLoading ? ' aria-busy="true"' : "";

		this.innerHTML = `<button class="icon-button${state}" type="button" aria-label="${label}" title="${label}"${busy}${disabled}><span aria-hidden="true">${icon}</span></button>`;
	}
}

customElements.define("kanban-icon-button-draft", KanbanIconButtonDraft);