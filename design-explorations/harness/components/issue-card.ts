import { html, nothing } from 'lit';
import { when } from 'lit/directives/when.js';
import { FileDiff, FileText, MessageSquare, Terminal } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import './status-badge.js';

export interface IssueModel {
	index: number;
	reference: string;
	title: string;
	status: { tone: string; label: string; detail: string };
	prds: number[];
	workerId?: string;
	attention?: 'answer' | 'review';
}

export class HarnessIssueCard extends LightElement {
	static override properties = { issue: { attribute: false } };

	constructor() {
		super();
		this.issue = undefined;
	}

	declare issue: IssueModel | undefined;

	protected override render() {
		const issue = this.issue;
		if (!issue) return nothing;
		const prds = issue.prds.map((index) => `PRD ${String(index + 1).padStart(2, '0')}`).join(' / ');
		const attentionLabel = issue.attention === 'review' ? `Review ${issue.reference}` : `Answer agent for ${issue.reference}`;
		return html`
		<button
			class=${`route-issue ${issue.status.tone}`}
			data-action="record"
			data-kind="issue"
			data-index=${issue.index}
		>
			<span class="route-issue-meta">
				<span class="mono">${issue.reference}</span>
				<harness-status-badge .status=${issue.status}></harness-status-badge>
			</span>
			<strong>${issue.title}</strong>
			<span class="route-issue-detail">${issue.status.detail}</span>
			<span class="route-issue-prd">
				${when(
						issue.prds.length > 0,
						() => html` ${renderIcon(FileText)}${prds} `,
						() => html` No PRD link `
					)}
			</span>
		</button>
		${when(
				issue.workerId,
				() => html`
				<button
					class="initiative-agent-trigger icon-button"
					data-action="agent"
					data-id=${issue.workerId!}
					title=${`Show Worker ${issue.workerId} terminal`}
					aria-label=${`Show Worker ${issue.workerId} terminal`}
				>
					${renderIcon(Terminal)}
				</button>
				`
			)}
		${when(issue.attention, () => html`
		<button
			class="initiative-attention-trigger"
			data-action=${issue.attention === 'review' ? 'open-review' : 'answer-agent'}
			data-id=${issue.workerId ?? ''}
			data-index=${issue.index}
			data-reference=${issue.reference}
			title=${attentionLabel}
			aria-label=${attentionLabel}
		>
			${when(issue.attention === 'review', () => html`${renderIcon(FileDiff)}Review`, () => html`${renderIcon(MessageSquare)}Answer agent`)}
		</button>
		`)}
		`;
	}
}

customElements.define('harness-issue-card', HarnessIssueCard);

declare global {
	interface HTMLElementTagNameMap {
		'harness-issue-card': HarnessIssueCard;
	}
}
