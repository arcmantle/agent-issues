import { LitElement, css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";
import type { ContextDetails, ContextTermRecord } from "../models.js";
import { issueBrowserTokenStyles, issueBrowserTypographyStyles } from "../styles/issue-browser-shared-styles.js";

class ContextView extends LitElement {
	static properties = {
		context: { attribute: false },
		emptyMessage: { attribute: false }
	};

	public context: ContextDetails | null = null;

	public emptyMessage = "No context has been defined yet.";

	protected renderTerm(term: ContextTermRecord) {
		return html`
		<div class="term">
			<div class="term-name">${term.term}</div>
			<p class="term-def">${term.definition}</p>
			${when(
				term.avoid.length > 0,
				() => html`
				<div class="avoid">
					<span class="avoid-label">Avoid</span>
					${repeat(term.avoid, (phrase) => phrase, (phrase) => html`<span class="avoid-chip">${phrase}</span>`)}
				</div>
				`,
				() => nothing
			)}
		</div>
		`;
	}

	render() {
		const details = this.context;
		const terms = details?.terms ?? [];
		const hasContent = Boolean(details?.context.summary?.trim()) || terms.length > 0;

		return html`
		<div class="context">
			${when(
				hasContent,
				() => html`
				<p class="summary">${details?.context.summary}</p>
				<div class="glossary-head">
					<span class="glossary-title">Glossary</span>
					<span class="glossary-count">${terms.length} ${when(terms.length === 1, () => html`term`, () => html`terms`)}</span>
				</div>
				${when(
					terms.length > 0,
					() => html`<div class="terms">${repeat(terms, (term) => term.term, (term) => this.renderTerm(term))}</div>`,
					() => html`<p class="empty">No glossary terms have been defined yet.</p>`
				)}
				`,
				() => html`<p class="empty">${this.emptyMessage}</p>`
			)}
		</div>
		`;
	}

	static styles = [
		issueBrowserTokenStyles,
		issueBrowserTypographyStyles,
		css`
		:host {
			display: block;
		}
		.summary {
			max-width: 75ch;
			margin: 0;
			color: var(--text);
		}
		.glossary-head {
			display: flex;
			gap: 10px;
			align-items: baseline;
			margin-top: 22px;
		}
		.glossary-title {
			font-size: 16px;
			font-weight: 600;
		}
		.glossary-count {
			color: var(--muted);
			font-size: 12px;
		}
		.terms {
			display: grid;
			gap: 12px;
			margin-top: 12px;
		}
		.term {
			padding: 14px 16px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface);
		}
		.term-name {
			font-weight: 600;
		}
		.term-def {
			max-width: 75ch;
			margin: 6px 0 0;
			color: var(--text);
		}
		.avoid {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			align-items: center;
			margin-top: 10px;
		}
		.avoid-label {
			color: var(--muted);
			font-size: 11px;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.avoid-chip {
			padding: 2px 8px;
			border: 1px solid var(--border);
			border-radius: 999px;
			background: var(--surface-muted);
			color: var(--muted);
			font-size: 12px;
		}
		.empty {
			margin: 0;
			color: var(--muted);
		}
		`
	];
}

customElements.define("agent-issues-context-view", ContextView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-context-view": ContextView;
	}
}
