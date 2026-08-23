export class KanbanFieldDisplayDraft extends HTMLElement {
	static get observedAttributes() {
		return ["label", "value", "multiline"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const label = this.getAttribute("label") ?? "Field";
		const value = this.getAttribute("value") ?? "No value";
		const isMultiline = this.hasAttribute("multiline");
		const field = document.createElement("dl");
		field.className = `field-display ${isMultiline ? "is-multiline" : ""}`;
		const fieldLabel = document.createElement("dt");
		fieldLabel.textContent = label;
		const fieldValue = document.createElement("dd");
		fieldValue.textContent = value;
		field.append(fieldLabel, fieldValue);
		this.replaceChildren(field);
	}
}

customElements.define("kanban-field-display-draft", KanbanFieldDisplayDraft);