import { html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { LightElement } from './light-element.js';

export interface ActivityEntry {
	title: string;
	detail: string;
}

export class HarnessActivityTimeline extends LightElement {
	static override properties = { entries: { attribute: false } };

	constructor() {
		super();
		this.entries = [];
	}

	declare entries: ActivityEntry[];

	protected override render() {
		return html`
		<section
			class="merge-history"
			aria-label="Merge activity"
		>
			<div class="section-heading">
				<h2>Merge activity</h2>
				<span class="muted">${this.entries.length} events</span>
			</div>
			${when(
					this.entries.length > 0,
					() => html`
					<ol>
						${repeat(
								this.entries,
								(_, index) => index,
								(entry, index) => html`
								<li>
									<span class="mono">${String(index + 1).padStart(2, '0')}</span>
									<div>
										<strong>${entry.title}</strong>
										<p>${entry.detail}</p>
									</div>
								</li>
								`
							)}
					</ol>
					`,
					() => html`
					<p class="muted">
						Worker checks and independent review passed. Merge approval pending.
					</p>
					`
				)}
		</section>
		`;
	}
}

customElements.define('harness-activity-timeline', HarnessActivityTimeline);

declare global {
	interface HTMLElementTagNameMap {
		'harness-activity-timeline': HarnessActivityTimeline;
	}
}
