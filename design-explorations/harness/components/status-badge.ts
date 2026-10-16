import { html, nothing } from 'lit';
import { LightElement } from './light-element.js';
import { type IssueModel } from './issue-card.js';

export class HarnessStatusBadge extends LightElement {
	static override properties = { status: { attribute: false } };

	constructor() {
		super();
		this.status = undefined;
	}

	declare status: IssueModel['status'] | undefined;

	protected override render() {
		const status = this.status;
		if (!status) return nothing;
		return html`
		<span
			class=${`status ${status.tone}`}
			title=${status.detail}
		>
			${status.label}
		</span>
		`;
	}
}

customElements.define('harness-status-badge', HarnessStatusBadge);

declare global {
	interface HTMLElementTagNameMap {
		'harness-status-badge': HarnessStatusBadge;
	}
}
