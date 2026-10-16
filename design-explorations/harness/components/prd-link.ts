import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { ArrowUpRight, FileText } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import { type PrdModel } from './initiative-route.js';

export class HarnessPrdLink extends LightElement {
	static override properties = { prd: { attribute: false } };

	constructor() {
		super();
		this.prd = undefined;
	}

	declare prd: PrdModel | undefined;

	protected override render() {
		const prd = this.prd;
		if (!prd) return nothing;
		return html`
		<button
			class="work-context-prd"
			data-action="record"
			data-kind="prd"
			data-index=${prd.index}
			data-relevant=${String(prd.assigned.length > 0)}
		>
			${renderIcon(FileText)}
			<span>
				<strong>PRD ${String(prd.index + 1).padStart(2, '0')} / ${prd.title}</strong>
				<small>
					${when(
							prd.assigned.length > 0,
							() =>
								repeat(
									prd.assigned,
									(issue) => issue.index,
									(issue) => html`
									<span>${issue.reference} / ${issue.title} / ${issue.status.label}<br /></span>
									`
								),
							() => html` No assigned work<br /> `
						)}
					${prd.issueCount} linked issues
				</small>
			</span>
			${renderIcon(ArrowUpRight)}
		</button>
		`;
	}
}

customElements.define('harness-prd-link', HarnessPrdLink);

declare global {
	interface HTMLElementTagNameMap {
		'harness-prd-link': HarnessPrdLink;
	}
}
