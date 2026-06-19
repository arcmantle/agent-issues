import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
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

class IssueDetailView extends SignalWatcher(LitElement) {
	static properties = {
		store: { attribute: false }
	};

	public store: AgentIssuesStore | null = null;

	protected onBackClick = () => {
		this.store?.closeEntity();
	};

	protected onSelectEntityClick = (event: Event) => {
		this.store?.selectEntityFromEvent(event);
	};

	protected renderBodySourceNotice() {
		return html`
		<div class="ai-body-source ai-body-source-generated">
			<span class="ai-body-source-badge">Generated fallback</span>
			<span class="ai-body-source-copy">Generated from tracker metadata because no authored body was present.</span>
		</div>
		`;
	}

	protected renderRef(record: Entity) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		return html`
		<button
			class="ai-ref"
			data-id=${record.id}
			@click=${this.onSelectEntityClick}
		>
			<span class="r-id">${record.id}</span>
			<span class="r-title">${record.title}</span>
			<span class=${`badge ${store.badgeTone(record.status)}`}>${record.status}</span>
		</button>
		`;
	}

	render() {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const entity = store.selectedEntity.get();
		if (!entity) {
			return nothing;
		}

		const bundle = store.selectedBundle.get();
		const isAdrSection = store.activeSection.get() === "adrs";
		const scopeLabel = isAdrSection ? "ADRs" : bundle?.initiative.title ?? "Initiatives";
		const crumbScope = isAdrSection ? "ADRs" : bundle?.initiative.title ?? "Workspace";
		const meta = store.detailMeta(entity);
		const sections = store.linkedRecordSections();
		const body = (entity.body ?? "").trim();
		const bodySource = entity.bodySource ?? "authored";

		return html`
		<div class="detail-inner">
			<button
				class="ai-back"
				@click=${this.onBackClick}
			>
				← Back to ${scopeLabel}
			</button>
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
				sections.length > 0,
				() => repeat(
					sections,
					(section) => section.key,
					(section) => html`
					<section class="ai-sec">
						<h2>${section.title}</h2>
						<div class="ai-refs">
							${repeat(section.records, (record) => record.id, (record) => this.renderRef(record))}
						</div>
					</section>
					`
				),
				() => html`
				<section class="ai-sec">
					<h2>Linked records</h2>
					<div class="ai-empty">Nothing is linked to this record yet.</div>
				</section>
				`
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
