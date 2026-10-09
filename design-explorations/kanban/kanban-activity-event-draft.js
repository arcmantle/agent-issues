const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanActivityEventDraft extends HTMLElement {
	connectedCallback() {
		const time = this.getAttribute("time") ?? "Today, 10:24";
		const summary = this.getAttribute("summary") ?? "R. Lee moved ISS-318 to In progress";
		const detail = this.getAttribute("detail") ?? "Keep pending edits stable through snapshot refresh";
		const tone = this.getAttribute("tone");
		const toneClass = ["accent", "warning"].includes(tone) ? ` is-${tone}` : "";
		this.innerHTML = `<article class="activity-event"><time>${escapeHtml(time)}</time><span class="activity-event-marker${toneClass}" aria-hidden="true"></span><div><h3>${escapeHtml(summary)}</h3><p>${escapeHtml(detail)}</p></div></article>`;
	}
}

customElements.define("kanban-activity-event-draft", KanbanActivityEventDraft);