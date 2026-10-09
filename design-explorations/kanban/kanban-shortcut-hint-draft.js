export class KanbanShortcutHintDraft extends HTMLElement {
	static get observedAttributes() {
		return ["keys"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const defaultKeys = ["Cmd", "K"];
		const requestedKeys = (this.getAttribute("keys") ?? defaultKeys.join("+")).split("+").filter(Boolean);
		const keys = requestedKeys.length ? requestedKeys : defaultKeys;
		this.setAttribute("aria-label", `Keyboard shortcut: ${keys.join(" plus ")}`);
		const hint = document.createElement("span");
		hint.className = "shortcut-hint";
		keys.forEach((key, index) => {
			if (index > 0) {
				const separator = document.createElement("span");
				separator.className = "shortcut-separator";
				separator.setAttribute("aria-hidden", "true");
				separator.textContent = "+";
				hint.append(separator);
			}
			const keyLabel = document.createElement("kbd");
			keyLabel.textContent = key;
			hint.append(keyLabel);
		});
		this.replaceChildren(hint);
	}
}

customElements.define("kanban-shortcut-hint-draft", KanbanShortcutHintDraft);