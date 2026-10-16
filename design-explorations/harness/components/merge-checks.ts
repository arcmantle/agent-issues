import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { CircleCheck, CircleDashed, CircleX } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface MergeChecksModel {
	result: 'pending' | 'failed' | 'passed';
	revision: number;
	target: string;
	names: string[];
	failedIndex: number;
	error: string;
}

export class HarnessMergeChecks extends LightElement {
	static override properties = { model: { attribute: false } };

	constructor() {
		super();
		this.model = undefined;
	}

	declare model: MergeChecksModel | undefined;

	protected override render() {
		const model = this.model;
		if (!model) return nothing;
		const summary =
			model.result === 'pending'
				? 'Not run'
				: model.result === 'failed'
					? '2 passed / 1 failed'
					: '3 passed';
		return html`
		<section
			class="checks"
			aria-label="Validation results"
		>
			<div class="section-heading">
				<h2>Merge checks</h2>
				<span class="muted">${summary}</span>
			</div>
			<p class="muted mono">resolution-r${model.revision} / target ${model.target}</p>
			${repeat(
					model.names,
					(name) => name,
					(name, index) => {
						const failed = model.result === 'failed' && index === model.failedIndex;
						const symbol =
							model.result === 'pending' ? CircleDashed : failed ? CircleX : CircleCheck;
						const tone = failed
							? 'danger-text'
							: model.result === 'passed'
								? 'success-text'
								: 'muted';
						const label = model.result === 'pending' ? 'Not run' : failed ? 'Failed' : 'Passed';
						return html`
						<div class="check-row">
							<span>${renderIcon(symbol)}${name}</span><strong class=${tone}>${label}</strong>
						</div>
						`;
					}
				)}
			${when(
					model.result === 'failed',
					() => html` <pre class="check-error">${model.error}</pre> `
				)}
		</section>
		`;
	}
}

customElements.define('harness-merge-checks', HarnessMergeChecks);

declare global {
	interface HTMLElementTagNameMap {
		'harness-merge-checks': HarnessMergeChecks;
	}
}
