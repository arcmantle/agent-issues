const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanNoResultsStateDraft extends HTMLElement {
	static get observedAttributes() {
		return ["query"];
	}

	connectedCallback() {
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const query = this.getAttribute("query") ?? "this search";
		this.innerHTML = `<section class="no-results-state" aria-labelledby="no-results-state-heading"><span class="no-results-state-mark" aria-hidden="true"></span><div class="no-results-state-content"><h2 id="no-results-state-heading">No results for &quot;${escapeHtml(query)}&quot;</h2><p>Try a different search or clear the active filters to see records.</p></div><button class="no-results-state-action" type="button">Clear search</button></section>`;
		this.querySelector(".no-results-state-action").addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("clear-search", { bubbles: true }));
		});
	}
}

customElements.define("kanban-no-results-state-draft", KanbanNoResultsStateDraft);