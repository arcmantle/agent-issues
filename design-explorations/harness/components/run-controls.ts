import { html } from 'lit';
import { OctagonX, Pause, Play, Square } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export class HarnessRunControls extends LightElement {
	static override properties = { mode: { attribute: false } };

	constructor() {
		super();
		this.mode = 'running';
	}

	declare mode: string;

	protected override render() {
		const active = ['running', 'paused'].includes(this.mode);
		const label = this.mode === 'paused' ? 'Resume' : 'Pause';
		const symbol = this.mode === 'paused' ? Play : Pause;
		return html`
		<div class="controls">
			<button
				data-action="pause"
				?disabled=${!active}
			>
				${renderIcon(symbol)}${label}
			</button>
			<button
				data-action="stop"
				?disabled=${!active}
			>
				${renderIcon(Square)}Stop
			</button>
			<button
				class="icon-button danger"
				data-action="terminate"
				title="Terminate workers"
				aria-label="Terminate workers"
				?disabled=${!active && this.mode !== 'stopping'}
			>
				${renderIcon(OctagonX)}
			</button>
		</div>
		`;
	}
}

customElements.define('harness-run-controls', HarnessRunControls);

declare global {
	interface HTMLElementTagNameMap {
		'harness-run-controls': HarnessRunControls;
	}
}
