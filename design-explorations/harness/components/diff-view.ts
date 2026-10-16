import { html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { when } from 'lit/directives/when.js';
import { ChevronDown, ChevronUp } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface DiffPart {
	value: string;
	added?: boolean;
	removed?: boolean;
}

interface DiffRow {
	text: string;
	kind: 'added' | 'removed' | 'unchanged';
	before: number | null;
	after: number | null;
}

export class HarnessDiffView extends LightElement {
	static override properties = {
		beforeCode: { attribute: false },
		afterCode: { attribute: false },
		comparison: { attribute: false },
		file: { attribute: false },
	};

	constructor() {
		super();
		this.beforeCode = '';
		this.afterCode = '';
		this.comparison = 'split';
		this.file = '';
	}

	declare beforeCode: string;
	declare afterCode: string;
	declare comparison: 'split' | 'unified';
	declare file: string;
	protected changeIndex = -1;

	protected handleScroll(event: Event) {
		const current = event.currentTarget as HTMLElement;
		for (const pane of this.querySelectorAll<HTMLElement>('.diff-scroll'))
			if (pane !== current && pane.scrollTop !== current.scrollTop)
				pane.scrollTop = current.scrollTop;
	}

	protected handleNavigate(event: Event) {
		const pane = this.querySelector<HTMLElement>('.diff-scroll')!;
		const changes = [...pane.querySelectorAll<HTMLElement>('[data-change]')];
		if (!changes.length) return;
		const direction = (event.currentTarget as HTMLElement).dataset.direction === 'next' ? 1 : -1;
		this.changeIndex =
			this.changeIndex < 0
				? direction === 1
					? 0
					: changes.length - 1
				: (this.changeIndex + direction + changes.length) % changes.length;
		for (const region of this.querySelectorAll<HTMLElement>('.diff-scroll'))
			region.scrollTop = changes[this.changeIndex]!.offsetTop;
	}

	protected rows() {
		let before = 0;
		let after = 0;
		const rows: DiffRow[] = [];
		for (const part of window.Diff!.diffLines(this.beforeCode, this.afterCode)) {
			const lines = part.value.split('\n');
			if (lines.at(-1) === '') lines.pop();
			for (const text of lines)
				rows.push({
					text,
					kind: part.added ? 'added' : part.removed ? 'removed' : 'unchanged',
					before: part.added ? null : ++before,
					after: part.removed ? null : ++after,
				});
		}
		return rows;
	}

	protected renderPane(rows: DiffRow[], title: string, side: 'before' | 'after' | 'both') {
		const visible = rows.filter(
			(row) => side === 'both' || (side === 'before' ? row.before !== null : row.after !== null)
		);
		return html`
		<section class="diff-pane">
			<header>${title}</header>
			<div
				class="diff-scroll"
				aria-label=${title}
				tabindex="0"
				@scroll=${this.handleScroll}
			>
				<div class="diff-lines">
					${repeat(
							visible,
							(_row, index) => index,
							(row) => html`
							<span
								class=${`diff-row diff-${row.kind}`}
								data-change=${ifDefined(row.kind === 'unchanged' ? undefined : '')}
								><span class="diff-line-number"
									>${side === 'before' ? row.before : (row.after ?? row.before)}</span
								><code>${row.text || ' '}</code></span
							>
							`
						)}
				</div>
			</div>
		</section>
		`;
	}

	protected override render() {
		if (!window.Diff)
			return html`
			<section class="diff-library-error">
				<p role="alert">Diff library unavailable.</p>
				<pre>${this.beforeCode}</pre>
				<pre>${this.afterCode}</pre>
			</section>
			`;
		const rows = this.rows();
		return html`
		<div class="diff-toolbar">
			<span class="mono">${this.file}</span>
			<div>
				<button
					class="icon-button"
					data-direction="previous"
					title="Previous change"
					aria-label="Previous change"
					@click=${this.handleNavigate}
				>
					${renderIcon(ChevronUp)}
				</button>
				<button
					class="icon-button"
					data-direction="next"
					title="Next change"
					aria-label="Next change"
					@click=${this.handleNavigate}
				>
					${renderIcon(ChevronDown)}
				</button>
			</div>
		</div>
		<div class=${`diff-panes ${this.comparison}`}>
			${when(
					this.comparison === 'split',
					() =>
						html`${this.renderPane(rows, 'Initiative / before merge', 'before')}${this.renderPane(
							rows,
							'Proposed result',
							'after'
						)}`,
					() => this.renderPane(rows, 'Combined diff', 'both')
				)}
		</div>
		`;
	}
}

customElements.define('harness-diff-view', HarnessDiffView);

declare global {
	interface Window {
		Diff?: { diffLines(before: string, after: string): DiffPart[] };
	}
	interface HTMLElementTagNameMap {
		'harness-diff-view': HarnessDiffView;
	}
}
