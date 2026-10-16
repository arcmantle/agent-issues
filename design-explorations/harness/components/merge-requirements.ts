import { html, nothing } from 'lit';
import { LightElement } from './light-element.js';

export interface MergeRequirementsModel {
	reference: string;
	add: string;
	keep: string;
	proposal: string;
	target: string;
	integrated: boolean;
}

export class HarnessMergeRequirements extends LightElement {
	static override properties = { model: { attribute: false } };

	constructor() {
		super();
		this.model = undefined;
	}

	declare model: MergeRequirementsModel | undefined;

	protected override render() {
		const model = this.model;
		if (!model) return nothing;
		const detail = model.integrated
			? 'Dependent work released. Final merge to main awaits separate approval.'
			: 'Branch update waits for approval and passing checks.';
		return html`
		<section
			class="merge-summary"
			aria-label="Merge requirements"
		>
			<div class="section-heading">
				<h2>Required result</h2>
				<span class="mono">${model.reference}</span>
			</div>
			<dl>
				<div>
					<dt>Add from this issue</dt>
					<dd>${model.add}</dd>
				</div>
				<div>
					<dt>Keep from the initiative</dt>
					<dd>${model.keep}</dd>
				</div>
				<div>
					<dt>Agent proposal</dt>
					<dd>${model.proposal}</dd>
				</div>
			</dl>
			<p class="muted">Target ${model.target}. ${detail}</p>
		</section>
		`;
	}
}

customElements.define('harness-merge-requirements', HarnessMergeRequirements);

declare global {
	interface HTMLElementTagNameMap {
		'harness-merge-requirements': HarnessMergeRequirements;
	}
}
