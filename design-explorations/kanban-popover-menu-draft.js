const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

const actions = [
	["edit", "Edit issue"],
	["duplicate", "Duplicate issue"],
	["archive", "Archive issue"]
];

export class KanbanPopoverMenuDraft extends HTMLElement {
	constructor() {
		super();
		this.handleKeydown = this.handleKeydown.bind(this);
	}

	static get observedAttributes() {
		return ["label", "open"];
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
		if (event.key === "Escape" && this.hasAttribute("open")) {
			event.preventDefault();
			this.close();
			this.querySelector(".popover-menu-trigger")?.focus();
		}
	}

	open() {
		this.setAttribute("open", "");
	}

	close() {
		this.removeAttribute("open");
	}

	render() {
		const label = this.getAttribute("label") ?? "Issue actions";
		const isOpen = this.hasAttribute("open");
		const openState = isOpen ? " is-open" : "";
		const expanded = String(isOpen);
		const menu = actions.map(([action, actionLabel]) => `<button type="button" role="menuitem" data-action="${action}">${actionLabel}</button>`).join("");
		this.innerHTML = `<div class="popover-menu${openState}"><button class="popover-menu-trigger" type="button" aria-haspopup="menu" aria-expanded="${expanded}">${escapeHtml(label)}<span aria-hidden="true">...</span></button><div class="popover-menu-list" role="menu" aria-label="${escapeHtml(label)}"${isOpen ? "" : " hidden"}>${menu}</div></div>`;
		this.querySelector(".popover-menu-trigger").addEventListener("click", () => this.toggleAttribute("open"));
		this.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("popover-action", {
				bubbles: true,
				detail: { action: button.dataset.action }
			}));
			this.close();
		}));
	}
}

customElements.define("kanban-popover-menu-draft", KanbanPopoverMenuDraft);