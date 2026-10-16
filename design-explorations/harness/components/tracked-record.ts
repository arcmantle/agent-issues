import { html, nothing } from 'lit';
import { CircleDot, FileText } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface TrackedRecordModel {
	kind: 'issue' | 'prd' | 'story' | 'adr';
	index: number;
	title: string;
	status: string;
}

export class HarnessTrackedRecord extends LightElement {
	static override properties = { record: { attribute: false } };

	constructor() {
		super();
		this.record = undefined;
	}

	declare record: TrackedRecordModel | undefined;

	protected override render() {
		const record = this.record;
		if (!record) return nothing;
		const symbol = record.kind === 'issue' ? CircleDot : FileText;
		return html`
		<button
			class="tracked-record"
			data-action="record"
			data-kind=${record.kind}
			data-index=${record.index}
		>
			<span>${renderIcon(symbol)}<span>${record.title}</span></span>
			<small>${record.status}</small>
		</button>
		`;
	}
}

customElements.define('harness-tracked-record', HarnessTrackedRecord);

declare global {
	interface HTMLElementTagNameMap {
		'harness-tracked-record': HarnessTrackedRecord;
	}
}
