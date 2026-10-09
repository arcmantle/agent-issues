export class KanbanMobileNavigationDrawerDraft extends HTMLElement {
	static get observedAttributes() {
		return ["open"];
	}

	connectedCallback() {
		this.render();
		document.addEventListener("keydown", this.handleKeydown);
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this.handleKeydown);
	}

	attributeChangedCallback() {
		if (this.isConnected) this.render();
	}

	open() {
		this.setAttribute("open", "");
	}

	close() {
		this.removeAttribute("open");
		this.dispatchEvent(new CustomEvent("mobile-navigation-drawer-close", { bubbles: true }));
	}

	handleKeydown = (event) => {
		if (event.key === "Escape" && this.hasAttribute("open")) this.close();
	};

	render() {
		const isOpen = this.hasAttribute("open");
		this.innerHTML = `
			<button class="mobile-navigation-drawer-scrim" type="button" aria-label="Close navigation"></button>
			<aside class="mobile-navigation-drawer${isOpen ? " is-open" : ""}" aria-label="Project and initiative navigation" aria-hidden="${String(!isOpen)}"${isOpen ? "" : " inert"}>
				<header class="mobile-navigation-drawer-header"><div class="mobile-navigation-brand"><span class="mobile-navigation-brand-mark">A</span><span>agent-issues</span></div><button class="mobile-navigation-drawer-close" type="button" aria-label="Close navigation" title="Close navigation">&times;</button></header>
				<div class="mobile-navigation-project"><span class="mobile-navigation-label">Project</span><button type="button">Agent Issues <span aria-hidden="true">&#8964;</span></button></div>
				<nav class="mobile-navigation-list" aria-label="Initiatives"><section><h2>Platform foundations</h2><button class="is-active" type="button">Editable Kanban board <code>ISS-MHZGDK</code></button><button type="button">Local daemon <code>INIT-DAEMON</code></button></section><section><h2>Workflow intelligence</h2><button type="button">Planning models <code>INIT-PLANS</code></button><button type="button">Review history <code>INIT-HISTORY</code></button></section></nav>
			</aside>
		`;

		this.querySelector(".mobile-navigation-drawer-scrim").addEventListener("click", () => this.close());
		this.querySelector(".mobile-navigation-drawer-close").addEventListener("click", () => this.close());
	}
}

customElements.define("kanban-mobile-navigation-drawer-draft", KanbanMobileNavigationDrawerDraft);