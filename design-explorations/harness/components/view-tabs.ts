import { html } from 'lit';
import { live } from 'lit/directives/live.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { FileDiff, GitMerge, Route, type IconNode } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface ViewTab {
	id: string;
	label: string;
	symbol: IconNode;
}

export class HarnessViewTabs extends LightElement {
	static override properties = {
		selected: { attribute: false },
		reviewCount: { attribute: false },
		mergeCount: { attribute: false },
	};

	constructor() {
		super();
		this.selected = 'initiative';
		this.reviewCount = 0;
		this.mergeCount = 0;
	}

	declare selected: string;
	declare reviewCount: number;
	declare mergeCount: number;
	protected tabs: ViewTab[] = [
		{ id: 'initiative', label: 'Initiative', symbol: Route },
		{ id: 'review', label: 'Review', symbol: FileDiff },
		{ id: 'merge', label: 'Merge', symbol: GitMerge },
	];

	protected override render() {
		return repeat(
			this.tabs,
			(tab) => tab.id,
			(tab) => {
				const count = tab.id === 'review' ? this.reviewCount : this.mergeCount;
				const selected = this.selected === tab.id;
				const tabIndex = selected ? 0 : -1;
				const action = tab.id === 'merge' ? undefined : 'workspace-view';
				const panel = tab.id === 'merge' ? 'initiative-merge-panel' : `${tab.id}-panel`;
				return html`
				<button
					id=${`${tab.id}-tab`}
					role="tab"
					data-action=${ifDefined(action)}
					data-view=${tab.id}
					aria-controls=${panel}
					aria-label=${tab.id === 'initiative' ? tab.label : `${tab.label}, ${count} pending`}
					aria-selected=${live(String(selected))}
					.tabIndex=${live(tabIndex)}
				>
					${renderIcon(tab.symbol)}${tab.label}
					${when(
						tab.id !== 'initiative',
						() => html`
						<span
							class="view-tab-count"
							aria-hidden="true"
						>
							${count}
						</span>
						`
					)}
				</button>
				`;
			}
		);
	}
}

customElements.define('harness-view-tabs', HarnessViewTabs);

declare global {
	interface HTMLElementTagNameMap {
		'harness-view-tabs': HarnessViewTabs;
	}
}
