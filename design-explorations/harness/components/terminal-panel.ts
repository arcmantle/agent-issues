import { html, nothing } from 'lit';
import { Keyboard, Undo2 } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import './status-badge.js';

export interface WorkerModel {
	id: string;
	issue: string;
	status: string;
	label: string;
	manual: boolean;
	visible: boolean;
}

export class HarnessTerminalPanel extends LightElement {
	static override properties = { worker: { attribute: false } };

	constructor() {
		super();
		this.worker = undefined;
	}

	declare worker: WorkerModel | undefined;

	override connectedCallback() {
		super.connectedCallback();
		this.performUpdate();
	}

	protected override render() {
		const worker = this.worker;
		if (!worker) return nothing;
		const owner = worker.manual ? 'Input: you' : 'Input: harness';
		const label = worker.manual ? 'Return control' : 'Take control';
		const symbol = worker.manual ? Undo2 : Keyboard;
		const status = { tone: worker.status, label: worker.label, detail: worker.issue };
		return html`
		<div class="terminal-header">
			<strong>Worker ${worker.id} / Copilot</strong>
			<harness-status-badge .status=${status}></harness-status-badge>
		</div>
		<div class="terminal-meta">
			<span>${worker.issue}</span><span>attempt ${worker.id}.1</span>
		</div>
		<div
			class="terminal-host"
			data-terminal=${worker.id}
		></div>
		<div class="terminal-footer">
			<span>${owner}</span>
			<button
				data-action="takeover"
				data-id=${worker.id}
			>
				${renderIcon(symbol)}${label}
			</button>
		</div>
		`;
	}
}

customElements.define('harness-terminal-panel', HarnessTerminalPanel);

declare global {
	interface HTMLElementTagNameMap {
		'harness-terminal-panel': HarnessTerminalPanel;
	}
}
