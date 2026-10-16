import { html } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { LightElement } from './light-element.js';
import { type WorkerModel } from './terminal-panel.js';

export class HarnessTerminalSelection extends LightElement {
	static override properties = { workers: { attribute: false } };

	constructor() {
		super();
		this.workers = [];
	}

	declare workers: WorkerModel[];

	override connectedCallback() {
		super.connectedCallback();
		this.performUpdate();
	}

	protected override render() {
		return html`
		<section
			class="agent-selection"
			aria-label="Terminal selection"
		>
			<div class="section-label eyebrow">
				<span>Terminal selection</span
				><span>${this.workers.filter((worker) => worker.visible).length} visible</span>
			</div>
			<div class="worker-list">
				${repeat(
						this.workers,
						(worker) => worker.id,
						(worker) => {
							const rowClass = worker.visible ? 'worker-row selected' : 'worker-row';
							return html`
							<label class=${rowClass}>
								<span class="worker-number">${worker.id}</span>
								<span><strong>Worker ${worker.id}</strong><small>${worker.label}</small></span>
								<input
									type="checkbox"
									data-worker=${worker.id}
									.checked=${live(worker.visible)}
									aria-label=${`Show Worker ${worker.id} terminal`}
								/>
							</label>
							`;
						}
					)}
			</div>
		</section>
		`;
	}
}

customElements.define('harness-terminal-selection', HarnessTerminalSelection);

declare global {
	interface HTMLElementTagNameMap {
		'harness-terminal-selection': HarnessTerminalSelection;
	}
}
