const defaultTree = [
	{
		id: "project-agent-issues",
		kind: "Project",
		label: "Agent Issues",
		children: [
			{
				id: "epic-platform-foundations",
				kind: "Epic",
				label: "Platform foundations",
				children: [
					{
						id: "initiative-editable-kanban-board",
						kind: "Initiative",
						label: "Editable Kanban board",
						children: [
							{ id: "issue-navigation-tree", kind: "Issue", label: "Draft Navigation tree component", current: true },
							{ id: "issue-board-contract", kind: "Issue", label: "Define the board-server write contract" }
						]
					}
				]
			},
			{
				id: "epic-workflow-intelligence",
				kind: "Epic",
				label: "Workflow intelligence",
				children: [
					{ id: "initiative-planning-models", kind: "Initiative", label: "Planning models" },
					{ id: "initiative-review-history", kind: "Initiative", label: "Review history" }
				]
			}
		]
	}
];

export class KanbanNavigationTreeDraft extends HTMLElement {
	static get observedAttributes() {
		return ["empty"];
	}

	connectedCallback() {
		this.expandedIds ??= new Set(["project-agent-issues", "epic-platform-foundations", "initiative-editable-kanban-board"]);
		this.render();
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	renderItem(item) {
		const children = item.children ?? [];
		const isExpanded = this.expandedIds.has(item.id);
		const childContent = children.length > 0 && isExpanded
			? `<ul>${children.map((child) => this.renderItem(child)).join("")}</ul>`
			: "";
		const control = children.length > 0
			? `<button class="navigation-tree-toggle" type="button" data-toggle-id="${item.id}" aria-expanded="${isExpanded}" aria-label="${isExpanded ? "Collapse" : "Expand"} ${item.kind} ${item.label}"><span aria-hidden="true">${isExpanded ? "−" : "+"}</span></button>`
			: "<span class=\"navigation-tree-spacer\" aria-hidden=\"true\"></span>";
		const current = item.current ? " aria-current=\"page\"" : "";

		return `<li class="navigation-tree-item navigation-tree-item--${item.kind.toLowerCase()}">${control}<button class="navigation-tree-record${item.current ? " is-current" : ""}" type="button"${current}>${item.label}<span>${item.kind}</span></button>${childContent}</li>`;
	}

	render() {
		const content = this.hasAttribute("empty")
			? "<p class=\"navigation-tree-empty\">No records are available in this project yet.</p>"
			: `<ul>${defaultTree.map((item) => this.renderItem(item)).join("")}</ul>`;
		this.innerHTML = `<nav class="navigation-tree" aria-label="Project, epic, initiative, and record navigation">${content}</nav>`;
		this.querySelectorAll("[data-toggle-id]").forEach((button) => button.addEventListener("click", () => {
			const { toggleId } = button.dataset;
			if (this.expandedIds.has(toggleId)) this.expandedIds.delete(toggleId);
			else this.expandedIds.add(toggleId);
			this.render();
		}));
	}
}

customElements.define("kanban-navigation-tree-draft", KanbanNavigationTreeDraft);