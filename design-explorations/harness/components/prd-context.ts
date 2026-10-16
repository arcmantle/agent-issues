import { html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { ChevronRight } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import { type InitiativeModel } from './initiative-route.js';
import './prd-link.js';

export class HarnessPrdContext extends LightElement {
	static override properties = {
		model: { attribute: false },
		expanded: { attribute: false },
	};

	constructor() {
		super();
		this.model = undefined;
		this.expanded = false;
	}

	declare model: InitiativeModel | undefined;
	declare expanded: boolean;

	protected handleToggle(event: Event) {
		this.dispatchEvent(
			new CustomEvent('harness-context-toggle', {
				detail: { open: (event.currentTarget as HTMLDetailsElement).open },
				bubbles: true,
			})
		);
	}

	protected override render() {
		const model = this.model;
		if (!model) return nothing;
		const relevant = model.prds.filter((prd) => prd.assigned.length > 0).length;
		const unlinked = model.unlinked
			.map((issue) => `${issue.reference} / ${issue.title}`)
			.join(', ');
		const unlinkedLabel = `${model.unlinked.length} issue${model.unlinked.length === 1 ? '' : 's'} without a PRD link`;
		return html`
		<details
			class="initiative-work-context"
			.open=${live(this.expanded)}
			@toggle=${this.handleToggle}
		>
			<summary>
				<span>${renderIcon(ChevronRight)}Related PRDs</span>
				<span>
					${relevant} relevant to assigned work
					${when(model.unlinked.length > 0, () => html` / ${unlinkedLabel} `)}
				</span>
			</summary>
			<ul class="work-context-prds">
				${repeat(
						model.prds,
						(prd) => prd.index,
						(prd) => html`
						<li>
							<harness-prd-link .prd=${prd}></harness-prd-link>
						</li>
						`
					)}
			</ul>
			${when(
					model.unlinked.length > 0,
					() => html` <p class="work-context-unlinked">No PRD link: ${unlinked}</p> `
				)}
		</details>
		`;
	}
}

customElements.define('harness-prd-context', HarnessPrdContext);

declare global {
	interface HTMLElementTagNameMap {
		'harness-prd-context': HarnessPrdContext;
	}
	interface HTMLElementEventMap {
		'harness-context-toggle': CustomEvent<{ open: boolean }>;
	}
}
