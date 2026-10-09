export class KanbanRecordDetailPanelDraft extends HTMLElement {
	constructor() {
		super();
		this.handleKeydown = this.handleKeydown.bind(this);
	}

	static get observedAttributes() {
		return ["label", "open"];
	}

	connectedCallback() {
		const header = this.querySelector("[data-record-detail-panel-header]");
		const meta = this.querySelector("[data-record-detail-panel-meta]");
		const content = this.querySelector("[data-record-detail-panel-content]");
		this.innerHTML = `<div class="record-detail-panel-scrim"></div><aside class="record-detail-panel" role="dialog" aria-modal="true"><header class="record-detail-panel-header"></header><div class="record-detail-panel-meta"></div><div class="record-detail-panel-content"></div></aside>`;
		if (header) this.querySelector(".record-detail-panel-header").append(header);
		if (meta) this.querySelector(".record-detail-panel-meta").append(meta);
		if (content) this.querySelector(".record-detail-panel-content").append(content);
		this.querySelector(".record-detail-panel-scrim").addEventListener("click", () => this.close());
		document.addEventListener("keydown", this.handleKeydown);
		this.updateState();
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this.handleKeydown);
	}

	attributeChangedCallback() {
		if (this.isConnected) this.updateState();
	}

	handleKeydown(event) {
		if (event.key === "Escape" && this.hasAttribute("open")) this.close();
	}

	open() {
		this.setAttribute("open", "");
	}

	close() {
		this.removeAttribute("open");
		this.dispatchEvent(new CustomEvent("record-detail-panel-close", { bubbles: true }));
	}

	updateState() {
		const open = this.hasAttribute("open");
		const panel = this.querySelector(".record-detail-panel");
		if (!panel) return;
		panel.setAttribute("aria-hidden", String(!open));
		panel.setAttribute("aria-label", this.getAttribute("label") ?? "Record details");
	}
}

customElements.define("kanban-record-detail-panel-draft", KanbanRecordDetailPanelDraft);