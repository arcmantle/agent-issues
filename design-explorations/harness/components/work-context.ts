import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { FileText, CircleDot, ChevronDown } from 'lucide';
import type { IssueModel } from './issue-card.js';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface WorkContext {
	issue: IssueModel;
	parents: { index: number; title: string; story: string }[];
}

export class HarnessWorkContext extends LightElement {
	static override properties = {
		context: { attribute: false },
		branch: { attribute: false },
		checkpoint: { attribute: false },
	};

	constructor() {
		super();
		this.context = undefined;
		this.branch = '';
		this.checkpoint = '';
	}

	declare context: WorkContext | undefined;
	declare branch: string;
	declare checkpoint: string;

	protected handleRelatedRecord() {
		this.querySelector<HTMLElement>('[popover]')!.hidePopover();
		this.querySelector<HTMLButtonElement>('.work-related-trigger')!.focus();
	}

	protected handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !this.querySelector('[popover]:popover-open')) return;
		event.preventDefault();
		event.stopPropagation();
		this.handleRelatedRecord();
	}

	protected override render() {
		const context = this.context;
		if (!context) return nothing;
		return html`
		<div
			class="work-context"
			@keydown=${this.handleKeydown}
		>
			<h2>
				<button
					class="work-record-link work-issue-link"
					data-action="record"
					data-kind="issue"
					data-index=${context.issue.index}
					title="Open issue"
				>
					${renderIcon(CircleDot)}
					<span class="mono">${context.issue.reference}</span>
					<span>${context.issue.title}</span>
				</button>
			</h2>
			<div class="work-metadata">
				<dl class="work-revision">
					<div><dt>Source branch</dt><dd><code>${this.branch}</code></dd></div>
					<div><dt>Checkpoint</dt><dd><code>${this.checkpoint}</code></dd></div>
				</dl>
				<button
					class="work-record-link work-related-trigger"
					popovertarget=${`work-related-${context.issue.reference}`}
					style=${`anchor-name: --work-related-${context.issue.reference}`}
				>
					${renderIcon(FileText)}Related work / ${context.parents.length} PRDs${renderIcon(ChevronDown)}
				</button>
			</div>
			<div
				id=${`work-related-${context.issue.reference}`}
				class="work-related-panel"
				popover="auto"
				style=${`position-anchor: --work-related-${context.issue.reference}`}
				aria-label="Related work"
			>
				<h3>Related work</h3>
				<div class="work-parents">
				${repeat(
					context.parents,
					(parent) => parent.index,
					(parent) => html`
					<div class="work-parent">
						<button
							class="work-record-link"
							data-action="record"
							data-kind="prd"
							data-index=${parent.index}
							title="Open PRD"
							@click=${this.handleRelatedRecord}
						>
							${renderIcon(FileText)}PRD ${String(parent.index + 1).padStart(2, '0')} / ${parent.title}
						</button>
						<span class="work-story">User story / ${parent.story}</span>
					</div>
					`
				)}
				</div>
			</div>
		</div>
		`;
	}
}

customElements.define('harness-work-context', HarnessWorkContext);

declare global {
	interface HTMLElementTagNameMap {
		'harness-work-context': HarnessWorkContext;
	}
}