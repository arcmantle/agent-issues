const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

let nextCommentEditorId = 0;

export class KanbanCommentItemDraft extends HTMLElement {
	static get observedAttributes() {
		return ["author", "editable", "message", "time"];
	}

	connectedCallback() {
		this.editorId ??= `comment-editor-${nextCommentEditorId += 1}`;
		this.isEditing = false;
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	render() {
		const author = this.getAttribute("author") ?? "R. Lee";
		const time = this.getAttribute("time") ?? "Today";
		const message = this.getAttribute("message") ?? "Keep server behavior identical for local and cloud workspaces.";
		const editable = this.hasAttribute("editable");
		const actions = editable
			? `<div class="comment-item-actions"><button type="button" data-edit>Edit</button><button type="button" data-delete>Delete</button></div>`
			: "";
		const content = this.isEditing
			? `<form class="comment-item-editor"><label for="${this.editorId}">Edit comment</label><textarea id="${this.editorId}" name="message" rows="3">${escapeHtml(message)}</textarea><div><button type="button" data-cancel>Cancel</button><button type="submit">Publish edit</button></div></form>`
			: `<p>${escapeHtml(message)}</p>`;
		this.innerHTML = `<article class="comment-item"><header><strong>${escapeHtml(author)}</strong><div class="comment-item-meta"><time>${escapeHtml(time)}</time>${actions}</div></header>${content}</article>`;

		if (!editable) return;
		this.querySelector("[data-edit]")?.addEventListener("click", () => {
			this.isEditing = true;
			this.render();
			this.querySelector("textarea")?.focus();
		});
		this.querySelector("[data-delete]")?.addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("comment-delete", { bubbles: true }));
		});
		this.querySelector("[data-cancel]")?.addEventListener("click", () => {
			this.isEditing = false;
			this.render();
		});
		this.querySelector("form")?.addEventListener("submit", (event) => {
			event.preventDefault();
			const updatedMessage = this.querySelector("textarea").value.trim();
			if (!updatedMessage) return;
			this.isEditing = false;
			this.dispatchEvent(new CustomEvent("comment-edit", { bubbles: true, detail: { message: updatedMessage } }));
		});
	}
}

customElements.define("kanban-comment-item-draft", KanbanCommentItemDraft);