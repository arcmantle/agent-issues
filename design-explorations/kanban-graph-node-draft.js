const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanGraphNodeDraft extends HTMLElement {
	connectedCallback() {
		const reference = this.getAttribute("reference") ?? "Record";
		const title = this.getAttribute("title") ?? "Untitled record";
		const tone = this.getAttribute("tone");
		const toneClass = ["root", "accent", "warning"].includes(tone) ? ` is-${tone}` : "";
		const safeReference = escapeHtml(reference);
		const safeTitle = escapeHtml(title);
		this.innerHTML = `<article class="graph-node${toneClass}" tabindex="0" aria-label="${safeReference}: ${safeTitle}"><span>${safeReference}</span><strong>${safeTitle}</strong></article>`;
	}
}

customElements.define("kanban-graph-node-draft", KanbanGraphNodeDraft);