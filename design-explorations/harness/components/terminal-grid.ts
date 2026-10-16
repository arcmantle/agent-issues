import { html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { LightElement } from './light-element.js';
import { type WorkerModel } from './terminal-panel.js';
import './terminal-panel.js';
import './terminal-selection.js';

export class HarnessTerminalGrid extends LightElement {
	static override properties = { workers: { attribute: false } };

	constructor() {
		super();
		this.workers = [];
	}

	declare workers: WorkerModel[];

	protected override render() {
		const selected = this.workers.filter((worker) => worker.visible);
		return html`
		<harness-terminal-selection .workers=${this.workers}></harness-terminal-selection>
		${when(
				selected.length > 0,
				() => html`
				<div
					class="terminal-grid"
					data-count=${selected.length}
				>
					${repeat(
							selected,
							(worker) => worker.id,
							(worker) => html`
							<harness-terminal-panel
								class="terminal-panel"
								aria-label=${`Worker ${worker.id} terminal`}
								.worker=${worker}
							></harness-terminal-panel>
							`
						)}
				</div>
				`,
				() => html`
				<section class="empty-terminals">
					<h2>No terminals selected</h2>
					<p>Agent execution is unchanged.</p>
				</section>
				`
			)}
		`;
	}
}

customElements.define('harness-terminal-grid', HarnessTerminalGrid);

declare global {
	interface HTMLElementTagNameMap {
		'harness-terminal-grid': HarnessTerminalGrid;
	}
}
