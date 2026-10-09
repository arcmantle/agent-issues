const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

let nextComposerId = 0;

export class KanbanCommentComposerDraft extends HTMLElement {
	connectedCallback() {
		this.inputId ??= `comment-message-${nextComposerId += 1}`;
		this.render();
	}

	focus() {
		this.querySelector("textarea")?.focus();
	}

	render() {
		const placeholder = this.getAttribute("placeholder") ?? "Write a comment";
		const postLabel = this.getAttribute("post-label") ?? "Post comment";
		this.innerHTML = `<form class="comment-composer"><label class="comment-composer-label" for="${this.inputId}">New comment</label><textarea id="${this.inputId}" name="message" rows="3" placeholder="${escapeHtml(placeholder)}"></textarea><div class="comment-composer-actions"><span>Comments are visible to project members.</span><button type="submit" disabled>${escapeHtml(postLabel)}</button></div></form>`;

		const form = this.querySelector("form");
		const message = this.querySelector("textarea");
		const submit = this.querySelector("button");
		message.addEventListener("input", () => {
			submit.disabled = message.value.trim().length === 0;
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const value = message.value.trim();
			if (!value) return;
			this.dispatchEvent(new CustomEvent("post-comment", { bubbles: true, detail: { message: value } }));
			message.value = "";
			submit.disabled = true;
		});
	}
}

customElements.define("kanban-comment-composer-draft", KanbanCommentComposerDraft);