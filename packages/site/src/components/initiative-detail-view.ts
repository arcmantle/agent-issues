import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { choose } from "lit/directives/choose.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { when } from "lit/directives/when.js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import "./context-view.js";
import "./relationship-graph.js";
import type { Entity, HandoffRecord, InitiativeTab } from "../models.js";
import type { AgentIssuesStore } from "../services/agent-issues-store.js";
import { issueBrowserControlStyles, issueBrowserTokenStyles, issueBrowserTypographyStyles } from "../styles/issue-browser-shared-styles.js";

function renderMarkdownBody(markdown: string): string {
	const rawHtml = marked.parse(markdown, { async: false });
	return DOMPurify.sanitize(rawHtml);
}

type IssueTreeNode = {
	issue: Entity;
	children: IssueTreeNode[];
};

class InitiativeDetailView extends SignalWatcher(LitElement) {
	static properties = {
		store: { attribute: false },
		initiativeId: { attribute: false },
		cascade: { attribute: false },
		activeChildId: { attribute: false }
	};

	public store: AgentIssuesStore | null = null;
	public initiativeId: string | null = null;
	public cascade = false;
	public activeChildId: string | null = null;
	protected collapsedIssueIds = new Set<string>();
	protected collapsedOverviewSectionIds = new Set<string>();

	protected activeBundle() {
		const store = this.store;
		if (!store) {
			return null;
		}

		return store.bundleForInitiativeId(this.initiativeId ?? store.selectedInitiativeId.get());
	}

	protected onSelectEntityClick = (event: Event) => {
		if (this.cascade) {
			const childId = (event.currentTarget as HTMLElement).dataset.id;
			if (childId && this.initiativeId) {
				this.store?.drillCascade(this.initiativeId, childId);
			}

			return;
		}

		this.store?.selectEntityFromEvent(event);
	};

	protected onSetTab = (event: Event) => {
		const tab = (event.currentTarget as HTMLElement).dataset.tab as InitiativeTab | undefined;
		if (!tab) {
			return;
		}

		this.store?.setInitTab(tab);
	};

	protected onNodeOpen = (event: Event) => {
		const id = (event as CustomEvent<{ id: string }>).detail.id;
		if (!id) {
			return;
		}

		this.store?.selectEntity(id);
	};

	protected onToggleIssueBranch = (event: Event) => {
		event.stopPropagation();
		const issueId = (event.currentTarget as HTMLElement).dataset.id;
		if (!issueId) {
			return;
		}

		if (this.collapsedIssueIds.has(issueId)) {
			this.collapsedIssueIds.delete(issueId);
		} else {
			this.collapsedIssueIds.add(issueId);
		}

		this.requestUpdate();
	};

	protected onToggleOverviewSection = (event: Event) => {
		const sectionId = (event.currentTarget as HTMLElement).dataset.sectionId;
		if (!sectionId) {
			return;
		}

		if (this.collapsedOverviewSectionIds.has(sectionId)) {
			this.collapsedOverviewSectionIds.delete(sectionId);
		} else {
			this.collapsedOverviewSectionIds.add(sectionId);
		}

		this.requestUpdate();
	};

	protected renderBodySourceNotice() {
		return html`
		<div class="ai-body-source ai-body-source-generated">
			<span class="ai-body-source-badge">Generated fallback</span>
			<span class="ai-body-source-copy">Generated from tracker metadata because no authored body was present.</span>
		</div>
		`;
	}

	protected renderIssueBranch(node: IssueTreeNode): TemplateResult {
		const store = this.store;
		if (!store) {
			return html``;
		}

		const isCollapsed = this.collapsedIssueIds.has(node.issue.id);

		return html`
		<div class="issue-branch">
			<div class="issue-branch-row">
				${when(
					node.children.length > 0,
					() => html`
					<button
						class="branch-toggle"
						data-id=${node.issue.id}
						aria-expanded=${String(!isCollapsed)}
						@click=${this.onToggleIssueBranch}
					>
						${isCollapsed ? "+" : "-"}
					</button>
					`,
					() => html`<span class="branch-spacer"></span>`
				)}
				<button
					class=${`child issue-branch-head ${node.issue.id === this.activeChildId ? "is-active-ref" : ""}`}
					data-id=${node.issue.id}
					@click=${this.onSelectEntityClick}
				>
				<span class="idtag">${node.issue.id}</span>
				<span class=${`issue-dot ${store.issueStatusTone(node.issue.status)}`}></span>
				<span class="child-title">${node.issue.title}</span>
				<span class=${`badge ${store.badgeTone(node.issue.status)}`}>${node.issue.status}</span>
				</button>
			</div>
			${when(
				node.children.length > 0 && !isCollapsed,
				() => html`
				<div class="issue-branch-children">
					${repeat(node.children, (child) => child.issue.id, (child) => this.renderIssueBranch(child))}
				</div>
				`,
				() => nothing
			)}
		</div>
		`;
	}

	protected renderStoryBlock(story: Entity) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const bundle = this.activeBundle();
		const issueTree = bundle ? store.issueTreeForStory(bundle, story.id) : [];

		return html`
		<div class="story-block">
			<button
				class=${`story-head ${story.id === this.activeChildId ? "is-active-ref" : ""}`}
				data-id=${story.id}
				@click=${this.onSelectEntityClick}
			>
				<span class="idtag">${story.id}</span>
				<span class="s-title">${story.title}</span>
				<span class=${`badge ${store.badgeTone(story.status)}`}>${story.status}</span>
				<span class="chev">›</span>
			</button>
			${when(
				issueTree.length > 0,
				() => html`<div class="children issue-tree">${repeat(issueTree, (node) => node.issue.id, (node) => this.renderIssueBranch(node))}</div>`,
				() => html`<div class="children empty-children">No issues fix this story yet.</div>`
			)}
		</div>
		`;
	}

	protected renderOverviewSection(
		sectionId: string,
		title: string,
		body: TemplateResult,
		options: { count?: string; sectionClassName?: string } = {}
	): TemplateResult {
		const isCollapsed = this.collapsedOverviewSectionIds.has(sectionId);
		const sectionClassName = options.sectionClassName ? `sec ${options.sectionClassName}` : "sec";

		return html`
		<section class=${sectionClassName}>
			<button
				class="sec-toggle"
				data-section-id=${sectionId}
				aria-expanded=${String(!isCollapsed)}
				@click=${this.onToggleOverviewSection}
			>
				<span class="sec-head">
					<span class="sec-title">${title}</span>
					${when(
						Boolean(options.count),
						() => html`<span class="sec-count">${options.count}</span>`,
						() => nothing
					)}
				</span>
				<span
					class=${classMap({ collapsed: isCollapsed, "sec-chevron": true })}
					aria-hidden="true"
				>
					>
				</span>
			</button>
			${when(!isCollapsed, () => body, () => nothing)}
		</section>
		`;
	}

	protected renderLine(entity: Entity) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		return html`
		<button
			class="line"
			data-id=${entity.id}
			@click=${this.onSelectEntityClick}
		>
			<span class="idtag">${entity.id}</span>
			<span class="line-title">${entity.title}</span>
			<span class=${`badge ${store.badgeTone(entity.status)}`}>${entity.status}</span>
		</button>
		`;
	}

	protected renderHandoff(handoff: HandoffRecord) {
		const store = this.store;
		const bundle = this.activeBundle();
		const focus = bundle
			? [bundle.initiative, ...bundle.prds, ...bundle.userStories, ...bundle.adrs, ...bundle.issues].find(
				(entity) => entity.id === handoff.entityId
			) ?? null
			: null;

		return html`
		<article class="handoff" data-handoff=${handoff.id}>
			<header class="handoff-head">
				<span class="idtag">${handoff.id}</span>
				${when(
					handoff.summary.length > 0,
					() => html`<span class="handoff-summary">${handoff.summary}</span>`,
					() => nothing
				)}
				<time class="handoff-time" datetime=${handoff.createdAt}>${this.formatTimestamp(handoff.createdAt)}</time>
			</header>
			${when(
				focus !== null,
				() => html`
				<button class=${`handoff-focus ${handoff.entityId === this.activeChildId ? "is-active-ref" : ""}`} data-id=${handoff.entityId} @click=${this.onSelectEntityClick}>
					<span class="idtag">${focus!.id}</span>
					<span class="handoff-focus-title">${focus!.title}</span>
				</button>
				`,
				() => nothing
			)}
			<div class="handoff-body ai-body">${unsafeHTML(renderMarkdownBody(handoff.body))}</div>
		</article>
		`;
	}

	protected formatTimestamp(value: string): string {
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) {
			return value;
		}

		return parsed.toLocaleString();
	}

	render() {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const bundle = this.activeBundle();
		if (!bundle) {
			return nothing;
		}

		const context = store.getContextForInitiative(bundle.initiative.id);
		const stats = store.initiativeStats(bundle);
		const tab = store.initTab.get();
		const body = (bundle.initiative.body ?? "").trim();
		const bodySource = bundle.initiative.bodySource ?? "authored";

		return html`
		<div class="detail-inner">
			<div class="ai-crumbs">${store.selectedTenantDisplayName.get()} · Initiatives</div>
			<h1 class="d-title">
				${bundle.initiative.title}
				<span class=${`badge ${store.badgeTone(bundle.initiative.status)}`}>${bundle.initiative.status}</span>
			</h1>
			<p class="d-sub">${context?.context.summary ?? "No initiative-specific context is available yet."}</p>

			<div class="kpis">
				<div class="kpi">
					<div class="k-num">${stats.stories}</div>
					<div class="k-label">User stories</div>
				</div>
				<div class="kpi">
					<div class="k-num">${stats.issues}</div>
					<div class="k-label">Issues</div>
				</div>
				<div class="kpi">
					<div class="k-num">${stats.pct}%</div>
					<div class="k-label">Complete</div>
				</div>
				<div class="kpi">
					<div class="k-num">${stats.adrs}</div>
					<div class="k-label">ADRs</div>
				</div>
			</div>

			<div class="bar">
				<span class="b-done" style=${`width:${stats.pct}%`}></span>
				<span class="b-open" style=${`width:${100 - stats.pct}%`}></span>
			</div>

			<div class="subtabs">
				<button
					class=${classMap({ active: tab === "overview", subtab: true })}
					data-tab="overview"
					@click=${this.onSetTab}
				>
					Overview
				</button>
				<button
					class=${classMap({ active: tab === "graph", subtab: true })}
					data-tab="graph"
					@click=${this.onSetTab}
				>
					Graph
				</button>
				<button
					class=${classMap({ active: tab === "context", subtab: true })}
					data-tab="context"
					@click=${this.onSetTab}
				>
					Context
				</button>
				<button
					class=${classMap({ active: tab === "handoffs", subtab: true })}
					data-tab="handoffs"
					@click=${this.onSetTab}
				>
					Handoffs${when(bundle.handoffs.length > 0, () => html` <span class="subtab-count">${bundle.handoffs.length}</span>`, () => nothing)}
				</button>
			</div>

			${choose(
				tab,
				[
					["overview", () => html`
					${when(
						body.length > 0,
						() => html`
						<div class="initiative-body overview-body">
							${when(bodySource === "generated", () => this.renderBodySourceNotice(), () => nothing)}
							<div class="ai-body">${unsafeHTML(renderMarkdownBody(body))}</div>
						</div>
						`,
						() => nothing
					)}
					${this.renderOverviewSection(
						"stories",
						"User stories & issues",
						html`
						<div class="sec-body">
							${when(
								bundle.userStories.length > 0,
								() => repeat(bundle.userStories, (story) => story.id, (story) => this.renderStoryBlock(story)),
								() => html`<div class="empty-children">No user stories yet.</div>`
							)}
						</div>
						`,
						{ count: `${stats.stories} stories · ${stats.issues} issues` }
					)}
					${this.renderOverviewSection(
						"prds",
						"PRDs",
						html`
						<div class="sec-body">
							${when(
								bundle.prds.length > 0,
								() => repeat(bundle.prds, (prd) => prd.id, (prd) => this.renderLine(prd)),
								() => html`<div class="empty-children">No PRDs attached.</div>`
							)}
						</div>
						`
					)}
					${this.renderOverviewSection(
						"adrs",
						"ADRs",
						html`
						<div class="sec-body">
							${when(
								bundle.adrs.length > 0,
								() => repeat(bundle.adrs, (adr) => adr.id, (adr) => this.renderLine(adr)),
								() => html`<div class="empty-children">No ADRs recorded.</div>`
							)}
						</div>
						`
					)}
					`],
					["context", () => html`
					<section class="sec context-sec">
						<agent-issues-context-view
							.context=${context}
							.emptyMessage=${"No context has been defined for this initiative yet."}
						></agent-issues-context-view>
					</section>
					`],
					["handoffs", () => html`
					<section class="sec">
						<div class="sec-head">🤝 Handoffs <span class="sec-count">${bundle.handoffs.length}</span></div>
						<div class="sec-body">
							${when(
								bundle.handoffs.length > 0,
								() => repeat(bundle.handoffs, (handoff) => handoff.id, (handoff) => this.renderHandoff(handoff)),
								() => html`<div class="empty-children">No handoffs have been saved for this initiative yet.</div>`
							)}
						</div>
					</section>
					`],
					["graph", () => html`
					<div class="ai-graph-wrap">
						<div class="ai-graph-legend">
							<span class="lg"><span class="sw" style="background:#0969da"></span>Initiative</span>
							<span class="lg"><span class="sw" style="background:#1f883d"></span>PRD</span>
							<span class="lg"><span class="sw" style="background:#8250df"></span>ADR</span>
							<span class="lg"><span class="sw" style="background:#bf8700"></span>Story</span>
							<span class="lg"><span class="sw" style="background:#0a7ea4"></span>Issue</span>
							<span class="ai-graph-hint">Click any node to open it</span>
						</div>
						<div class="graph-host">
							<agent-issues-relationship-graph
								.graph=${store.buildInitiativeGraph(bundle)}
								@node-open=${this.onNodeOpen}
							></agent-issues-relationship-graph>
						</div>
					</div>
					`]
				]
			)}
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
		}
		.detail-inner {
			max-width: 920px;
			margin: 0 auto;
			padding: 28px 32px 64px;
		}
		.ai-crumbs {
			color: var(--muted);
			font-size: 12px;
		}
		.d-title {
			display: flex;
			gap: 12px;
			align-items: center;
			margin: 6px 0 0;
			font-size: 24px;
		}
		.d-sub {
			max-width: 70ch;
			margin: 10px 0 0;
			color: var(--muted);
		}
		.kpis {
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			gap: 12px;
			margin-top: 20px;
		}
		.kpi {
			padding: 14px 16px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface);
		}
		.k-num {
			font-size: 22px;
			font-weight: 700;
		}
		.k-label {
			margin-top: 2px;
			color: var(--muted);
			font-size: 12px;
		}
		.bar {
			display: flex;
			overflow: hidden;
			height: 8px;
			margin-top: 16px;
			border-radius: 999px;
			background: #eaeef2;
		}
		.b-done {
			background: var(--done);
		}
		.b-open {
			background: var(--success);
		}
		.subtabs {
			display: flex;
			gap: 18px;
			margin-top: 22px;
			border-bottom: 1px solid var(--border-muted);
		}
		.subtab {
			padding: 8px 2px;
			border: 0;
			border-bottom: 2px solid transparent;
			background: transparent;
			color: var(--muted);
			cursor: pointer;
			font: inherit;
		}
		.subtab.active {
			border-bottom-color: #fd8c73;
			color: var(--text);
			font-weight: 600;
		}
		.sec {
			margin-top: 18px;
			border: 1px solid var(--border);
			border-radius: 12px;
			background: var(--surface);
		}
		.sec-toggle {
			display: flex;
			gap: 12px;
			align-items: center;
			justify-content: space-between;
			width: stretch;
			padding: 12px 16px;
			border: 0;
			border-bottom: 1px solid var(--border-muted);
			background: transparent;
			color: var(--text);
			cursor: pointer;
			font: inherit;
			text-align: left;
		}
		.sec-toggle:hover {
			background: var(--surface-muted);
		}
		.sec-head {
			display: flex;
			gap: 10px;
			align-items: baseline;
			flex-wrap: wrap;
		}
		.sec-title {
			font-weight: 600;
		}
		.sec-count {
			color: var(--muted);
			font-size: 12px;
			font-weight: 400;
		}
		.sec-chevron {
			color: var(--muted);
			font-size: 14px;
			line-height: 1;
			transform: rotate(90deg);
			transition: transform 120ms ease;
		}
		.sec-chevron.collapsed {
			transform: rotate(0deg);
		}
		.sec-body {
			padding: 8px;
		}
		.overview-body {
			margin-top: 18px;
		}
		.context-sec {
			padding: 16px;
		}
		.story-block {
			border-bottom: 1px solid var(--border-muted);
		}
		.story-block:last-child {
			border-bottom: 0;
		}
		.story-head {
			display: flex;
			gap: 10px;
			align-items: center;
			width: stretch;
			padding: 10px 8px;
			border: 0;
			background: transparent;
			cursor: pointer;
			text-align: left;
		}
		.story-head:hover,
		.child:hover,
		.line:hover {
			background: var(--surface-muted);
		}
		.story-head.is-active-ref,
		.child.is-active-ref,
		.handoff-focus.is-active-ref {
			background: var(--surface-muted);
			box-shadow: inset 3px 0 0 0 var(--accent);
		}
		.issue-branch {
			display: grid;
			gap: 6px;
		}
		.issue-branch-row {
			display: flex;
			gap: 8px;
			align-items: stretch;
		}
		.issue-branch + .issue-branch {
			margin-top: 6px;
		}
		.branch-toggle,
		.branch-spacer {
			flex-shrink: 0;
			width: 24px;
			height: 24px;
			margin-top: 8px;
		}
		.branch-toggle {
			border: 1px solid var(--border-muted);
			border-radius: 6px;
			background: var(--surface);
			color: var(--muted);
			cursor: pointer;
			font: inherit;
			line-height: 1;
		}
		.branch-toggle:hover {
			border-color: var(--accent);
			color: var(--accent);
		}
		.issue-branch-children {
			display: grid;
			gap: 6px;
			margin-left: 22px;
			padding-left: 12px;
			border-left: 1px solid var(--border-muted);
		}
		.s-title {
			flex: 1;
			font-weight: 600;
		}
		.chev {
			color: var(--muted);
		}
		.children {
			padding: 0 8px 8px 28px;
		}
		.issue-tree {
			display: grid;
			gap: 6px;
		}
		.empty-children {
			padding: 12px 8px;
			color: var(--muted);
			font-size: 13px;
		}
		.child,
		.line {
			display: flex;
			gap: 10px;
			align-items: center;
			width: stretch;
			padding: 8px;
			border: 0;
			border-radius: 6px;
			background: transparent;
			cursor: pointer;
			text-align: left;
		}
		.child-title,
		.line-title {
			flex: 1;
		}
		.idtag {
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
		}
		.issue-dot {
			flex-shrink: 0;
			width: 10px;
			height: 10px;
			border-radius: 50%;
			border: 2px solid var(--success);
		}
		.issue-dot.done {
			border-color: var(--done);
			background: var(--done);
		}
		.issue-dot.blocked {
			border-color: var(--danger);
		}
		.subtab-count {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-width: 18px;
			padding: 0 5px;
			border-radius: 999px;
			background: var(--border-muted);
			color: var(--muted);
			font-size: 11px;
			font-weight: 600;
		}
		.handoff {
			padding: 14px 16px;
			border: 1px solid var(--border-muted);
			border-radius: 10px;
			background: var(--surface);
		}
		.handoff + .handoff {
			margin-top: 10px;
		}
		.handoff-head {
			display: flex;
			gap: 10px;
			align-items: baseline;
			flex-wrap: wrap;
		}
		.handoff-summary {
			flex: 1;
			font-weight: 600;
		}
		.handoff-time {
			color: var(--muted);
			font-size: 12px;
		}
		.handoff-focus {
			display: inline-flex;
			gap: 8px;
			align-items: center;
			margin-top: 8px;
			padding: 4px 8px;
			border: 1px solid var(--border-muted);
			border-radius: 6px;
			background: transparent;
			cursor: pointer;
			font: inherit;
			color: var(--text);
		}
		.handoff-focus-title {
			color: var(--muted);
			font-size: 13px;
		}
		.handoff-body {
			margin-top: 10px;
		}
		.ai-body-source {
			display: flex;
			gap: 10px;
			align-items: center;
			margin-bottom: 14px;
			padding: 10px 12px;
			border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
			border-radius: 10px;
			background: color-mix(in srgb, var(--surface-muted) 76%, white 24%);
		}
		.ai-body-source-badge {
			padding: 4px 8px;
			border-radius: 999px;
			background: color-mix(in srgb, var(--accent) 16%, white 84%);
			color: var(--accent-strong, var(--accent));
			font-size: 11px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.ai-body-source-copy {
			color: var(--muted);
			font-size: 12px;
			font-weight: 600;
		}
		.ai-body {
			max-width: 75ch;
			color: var(--text);
			font-size: 14px;
			line-height: 1.6;
		}
		.ai-body > :first-child {
			margin-top: 0;
		}
		.ai-body > :last-child {
			margin-bottom: 0;
		}
		.ai-body h1,
		.ai-body h2,
		.ai-body h3 {
			margin: 16px 0 8px;
			line-height: 1.3;
		}
		.ai-body p {
			margin: 8px 0;
		}
		.ai-body ul,
		.ai-body ol {
			margin: 8px 0;
			padding-left: 22px;
		}
		.ai-body code {
			padding: 1px 5px;
			border-radius: 4px;
			background: var(--border-muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
		}
		.ai-body pre {
			padding: 12px;
			border-radius: 8px;
			background: #f6f8fa;
			overflow: auto;
		}
		.ai-body pre code {
			padding: 0;
			background: transparent;
		}
		.ai-body blockquote {
			margin: 8px 0;
			padding-left: 12px;
			border-left: 3px solid var(--border);
			color: var(--muted);
		}
		.ai-body a {
			color: var(--accent, #0969da);
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
		@media (max-width: 700px) {
			.kpis {
				grid-template-columns: repeat(2, 1fr);
			}
			.detail-inner {
				padding: 20px 16px 48px;
			}
		}
		`
	];
}

customElements.define("agent-issues-initiative-detail-view", InitiativeDetailView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-initiative-detail-view": InitiativeDetailView;
	}
}