const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

let selectMenuId = 0;

export class KanbanSelectMenuDraft extends HTMLElement {
	static get observedAttributes() {
		return ["disabled", "label", "name", "options", "value"];
	}

	connectedCallback() {
		this.selectId ??= this.id || `select-menu-${++selectMenuId}`;
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const label = this.getAttribute("label") ?? "Select an option";
		const name = this.getAttribute("name") ?? "selection";
		const value = this.getAttribute("value") ?? "";
		const options = (this.getAttribute("options") ?? "").split("|").filter(Boolean);
		const disabled = this.hasAttribute("disabled");
		const optionMarkup = options.map((option) => `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(option)}</option>`).join("");
		this.innerHTML = `<div class="select-menu"><label for="${escapeHtml(this.selectId)}">${escapeHtml(label)}</label><select id="${escapeHtml(this.selectId)}" name="${escapeHtml(name)}"${disabled ? " disabled" : ""}>${optionMarkup}</select></div>`;
		this.querySelector("select").addEventListener("change", (event) => {
			const nextValue = event.currentTarget.value;
			this.setAttribute("value", nextValue);
			this.dispatchEvent(new CustomEvent("select-menu-change", {
				bubbles: true,
				detail: { name, value: nextValue }
			}));
		});
	}
}

customElements.define("kanban-select-menu-draft", KanbanSelectMenuDraft);