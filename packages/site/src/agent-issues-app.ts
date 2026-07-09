import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
import { choose } from "lit/directives/choose.js";
import { classMap } from "lit/directives/class-map.js";
import { map } from "lit/directives/map.js";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";
import "./components/cascade-view.js";
import "./components/context-view.js";
import "./components/initiative-detail-view.js";
import "./components/issue-detail-view.js";
import "./components/relationship-graph.js";
import type { AdrRailEntry, ConsoleSection, ContextPageTab, Entity, InitiativeBundle, ProjectContextTermEntry, ProjectContextTermSource } from "./models.js";
import { AgentIssuesStore } from "./services/agent-issues-store.js";
import { issueBrowserControlStyles, issueBrowserTokenStyles, issueBrowserTypographyStyles } from "./styles/issue-browser-shared-styles.js";

const SWITCHER_MENU_ID = "tenant-switcher-menu";

class AgentIssuesApp extends SignalWatcher(LitElement) {
	public store = new AgentIssuesStore();

	protected onSelectTenant = (event: Event) => {
		const tenantId = (event.currentTarget as HTMLElement).dataset.tenant;
		if (!tenantId) {
			return;
		}

		void this.store.selectTenant(tenantId);
	};

	protected onSelectSection = (event: Event) => {
		const section = (event.currentTarget as HTMLElement).dataset.section as ConsoleSection | undefined;
		if (!section) {
			return;
		}

		this.store.selectSection(section);
	};

	protected onSelectInitiative = (event: Event) => {
		const initiativeId = (event.currentTarget as HTMLElement).dataset.initiative;
		if (!initiativeId) {
			return;
		}

		this.store.selectInitiative(initiativeId);
	};

	protected onSelectEntity = (event: Event) => {
		const entityId = (event.currentTarget as HTMLElement).dataset.id;
		if (!entityId) {
			return;
		}

		this.store.selectEntity(entityId);
	};

	protected onSearchInput = (event: Event) => {
		this.store.search.set((event.target as HTMLInputElement).value);
	};

	protected onToggleRail = () => {
		this.store.toggleRail();
	};

	protected onToggleMaster = () => {
		this.store.toggleMaster();
	};

	protected onContextSearchInput = (event: Event) => {
		this.store.contextSearch.set((event.target as HTMLInputElement).value);
	};

	protected onSetContextTab = (event: Event) => {
		const tab = (event.currentTarget as HTMLElement).dataset.contextTab as ContextPageTab | undefined;
		if (!tab) {
			return;
		}

		this.store.setContextTab(tab);
	};

	protected onProjectNodeOpen = (event: Event) => {
		const { id, kind } = (event as CustomEvent<{ id: string; kind: string }>).detail;
		if (!id) {
			return;
		}

		if (kind === "initiative") {
			this.store.selectInitiative(id);
			return;
		}

		this.store.selectEntity(id);
	};

	connectedCallback(): void {
		super.connectedCallback();
		this.store.connect();
	}

	disconnectedCallback(): void {
		this.store.disconnect();
		super.disconnectedCallback();
	}

	protected renderSwitcherMenu() {
		const tenantOptions = this.store.tenantOptions.get();
		const selectedTenant = this.store.selectedTenant.get();

		return html`
		<div
			class="menu"
			id=${SWITCHER_MENU_ID}
			popover
		>
			${repeat(
				tenantOptions,
				(tenant) => tenant.id,
				(tenant) => html`
				<button
					class="menu-item"
					data-tenant=${tenant.id}
					popovertarget=${SWITCHER_MENU_ID}
					popovertargetaction="hide"
					@click=${this.onSelectTenant}
				>
					<span class="check">${when(tenant.id === selectedTenant, () => html`✓`, () => nothing)}</span>
					<span class="avatar small">${tenant.displayName.charAt(0)}</span>
					<span class="sw-text">
						<span class="sw-name">${tenant.displayName}</span>
						<span class="sw-sub">${when(tenant.id === selectedTenant, () => html`current project`, () => html`open project`)}</span>
					</span>
				</button>
				`
			)}
		</div>
		`;
	}

	protected renderRail() {
		const store = this.store;
		const projectName = store.selectedTenantDisplayName.get() ?? "Project";
		const section = store.activeSection.get();
		const navItems: Array<{ count: string; icon: string; label: string; section: ConsoleSection }> = [
			{ count: String(store.projectInitiatives.get().length), icon: "📁", label: "Initiatives", section: "initiatives" },
			{ count: String(store.adrRailEntries.get().length), icon: "📐", label: "ADRs", section: "adrs" },
			{ count: String(store.projectContextTerms.get().length), icon: "📖", label: "Context", section: "context" },
			{ count: "map", icon: "🕸️", label: "Graph", section: "graph" }
		];

		return html`
		<aside class="rail" data-pane="rail">
			<button
				class="pane-collapse"
				data-collapse="rail"
				title=${store.railCollapsed.get() ? "Expand rail" : "Collapse rail"}
				@click=${this.onToggleRail}
			>
				${store.railCollapsed.get() ? "»" : "«"}
			</button>
			<div class="rail-switcher">
				<button
					class="switcher-button"
					popovertarget=${SWITCHER_MENU_ID}
				>
					<span class="avatar">${projectName.charAt(0)}</span>
					<span class="sw-text">
						<span class="sw-name">${projectName}</span>
						<span class="sw-sub">Switch project</span>
					</span>
					<span class="sw-caret">⇅</span>
				</button>
				${this.renderSwitcherMenu()}
			</div>
			<nav class="rail-nav">
				<div class="nav-group-label">Plan</div>
				${map(
					navItems,
					(item) => html`
					<button
						class=${classMap({ active: section === item.section, "nav-item": true })}
						data-section=${item.section}
						data-tenant-nav=${item.section}
						@click=${this.onSelectSection}
					>
						<span class="nav-icon">${item.icon}</span>
						<span class="nav-label">${item.label}</span>
						<span class="nav-count">${item.count}</span>
					</button>
					`
				)}
				<div class="nav-group-label totals">Totals</div>
				<div class="nav-item static">
					<span class="nav-icon">📝</span>
					<span class="nav-label">User stories</span>
					<span class="nav-count">${store.projectStoryCount.get()}</span>
				</div>
				<div class="nav-item static">
					<span class="nav-icon">⊙</span>
					<span class="nav-label">Issues</span>
					<span class="nav-count">${store.projectIssueCount.get()}</span>
				</div>
			</nav>
			<div class="rail-foot">${store.projectDescription.get()}</div>
		</aside>
		`;
	}

	protected renderInitiativeCard(bundle: InitiativeBundle) {
		const store = this.store;
		const stats = store.initiativeStats(bundle);
		const summary = store.getContextForInitiative(bundle.initiative.id)?.context.summary ?? "No initiative-specific context is available yet.";

		return html`
		<button
			class=${classMap({ active: store.activeInitiativeId.get() === bundle.initiative.id, "m-item": true })}
			data-initiative=${bundle.initiative.id}
			@click=${this.onSelectInitiative}
		>
			<div class="m-top">
				<span class="m-title">${bundle.initiative.title}</span>
				<span class=${`badge ${store.badgeTone(bundle.initiative.status)}`}>${bundle.initiative.status}</span>
			</div>
			<div class="m-sub">${summary}</div>
			<div class="m-meta">
				<span><b>${stats.stories}</b> stories</span>
				<span><b>${stats.done}/${stats.issues}</b> issues</span>
				<span><b>${stats.adrs}</b> ADRs</span>
			</div>
			<div class="miniprog"><span style=${`width:${stats.pct}%`}></span></div>
		</button>
		`;
	}

	protected renderAdrCard(entry: AdrRailEntry) {
		const store = this.store;
		const adr = entry.adr;

		return html`
		<button
			class=${classMap({ active: store.selectedId.get() === adr.id, "m-item": true })}
			data-id=${adr.id}
			data-scope=${entry.scope}
			@click=${this.onSelectEntity}
		>
			<div class="m-top">
				<span class="m-title">${adr.title}</span>
				<span class=${`badge ${store.badgeTone(adr.status)}`}>${adr.status}</span>
			</div>
			<div class="m-meta">
				<span class="idtag">${adr.id}</span>
				<span>${entry.scopeLabel}</span>
				<span>updated ${store.formatTimestamp(adr.updatedAt)}</span>
			</div>
		</button>
		`;
	}

	protected renderProjectContextSource(source: ProjectContextTermSource) {
		const scopeLabel = source.scopeKind === "default" ? "Shared context" : source.scopeLabel;

		return html`
		<div
			class="ctx-source"
			data-scope=${source.scopeKind}
		>
			<div class="ctx-source-head">
				<span class="ctx-scope">${scopeLabel}</span>
				<span class="ctx-source-title">${source.contextTitle}</span>
			</div>
			<p class="ctx-def">${source.definition}</p>
			${when(
				source.avoid.length > 0,
				() => html`
				<div class="ctx-avoid">
					<span class="ctx-avoid-label">Avoid</span>
					${repeat(source.avoid, (phrase) => phrase, (phrase) => html`<span class="ctx-avoid-chip">${phrase}</span>`)}
				</div>
				`,
				() => nothing
			)}
		</div>
		`;
	}

	protected renderProjectContextTerm(entry: ProjectContextTermEntry) {
		const duplicateLabel = entry.hasConflictingDefinitions
			? `conflicting definitions across ${entry.sources.length} scopes`
			: `defined in ${entry.sources.length} scopes`;

		return html`
		<article
			class="ctx-term"
			data-term=${entry.term}
		>
			<div class="ctx-top">
				<span class="ctx-name">${entry.term}</span>
				${when(entry.hasSharedSource, () => html`<span class="ctx-badge shared">shared</span>`, () => nothing)}
				${when(entry.hasDuplicates, () => html`<span class="ctx-badge warn">${duplicateLabel}</span>`, () => nothing)}
			</div>
			<div class="ctx-sources">
				${repeat(
					entry.sources,
					(source) => `${source.contextKey}:${source.scopeLabel}`,
					(source) => this.renderProjectContextSource(source)
				)}
			</div>
		</article>
		`;
	}

	protected renderSharedContextPanel() {
		return html`
		<section class="ctx-block">
			<div class="ctx-section-head">
				<div>
					<h2 class="ctx-section-title">Shared context</h2>
					<p class="ctx-section-copy">Project-canonical terms and preferred language that should be safe anywhere in this tenant.</p>
				</div>
			</div>
			<agent-issues-context-view
				.context=${this.store.filteredSharedContext.get()}
				.emptyMessage=${"No shared context matches the current search."}
			></agent-issues-context-view>
		</section>
		`;
	}

	protected renderInitiativeContextIndexPanel() {
		const store = this.store;
		const totalTerms = store.projectContextTerms.get().length;
		const duplicateCount = store.projectContextDuplicateCount.get();
		const initiativeCount = store.initiativeContextById.get().size;
		const stats = [
			`${totalTerms} discovered terms`,
			`${initiativeCount} initiative contexts`,
			duplicateCount > 0 ? `${duplicateCount} duplicate labels` : null
		]
			.filter((value): value is string => Boolean(value))
			.join(" · ");
		const filteredTerms = store.filteredProjectContextTerms.get();

		return html`
		<section class="ctx-block">
			<div class="ctx-section-head">
				<div>
					<h2 class="ctx-section-title">Initiative term index</h2>
					<p class="ctx-section-copy">Discover initiative-local terminology without flattening it into project-canonical language.</p>
				</div>
				<div class="ctx-stats">${stats}</div>
			</div>
			${when(
				filteredTerms.length > 0,
				() => html`
				<div class="ctx-list">
					${repeat(filteredTerms, (entry) => entry.term, (entry) => this.renderProjectContextTerm(entry))}
				</div>
				`,
				() => html`<p class="ctx-empty">No initiative-scoped terms match the current search.</p>`
			)}
		</section>
		`;
	}

	protected renderMaster() {
		const store = this.store;
		const section = store.activeSection.get();
		const query = store.search.get().trim().toLowerCase();
		const isAdrs = section === "adrs";

		const initiatives = store
			.projectInitiatives
			.get()
			.filter((bundle) => `${bundle.initiative.title} ${bundle.initiative.id}`.toLowerCase().includes(query));
		const adrEntries = store.adrRailEntries.get().filter((entry) => `${entry.adr.title} ${entry.adr.id}`.toLowerCase().includes(query));

		return html`
		<section class="master" data-pane="master">
			<button
				class="pane-collapse"
				data-collapse="master"
				title=${store.masterCollapsed.get() ? "Expand list" : "Collapse list"}
				@click=${this.onToggleMaster}
			>
				${store.masterCollapsed.get() ? "»" : "«"}
			</button>
			<div class="master-head">
				<h1>${when(isAdrs, () => html`Architecture decisions`, () => html`Initiatives`)}</h1>
				<p>${when(
					isAdrs,
					() => html`Open a decision to read its context, decision and consequences.`,
					() => html`Select an initiative to explore its issues and user stories.`
				)}</p>
				<input
					class="master-search"
					placeholder="Filter…"
					.value=${store.search.get()}
					@input=${this.onSearchInput}
				/>
			</div>
			<div class="master-list">
				${when(
					isAdrs,
					() => html`${repeat(adrEntries, (entry) => entry.adr.id, (entry) => this.renderAdrCard(entry))}`,
					() => html`${repeat(initiatives, (bundle) => bundle.initiative.id, (bundle) => this.renderInitiativeCard(bundle))}`
				)}
			</div>
		</section>
		`;
	}

	protected renderDetail() {
		const store = this.store;
		const section = store.activeSection.get();
		const selectedInitiativeId = store.selectedInitiativeId.get();
		const selectedId = store.selectedId.get();

		if (section === "context") {
			const sharedContext = store.sharedContext.get();
			const contextTab = store.contextTab.get();
			const searchPlaceholder = {
				all: "Search all context…",
				global: "Search shared context…",
				initiatives: "Search initiative terminology…"
			}[contextTab];

			return html`
			<section class="detail" data-pane="detail">
				<div class="detail-inner wide-inner">
					<div class="ai-crumbs">${store.selectedTenantDisplayName.get()} · Context</div>
					<h1 class="d-title">${sharedContext?.context.title ?? "Project context"}</h1>
					<p class="d-sub">Shared glossary plus initiative-scoped term discovery, with scope preserved so local language stays findable without becoming silently global.</p>
					<div class="ctx-controls">
						<input
							class="master-search"
							placeholder=${searchPlaceholder}
							.value=${store.contextSearch.get()}
							@input=${this.onContextSearchInput}
						/>
						<div class="ctx-tabs">
							${repeat(
								[
									{ label: "All", tab: "all" },
									{ label: "Global", tab: "global" },
									{ label: "Initiatives", tab: "initiatives" }
								],
								(item) => item.tab,
								(item) => html`
								<button
									class=${classMap({ active: contextTab === item.tab, "ctx-tab": true })}
									data-context-tab=${item.tab}
									@click=${this.onSetContextTab}
								>
									${item.label}
								</button>
								`
							)}
						</div>
					</div>
					<div class="ctx-shell">
						${choose(contextTab, [
							["all", () => html`${this.renderSharedContextPanel()}${this.renderInitiativeContextIndexPanel()}`],
							["global", () => html`${this.renderSharedContextPanel()}`],
							["initiatives", () => html`${this.renderInitiativeContextIndexPanel()}`]
						])}
					</div>
				</div>
			</section>
			`;
		}

		if (section === "graph") {
			return html`
			<section class="detail" data-pane="detail">
				<div class="detail-inner wide-inner">
					<div class="ai-crumbs">${store.selectedTenantDisplayName.get()} · Graph</div>
					<h1 class="d-title">Project relationship graph</h1>
					<p class="d-sub">Every initiative and its PRDs &amp; ADRs. Click an initiative or record to open it.</p>
					<div class="ai-graph-wrap">
						<div class="ai-graph-legend">
							<span class="lg"><span class="sw" style="background:#24292f"></span>Project</span>
							<span class="lg"><span class="sw" style="background:#0969da"></span>Initiative</span>
							<span class="lg"><span class="sw" style="background:#1f883d"></span>PRD</span>
							<span class="lg"><span class="sw" style="background:#8250df"></span>ADR</span>
							<span class="ai-graph-hint">Tip: hover a node for its full title</span>
						</div>
						<div class="graph-host">
							<agent-issues-relationship-graph
								.graph=${store.buildProjectGraph()}
								@node-open=${this.onProjectNodeOpen}
							></agent-issues-relationship-graph>
						</div>
					</div>
				</div>
			</section>
			`;
		}

		if (store.cascadePath.get().length > 0) {
			return html`
			<section class="detail" data-pane="detail">
				<agent-issues-cascade-view .store=${store}></agent-issues-cascade-view>
			</section>
			`;
		}

		if (selectedId) {
			return html`
			<section class="detail" data-pane="detail">
				<agent-issues-detail-view .store=${store}></agent-issues-detail-view>
			</section>
			`;
		}

		if (selectedInitiativeId) {
			return html`
			<section class="detail" data-pane="detail">
				<agent-issues-initiative-detail-view .store=${store}></agent-issues-initiative-detail-view>
			</section>
			`;
		}

		return html`
		<section class="detail" data-pane="detail">
			<div class="empty">
				<div>
					<div class="empty-glyph">🗂️</div>
					<p>Select ${when(section === "adrs", () => html`an ADR`, () => html`an initiative`)} from the list</p>
				</div>
			</div>
		</section>
		`;
	}

	render() {
		const store = this.store;
		const section = store.activeSection.get();
		const wide = section === "graph" || section === "context";
		const railCollapsed = store.railCollapsed.get();
		const masterCollapsed = !wide && store.masterCollapsed.get();

		return html`
		<div class=${classMap({ console: true, wide, "rail-collapsed": railCollapsed, "master-collapsed": masterCollapsed })}>
			${this.renderRail()}
			${when(!wide, () => this.renderMaster(), () => nothing)}
			${this.renderDetail()}
		</div>
		`;
	}

	static styles = [
		issueBrowserTokenStyles,
		issueBrowserTypographyStyles,
		issueBrowserControlStyles,
		css`
		:host {
			display: block;
			height: 100vh;
			background: var(--page-bg);
			color: var(--text);
		}
		.console {
			display: grid;
			grid-template-columns: 256px 380px 1fr;
			height: stretch;
			overflow: hidden;
		}
		.console.wide {
			grid-template-columns: 256px 1fr;
		}
		.console.rail-collapsed {
			grid-template-columns: 44px 380px 1fr;
		}
		.console.wide.rail-collapsed {
			grid-template-columns: 44px 1fr;
		}
		.console.master-collapsed {
			grid-template-columns: 256px 44px 1fr;
		}
		.console.rail-collapsed.master-collapsed {
			grid-template-columns: 44px 44px 1fr;
		}
		.console.rail-collapsed .rail-switcher,
		.console.rail-collapsed .rail-nav,
		.console.rail-collapsed .rail-foot,
		.console.master-collapsed .master-head,
		.console.master-collapsed .master-list {
			display: none;
		}
		.pane-collapse {
			display: flex;
			flex-shrink: 0;
			align-items: center;
			justify-content: center;
			align-self: flex-end;
			width: 24px;
			height: 24px;
			margin: 8px;
			padding: 0;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--muted);
			font-size: 13px;
			line-height: 1;
			cursor: pointer;
		}
		.pane-collapse:hover {
			border-color: var(--accent);
			color: var(--text);
		}
		.console.rail-collapsed .rail .pane-collapse,
		.console.master-collapsed .master .pane-collapse {
			align-self: center;
		}
		.rail {
			display: flex;
			flex-direction: column;
			overflow: hidden;
			background: var(--rail-bg);
			border-right: 1px solid var(--border);
		}
		.rail-switcher {
			position: relative;
			padding: 12px;
			border-bottom: 1px solid var(--border-muted);
		}
		.switcher-button {
			display: flex;
			gap: 10px;
			align-items: center;
			width: stretch;
			padding: 8px 10px;
			border: 1px solid var(--border);
			border-radius: 8px;
			background: var(--surface);
			cursor: pointer;
			text-align: left;
			anchor-name: --switcher-anchor;
		}
		.switcher-button:hover {
			background: var(--surface-muted);
		}
		.avatar {
			display: grid;
			flex-shrink: 0;
			place-items: center;
			width: 28px;
			height: 28px;
			border-radius: 6px;
			background: linear-gradient(135deg, #0969da, #8250df);
			color: #fff;
			font-size: 13px;
			font-weight: 700;
		}
		.avatar.small {
			width: 24px;
			height: 24px;
			font-size: 11px;
		}
		.sw-text {
			display: grid;
		}
		.sw-name {
			font-weight: 600;
		}
		.sw-sub {
			color: var(--muted);
			font-size: 12px;
		}
		.sw-caret {
			margin-left: auto;
			color: var(--muted);
		}
		.menu {
			position: fixed;
			position-anchor: --switcher-anchor;
			top: anchor(bottom);
			left: anchor(left);
			right: anchor(right);
			margin: 0;
			margin-top: 4px;
			z-index: 40;
			overflow: hidden;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface);
			box-shadow: 0 12px 28px rgba(31, 35, 40, 0.18);
		}
		.menu-item {
			display: flex;
			gap: 10px;
			align-items: center;
			width: stretch;
			padding: 10px 12px;
			border: 0;
			background: transparent;
			cursor: pointer;
			text-align: left;
		}
		.menu-item:hover {
			background: var(--surface-muted);
		}
		.menu-item .check {
			width: 14px;
			color: var(--accent);
		}
		.rail-nav {
			flex: 1;
			overflow-y: auto;
			padding: 12px 8px;
		}
		.nav-group-label {
			padding: 8px 12px 4px;
			color: var(--muted);
			font-size: 11px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.nav-group-label.totals {
			margin-top: 8px;
		}
		.nav-item {
			display: flex;
			gap: 10px;
			align-items: center;
			width: stretch;
			padding: 7px 12px;
			border: 0;
			border-radius: 6px;
			background: transparent;
			color: var(--text);
			cursor: pointer;
			text-align: left;
		}
		.nav-item:hover {
			background: var(--surface-muted);
		}
		.nav-item.active {
			background: var(--accent-soft);
			color: var(--accent);
			font-weight: 600;
		}
		.nav-item.static {
			color: var(--muted);
			cursor: default;
		}
		.nav-item.static:hover {
			background: transparent;
		}
		.nav-label {
			flex: 1;
		}
		.nav-count {
			margin-left: auto;
			color: var(--muted);
			font-size: 12px;
		}
		.nav-item.active .nav-count {
			color: var(--accent);
		}
		.rail-foot {
			padding: 12px;
			border-top: 1px solid var(--border-muted);
			color: var(--muted);
			font-size: 12px;
		}
		.master {
			display: flex;
			flex-direction: column;
			overflow: hidden;
			background: var(--surface);
			border-right: 1px solid var(--border);
		}
		.master-head {
			padding: 16px;
			border-bottom: 1px solid var(--border-muted);
		}
		.master-head h1 {
			font-size: 16px;
		}
		.master-head p {
			margin: 4px 0 0;
			color: var(--muted);
			font-size: 13px;
		}
		.master-search {
			margin-top: 12px;
			background: var(--surface-muted);
		}
		.master-list {
			flex: 1;
			overflow-y: auto;
		}
		.m-item {
			display: block;
			width: stretch;
			padding: 14px 16px;
			border: 0;
			border-bottom: 1px solid var(--border-muted);
			background: transparent;
			cursor: pointer;
			text-align: left;
		}
		.m-item:hover {
			background: var(--surface-muted);
		}
		.m-item.active {
			background: var(--accent-soft);
			box-shadow: inset 3px 0 0 var(--accent);
		}
		.m-top {
			display: flex;
			gap: 8px;
			justify-content: space-between;
			align-items: center;
		}
		.m-title {
			font-size: 14px;
			font-weight: 600;
		}
		.m-sub {
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
			margin-top: 4px;
			color: var(--muted);
			font-size: 12px;
			line-height: 1.4;
		}
		.m-meta {
			display: flex;
			gap: 10px;
			margin-top: 8px;
			color: var(--muted);
			font-size: 12px;
		}
		.m-meta b {
			color: var(--text);
		}
		.idtag {
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
		}
		.miniprog {
			overflow: hidden;
			height: 4px;
			margin-top: 10px;
			border-radius: 999px;
			background: #eaeef2;
		}
		.miniprog > span {
			display: block;
			height: 100%;
			background: var(--done);
		}
		.detail {
			overflow-y: auto;
		}
		.detail-inner {
			max-width: 920px;
			margin: 0 auto;
			padding: 28px 32px 64px;
		}
		.wide-inner {
			max-width: none;
		}
		.ai-crumbs {
			color: var(--muted);
			font-size: 12px;
		}
		.d-title {
			margin: 6px 0 0;
			font-size: 24px;
		}
		.d-sub {
			max-width: 70ch;
			margin: 10px 0 0;
			color: var(--muted);
		}
		.ctx-controls {
			display: grid;
			gap: 14px;
			margin-top: 18px;
		}
		.ctx-tabs {
			display: flex;
			gap: 18px;
			border-bottom: 1px solid var(--border-muted);
		}
		.ctx-tab {
			padding: 8px 2px;
			border: 0;
			border-bottom: 2px solid transparent;
			background: transparent;
			color: var(--muted);
			cursor: pointer;
			font: inherit;
		}
		.ctx-tab.active {
			border-bottom-color: #fd8c73;
			color: var(--text);
			font-weight: 600;
		}
		.ctx-shell {
			display: grid;
			gap: 18px;
			margin-top: 16px;
		}
		.ctx-block {
			padding: 16px;
			border: 1px solid var(--border);
			border-radius: 12px;
			background: var(--surface);
		}
		.ctx-section-head {
			display: flex;
			gap: 16px;
			justify-content: space-between;
			align-items: baseline;
		}
		.ctx-section-title {
			margin: 0;
			font-size: 16px;
		}
		.ctx-section-copy {
			margin: 4px 0 0;
			color: var(--muted);
		}
		.ctx-stats {
			color: var(--muted);
			font-size: 12px;
			text-align: right;
		}
		.ctx-list {
			display: grid;
			gap: 12px;
			margin-top: 14px;
		}
		.ctx-term {
			padding: 14px 16px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface-muted);
		}
		.ctx-top {
			display: flex;
			gap: 8px;
			align-items: center;
			flex-wrap: wrap;
		}
		.ctx-name {
			font-size: 16px;
			font-weight: 600;
		}
		.ctx-badge {
			padding: 2px 8px;
			border-radius: 999px;
			font-size: 12px;
			font-weight: 600;
		}
		.ctx-badge.shared {
			background: #ddf4ff;
			color: #0969da;
		}
		.ctx-badge.warn {
			background: #fff8c5;
			color: #9a6700;
		}
		.ctx-sources {
			display: grid;
			gap: 10px;
			margin-top: 12px;
		}
		.ctx-source {
			padding-left: 12px;
			border-left: 3px solid var(--border);
		}
		.ctx-source[data-scope="default"] {
			border-left-color: #0969da;
		}
		.ctx-source[data-scope="initiative"] {
			border-left-color: #1f883d;
		}
		.ctx-source-head {
			display: flex;
			gap: 8px;
			align-items: baseline;
			flex-wrap: wrap;
		}
		.ctx-scope {
			font-weight: 600;
		}
		.ctx-source-title {
			color: var(--muted);
			font-size: 12px;
		}
		.ctx-def {
			max-width: 75ch;
			margin: 6px 0 0;
		}
		.ctx-avoid {
			display: flex;
			gap: 6px;
			align-items: center;
			flex-wrap: wrap;
			margin-top: 8px;
		}
		.ctx-avoid-label {
			color: var(--muted);
			font-size: 11px;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.ctx-avoid-chip {
			padding: 2px 8px;
			border: 1px solid var(--border);
			border-radius: 999px;
			background: var(--surface);
			color: var(--muted);
			font-size: 12px;
		}
		.ctx-empty {
			margin: 14px 0 0;
			color: var(--muted);
		}
		.ai-graph-wrap {
			margin-top: 18px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background:
				radial-gradient(circle, rgba(208, 215, 222, 0.5) 1px, transparent 1px) 0 0 / 22px 22px,
				var(--surface);
			overflow: auto;
		}
		.ai-graph-legend {
			display: flex;
			gap: 16px;
			flex-wrap: wrap;
			padding: 10px 14px;
			border-bottom: 1px solid var(--border-muted);
			font-size: 12px;
			color: var(--muted);
			background: var(--surface);
			position: sticky;
			top: 0;
			z-index: 1;
		}
		.ai-graph-legend .lg {
			display: inline-flex;
			gap: 6px;
			align-items: center;
		}
		.ai-graph-legend .sw {
			width: 10px;
			height: 10px;
			border-radius: 50%;
		}
		.ai-graph-hint {
			margin-left: auto;
		}
		.graph-host {
			padding: 0;
		}
		.empty {
			display: grid;
			place-items: center;
			height: stretch;
			color: var(--muted);
			text-align: center;
		}
		.empty-glyph {
			font-size: 40px;
		}
		@media (max-width: 900px) {
			.console,
			.console.wide {
				grid-template-columns: 1fr;
				height: auto;
				overflow: visible;
			}
		}
		`
	];
}

customElements.define("agent-issues-app", AgentIssuesApp);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-app": AgentIssuesApp;
	}
	interface HTMLElementEventMap {
		"agent-issues-app-event": CustomEvent<{ detail: string }>;
	}
}