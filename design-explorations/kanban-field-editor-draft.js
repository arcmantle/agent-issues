let fieldEditorId = 0;

export class KanbanFieldEditorDraft extends HTMLElement {
	static get observedAttributes() {
		return ["disabled", "label", "name", "options", "placeholder", "required", "type", "value"];
	}

	connectedCallback() {
		this.controlId ??= this.id || `field-editor-${++fieldEditorId}`;
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const label = this.getAttribute("label") ?? "Field";
		const name = this.getAttribute("name") ?? "field";
		const value = this.getAttribute("value") ?? "";
		const type = this.getAttribute("type") ?? "text";
		const control = type === "select"
			? this.createSelect(name, value)
			: type === "description"
				? this.createDescription(name, value)
				: this.createTextInput(name, value);
		const field = document.createElement("div");
		const fieldLabel = document.createElement("label");

		field.className = `field-editor field-editor--${type}`;
		fieldLabel.htmlFor = this.controlId;
		fieldLabel.textContent = label;
		field.append(fieldLabel, control);
		this.replaceChildren(field);
		control.addEventListener("change", () => {
			this.setAttribute("value", control.value);
			this.dispatchEvent(new CustomEvent("field-editor-change", {
				bubbles: true,
				detail: { name, value: control.value }
			}));
		});
	}

	createTextInput(name, value) {
		const input = document.createElement("input");
		input.id = this.controlId;
		input.name = name;
		input.type = "text";
		input.value = value;
		input.placeholder = this.getAttribute("placeholder") ?? "";
		input.disabled = this.hasAttribute("disabled");
		input.required = this.hasAttribute("required");
		return input;
	}

	createSelect(name, value) {
		const select = document.createElement("select");
		const options = (this.getAttribute("options") ?? "").split("|").filter(Boolean);

		select.id = this.controlId;
		select.name = name;
		select.disabled = this.hasAttribute("disabled");
		select.required = this.hasAttribute("required");
		options.forEach((option) => {
			const optionElement = document.createElement("option");
			optionElement.value = option;
			optionElement.textContent = option;
			optionElement.selected = option === value;
			select.append(optionElement);
		});
		return select;
	}

	createDescription(name, value) {
		const textarea = document.createElement("textarea");
		textarea.id = this.controlId;
		textarea.name = name;
		textarea.rows = 5;
		textarea.value = value;
		textarea.placeholder = this.getAttribute("placeholder") ?? "";
		textarea.disabled = this.hasAttribute("disabled");
		textarea.required = this.hasAttribute("required");
		return textarea;
	}
}

customElements.define("kanban-field-editor-draft", KanbanFieldEditorDraft);