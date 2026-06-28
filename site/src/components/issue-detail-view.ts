import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { when } from "lit/directives/when.js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { Entity } from "../models.js";
import type { AgentIssuesStore } from "../services/agent-issues-store.js";
import { issueBrowserControlStyles, issueBrowserTokenStyles, issueBrowserTypographyStyles } from "../styles/issue-browser-shared-styles.js";

function renderAuthoredBody(markdown: string): string {
	const rawHtml = marked.parse(markdown, { async: false });
	return DOMPurify.sanitize(rawHtml);
}

type IssueTreeNode = {
	issue: Entity;
	children: IssueTreeNode[];
};

class IssueDetailView extends SignalWatcher(LitElement) {
	static properties = {
		store: { attribute: false },
		entityId: { attribute: false },
		cascade: { attribute: false },
		activeChildId: { attribute: false }
	};

	public store: AgentIssuesStore | null = null;
	public entityId: string | null = null;
	public cascade = false;
	public activeChildId: string | null = null;
	protected collapsedIssueIds = new Set<string>();

	protected onBackClick = () => {
		this.store?.closeEntity();
	};

	protected onSelectEntityClick = (event: Event) => {
		if (this.cascade) {
			const target = event.currentTarget as HTMLElement;
			const childId = target.dataset.id;
			if (!childId) {
				return;
			}

			if (target.dataset.crossLink === "true") {
				this.store?.reRootCascade(childId);
			} else if (this.entityId) {
				this.store?.drillCascade(this.entityId, childId);
			}

			return;
		}

		this.store?.selectEntityFromEvent(event);
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

	protected renderBodySourceNotice() {
		return html`
		<div class="ai-body-source ai-body-source-generated">
			<span class="ai-body-source-badge">Generated fallback</span>
			<span class="ai-body-source-copy">Generated from tracker metadata because no authored body was present.</span>
		</div>
		`;
	}

	protected renderRef(record: Entity, crossLink = false) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		return html`
		<button
			class=${`ai-ref ${record.id === this.activeChildId ? "is-active-ref" : ""}`}
			data-id=${record.id}
			data-cross-link=${crossLink ? "true" : nothing}
			@click=${this.onSelectEntityClick}
		>
			<span class="r-id">${record.id}</span>
			<span class="r-title">${record.title}</span>
			<span class=${`badge ${store.badgeTone(record.status)}`}>${record.status}</span>
		</button>
		`;
	}

	protected renderIssueTreeNode(node: IssueTreeNode): TemplateResult {
		const isCollapsed = this.collapsedIssueIds.has(node.issue.id);

		return html`
		<div class="ai-issue-tree-node">
			<div class="ai-issue-tree-row">
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
				${this.renderRef(node.issue)}
			</div>
			${when(
				node.children.length > 0 && !isCollapsed,
				() => html`
				<div class="ai-issue-tree-children">
					${repeat(node.children, (child) => child.issue.id, (child) => this.renderIssueTreeNode(child))}
				</div>
				`,
				() => nothing
			)}
		</div>
		`;
	}

	protected renderPrdStoryBlock(story: Entity, issueTree: IssueTreeNode[]): TemplateResult {
		return html`
		<div class="ai-story-block">
			${this.renderRef(story)}
			${when(
				issueTree.length > 0,
				() => html`
				<div class="ai-story-issues">
					${repeat(issueTree, (node) => node.issue.id, (node) => this.renderIssueTreeNode(node))}
				</div>
				`,
				() => html`<div class="ai-story-empty">No issues fix this story yet.</div>`
			)}
		</div>
		`;
	}

	render() {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const entityId = this.entityId ?? store.selectedId.get();
		const entity = store.entityForId(entityId);
		if (!entity) {
			return nothing;
		}

		const bundle = store.bundleForEntityId(entityId);
		const isAdrSection = store.activeSection.get() === "adrs";
		const scopeLabel = isAdrSection ? "ADRs" : bundle?.initiative.title ?? "Initiatives";
		const crumbScope = isAdrSection ? "ADRs" : bundle?.initiative.title ?? "Workspace";
		const meta = store.detailMetaFor(entity.id);
		const parentIssue = entity.kind === "issue" && bundle ? store.parentIssueForIssue(bundle, entity.id) : null;
		const subIssueTree = entity.kind === "issue" && bundle ? store.subIssueTreeForIssue(bundle, entity.id) : [];
		const prdStories = entity.kind === "prd"
			? bundle?.userStories.filter((story) =>
				store.outgoingRelationsFor(entity.id).some((relation) => relation.type === "creates" && relation.toId === story.id)
			) ?? []
			: [];
		const sections = store.linkedRecordSectionsFor(
			entity.id,
			entity.kind === "issue"
				? { excludeRelationTypes: ["decomposes"] }
				: entity.kind === "prd"
					? { excludeRelationTypes: ["creates"] }
					: undefined
		);
		const body = (entity.body ?? "").trim();
		const bodySource = entity.bodySource ?? "authored";
		const hasIssueStructure = entity.kind === "issue" && (parentIssue !== null || subIssueTree.length > 0);

		return html`
		<div class="detail-inner">
			${when(
				!this.cascade,
				() => html`
				<button
					class="ai-back"
					@click=${this.onBackClick}
				>
					← Back to ${scopeLabel}
				</button>
				`
			)}
			<div class="ai-crumbs">${store.selectedTenantDisplayName.get()} · ${crumbScope}</div>
			<div class="ai-kind">${store.formatKindLabel(entity.kind)}</div>
			<h1 class="ai-d-title">
				${entity.title}
				<span class=${`badge ${store.badgeTone(entity.status)}`}>${entity.status}</span>
				<span class="ai-id">${entity.id}</span>
			</h1>
			<div class="ai-meta">
				${repeat(
					meta,
					([key]) => key,
					([key, value]) => html`
					<div class="m">
						<span class="k">${key}</span>
						<span class="v">${value}</span>
					</div>
					`
				)}
			</div>
			${when(
				body.length > 0,
				() => html`
				<section class="ai-sec ai-body">
					${when(bodySource === "generated", () => this.renderBodySourceNotice())}
					${unsafeHTML(renderAuthoredBody(body))}
				</section>
				`
			)}
			${when(
				hasIssueStructure,
				() => html`
				${when(
					parentIssue !== null,
					() => html`
					<section class="ai-sec">
						<h2>Parent issue</h2>
						<div class="ai-refs">${this.renderRef(parentIssue!)}</div>
					</section>
					`,
					() => nothing
				)}
				${when(
					subIssueTree.length > 0,
					() => html`
					<section class="ai-sec">
						<h2>Sub-issues</h2>
						<div class="ai-issue-tree">
							${repeat(subIssueTree, (node) => node.issue.id, (node) => this.renderIssueTreeNode(node))}
						</div>
					</section>
					`,
					() => nothing
				)}
				`,
				() => nothing
			)}
			${when(
				entity.kind === "prd",
				() => html`
				<section class="ai-sec">
					<h2>Creates</h2>
					<div class="ai-story-list">
						${when(
							prdStories.length > 0,
							() => repeat(
								prdStories,
								(story) => story.id,
								(story) => this.renderPrdStoryBlock(story, bundle ? store.issueTreeForStory(bundle, story.id) : [])
							),
							() => html`<div class="ai-empty">This PRD does not create any user stories yet.</div>`
						)}
					</div>
				</section>
				`,
				() => nothing
			)}
			${when(
				sections.length > 0,
				() => repeat(
					sections,
					(section) => section.key,
					(section) => html`
					<section class="ai-sec">
						<h2>${section.title}</h2>
						<div class="ai-refs">
							${repeat(section.records, (record) => record.id, (record) => this.renderRef(record, section.crossLink))}
						</div>
					</section>
					`
				),
				() => when(
					hasIssueStructure,
					() => nothing,
					() => html`
				<section class="ai-sec">
					<h2>Linked records</h2>
					<div class="ai-empty">Nothing is linked to this record yet.</div>
				</section>
				`
				)
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
		.ai-back {
			display: inline-flex;
			gap: 6px;
			align-items: center;
			margin-bottom: 12px;
			border: 0;
			background: none;
			color: var(--muted);
			cursor: pointer;
			font: inherit;
		}
		.ai-back:hover {
			color: var(--accent);
		}
		.ai-crumbs {
			margin-bottom: 12px;
			color: var(--muted);
			font-size: 12px;
		}
		.ai-kind {
			color: var(--muted);
			font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.ai-d-title {
			display: flex;
			flex-wrap: wrap;
			gap: 12px;
			align-items: center;
			margin: 6px 0 0;
			font-size: 24px;
		}
		.ai-d-title .ai-id {
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 14px;
			font-weight: 400;
		}
		.ai-meta {
			display: flex;
			flex-wrap: wrap;
			gap: 28px;
			margin: 16px 0 4px;
			padding: 14px 0;
			border-top: 1px solid var(--border-muted);
			border-bottom: 1px solid var(--border-muted);
		}
		.ai-meta .m {
			display: flex;
			flex-direction: column;
			gap: 3px;
		}
		.ai-meta .m .k {
			color: var(--muted);
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.ai-meta .m .v {
			font-weight: 600;
		}
		.ai-sec {
			margin-top: 24px;
		}
		.ai-sec h2 {
			margin: 0 0 10px;
			font-size: 15px;
		}
		.ai-body {
			max-width: 75ch;
			line-height: 1.6;
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
		.ai-body > :first-child {
			margin-top: 0;
		}
		.ai-body > :last-child {
			margin-bottom: 0;
		}
		.ai-body h1,
		.ai-body h2,
		.ai-body h3 {
			margin: 22px 0 10px;
			line-height: 1.3;
		}
		.ai-body h1 {
			font-size: 19px;
		}
		.ai-body h2 {
			font-size: 16px;
		}
		.ai-body h3 {
			font-size: 14px;
		}
		.ai-body p {
			margin: 0 0 12px;
			color: var(--text);
		}
		.ai-body ul,
		.ai-body ol {
			margin: 0 0 12px;
			padding-left: 18px;
			line-height: 1.7;
		}
		.ai-body a {
			color: var(--accent);
		}
		.ai-body code {
			padding: 2px 5px;
			border-radius: 5px;
			background: var(--surface-muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 0.9em;
		}
		.ai-body pre {
			overflow: auto;
			margin: 0 0 12px;
			padding: 12px 14px;
			border: 1px solid var(--border-muted);
			border-radius: 8px;
			background: var(--surface-muted);
		}
		.ai-body pre code {
			padding: 0;
			background: none;
		}
		.ai-body blockquote {
			margin: 0 0 12px;
			padding: 2px 0 2px 14px;
			border-left: 3px solid var(--border);
			color: var(--muted);
		}
		.ai-refs {
			display: grid;
			gap: 8px;
		}
		.ai-story-list {
			display: grid;
			gap: 12px;
		}
		.ai-story-block {
			display: grid;
			gap: 10px;
		}
		.ai-story-issues {
			display: grid;
			gap: 8px;
			margin-left: 18px;
			padding-left: 14px;
			border-left: 1px solid var(--border-muted);
		}
		.ai-story-empty {
			margin-left: 18px;
			padding-left: 14px;
			color: var(--muted);
			font-size: 13px;
		}
		.ai-issue-tree {
			display: grid;
			gap: 8px;
		}
		.ai-issue-tree-node {
			display: grid;
			gap: 8px;
		}
		.ai-issue-tree-row {
			display: flex;
			gap: 8px;
			align-items: flex-start;
		}
		.ai-issue-tree-children {
			display: grid;
			gap: 8px;
			margin-left: 18px;
			padding-left: 14px;
			border-left: 1px solid var(--border-muted);
		}
		.branch-toggle,
		.branch-spacer {
			flex-shrink: 0;
			width: 24px;
			height: 24px;
			margin-top: 10px;
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
		.ai-ref {
			display: flex;
			gap: 12px;
			align-items: center;
			width: stretch;
			padding: 10px 12px;
			border: 1px solid var(--border);
			border-radius: 8px;
			background: var(--surface);
			color: inherit;
			cursor: pointer;
			font: inherit;
			text-align: left;
		}
		.ai-ref:hover {
			border-color: var(--accent);
			background: var(--surface-muted);
		}
		.ai-ref.is-active-ref {
			border-color: var(--accent);
			background: var(--surface-muted);
			box-shadow: inset 3px 0 0 0 var(--accent);
		}
		.ai-ref .r-id {
			min-width: 56px;
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
		}
		.ai-ref .r-title {
			flex: 1;
			font-weight: 600;
		}
		.ai-empty {
			color: var(--muted);
			font-size: 13px;
		}
		@media (max-width: 700px) {
			.detail-inner {
				padding: 20px 16px 48px;
			}
			.ai-body-source {
				flex-direction: column;
				align-items: flex-start;
			}
		}
		`
	];
}

customElements.define("agent-issues-detail-view", IssueDetailView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-detail-view": IssueDetailView;
	}
}
