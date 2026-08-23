import "./kanban-comment-composer-draft.js";
import "./kanban-comment-item-draft.js";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;"
}[character]));

export class KanbanCommentThreadDraft extends HTMLElement {
	static get observedAttributes() {
		return ["author", "message", "time", "empty", "label", "owned"];
	}

	connectedCallback() {
		this.comments = [];
		this.nextCommentId = 0;
		this.initialComment = this.getInitialComment();
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) {
			this.initialComment = this.getInitialComment();
			this.render();
		}
	}

	getInitialComment() {
		if (this.hasAttribute("empty")) return null;
		return {
			id: "initial",
			author: this.getAttribute("author") ?? "R. Lee",
			time: this.getAttribute("time") ?? "Today",
			message: this.getAttribute("message") ?? "Keep server behavior identical for local and cloud workspaces.",
			owned: this.hasAttribute("owned")
		};
	}

	focus() {
		this.querySelector("kanban-comment-composer-draft")?.focus();
	}

	render() {
		const label = this.getAttribute("label") ?? "Comments";
		const comments = [this.initialComment, ...this.comments].filter(Boolean);
		const content = comments.length === 0
			? "<p class=\"comment-thread-empty\">No comments yet. Start the discussion for this record.</p>"
			: comments.map((comment) => `<kanban-comment-item-draft data-comment-id="${comment.id}" author="${escapeHtml(comment.author)}" time="${escapeHtml(comment.time)}" message="${escapeHtml(comment.message)}"${comment.owned ? " editable" : ""}></kanban-comment-item-draft>`).join("");

		this.innerHTML = `<section class="comment-thread" aria-label="${escapeHtml(label)}"><div class="comment-thread-list" aria-live="polite">${content}</div><kanban-comment-composer-draft></kanban-comment-composer-draft></section>`;
		this.querySelector("kanban-comment-composer-draft").addEventListener("post-comment", (event) => {
			this.comments.push({ id: `comment-${this.nextCommentId += 1}`, author: "You", time: "Now", message: event.detail.message, owned: true });
			this.render();
		});
		this.querySelectorAll("kanban-comment-item-draft").forEach((commentItem) => {
			const commentId = commentItem.dataset.commentId;
			commentItem.addEventListener("comment-edit", (event) => {
				if (commentId === "initial") {
					this.initialComment = { ...this.initialComment, message: event.detail.message };
					this.render();
					return;
				}
				this.comments = this.comments.map((comment) => comment.id === commentId ? { ...comment, message: event.detail.message } : comment);
				this.render();
			});
			commentItem.addEventListener("comment-delete", () => {
				if (commentId === "initial") {
					this.initialComment = null;
					this.render();
					return;
				}
				this.comments = this.comments.filter((comment) => comment.id !== commentId);
				this.render();
			});
		});
	}
}

customElements.define("kanban-comment-thread-draft", KanbanCommentThreadDraft);