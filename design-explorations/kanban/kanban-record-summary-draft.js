const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanRecordSummaryDraft extends HTMLElement {
	static get observedAttributes() {
		return ["reference", "title", "metadata", "owner"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const reference = this.getAttribute("reference") ?? "ISS-322";
		const title = this.getAttribute("title") ?? "Untitled record";
		const metadata = this.getAttribute("metadata") ?? "Issue";
		const owner = this.getAttribute("owner") ?? "Unassigned";
		this.innerHTML = `<article class="record-summary"><div class="record-summary-primary"><span>${escapeHtml(reference)}</span><h2>${escapeHtml(title)}</h2></div><dl class="record-summary-details"><div><dt>Metadata</dt><dd>${escapeHtml(metadata)}</dd></div><div><dt>Owner</dt><dd>${escapeHtml(owner)}</dd></div></dl></article>`;
	}
}

customElements.define("kanban-record-summary-draft", KanbanRecordSummaryDraft);