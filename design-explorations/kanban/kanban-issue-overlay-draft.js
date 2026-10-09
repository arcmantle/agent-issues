import "./kanban-icon-button-draft.js";
import "./kanban-status-badge-draft.js";
import "./kanban-priority-badge-draft.js";
import "./kanban-field-editor-draft.js";
import "./kanban-record-summary-draft.js";
import "./kanban-relationship-list-draft.js";
import "./kanban-unsaved-changes-draft.js";
import "./kanban-comment-thread-draft.js";
import "./kanban-popover-menu-draft.js";
import "./kanban-select-menu-draft.js";
import "./kanban-record-detail-panel-draft.js";

export class KanbanIssueOverlayDraft extends HTMLElement {
	connectedCallback() {
		this.issue = {
			reference: this.getAttribute("reference") ?? "ISS-322",
			title: this.getAttribute("title") ?? "Define the board-server write contract",
			category: this.getAttribute("category") ?? "High",
			detail: this.getAttribute("detail") ?? "2 blockers",
			status: this.getAttribute("status") ?? "Todo",
			description: this.getAttribute("description") ?? "Define the server-facing write boundary that applies issue updates and relationship changes through the active storage driver.",
			relationships: [
				{ kind: "Initiative", title: "Editable Kanban board", relation: "Parent" },
				{ kind: "Issue", title: "Start detached Kanban server", relation: "Blocks" },
				{ kind: "PRD", title: "Editable Kanban board", relation: "Context" }
			]
		};
		this.render();
		if (this.hasAttribute("open")) {
			this.open();
		}
	}

	setIssue(issue) {
		this.issue = { ...this.issue, ...issue };
		this.render();
		this.open();
	}

	render() {
		const { reference, title, category, detail, status, description } = this.issue;
		const pending = this.hasAttribute("pending") ? " pending" : "";
		this.innerHTML = `
			<kanban-record-detail-panel-draft label="Issue details"${this.hasAttribute("open") ? " open" : ""}>
				<div data-record-detail-panel-header class="issue-overlay-header"><kanban-record-summary-draft reference="${reference}" title="${title}" metadata="Issue · ${detail}" owner="R. Lee"></kanban-record-summary-draft><div class="issue-overlay-actions"><kanban-popover-menu-draft label="Issue actions"></kanban-popover-menu-draft><kanban-icon-button-draft action="close" label="Close issue details" data-close-issue></kanban-icon-button-draft></div></div>
				<div data-record-detail-panel-meta class="issue-overlay-meta"><kanban-status-badge-draft status="${status}"></kanban-status-badge-draft><kanban-priority-badge-draft priority="${category}"></kanban-priority-badge-draft><kanban-unsaved-changes-draft${pending}></kanban-unsaved-changes-draft><span>${detail}</span><span>${reference}</span></div>
				<div data-record-detail-panel-content class="issue-overlay-content">
					<kanban-field-editor-draft label="Title" name="title" value="${title}"></kanban-field-editor-draft>
					<kanban-field-editor-draft label="Status" name="status" type="select" value="${status}" options="Todo|In progress|Blocked|Done"></kanban-field-editor-draft>
					<kanban-field-editor-draft label="Description" name="description" type="description" value="${description}"></kanban-field-editor-draft>
					<section class="issue-section"><div class="issue-section-heading"><h3>Relationships</h3><button aria-label="Add relationship">+</button></div><kanban-relationship-list-draft></kanban-relationship-list-draft></section>
					<section class="issue-section"><div class="issue-section-heading"><h3>Comments</h3><button aria-label="Add comment" data-focus-composer>+</button></div><kanban-comment-thread-draft></kanban-comment-thread-draft></section>
				</div>
			</kanban-record-detail-panel-draft>
		`;
		this.querySelector("kanban-relationship-list-draft").setRelationships(this.issue.relationships);
		this.querySelectorAll("[data-close-issue]").forEach((button) => button.addEventListener("click", () => this.close()));
		this.querySelector("kanban-record-detail-panel-draft").addEventListener("record-detail-panel-close", () => this.removeAttribute("open"));
		this.querySelectorAll("kanban-field-editor-draft").forEach((editor) => editor.addEventListener("field-editor-change", (event) => {
			this.issue[event.detail.name] = event.detail.value;
			this.render();
		}));
		const commentThread = this.querySelector("kanban-comment-thread-draft");
		this.querySelector("[data-focus-composer]").addEventListener("click", () => commentThread.focus());
	}

	open() {
		this.setAttribute("open", "");
		this.querySelector("kanban-record-detail-panel-draft").open();
	}

	close() {
		this.querySelector("kanban-record-detail-panel-draft").close();
	}
}

customElements.define("kanban-issue-overlay-draft", KanbanIssueOverlayDraft);
