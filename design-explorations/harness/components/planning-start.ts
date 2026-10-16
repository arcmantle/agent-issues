import { html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { Play } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import './selector.js';

export interface PlanningStartModel {
	repository: string;
	draft: { brief: string; initiative: string; mode: 'plan' | 'pioneer' };
	initiatives: { id: string; title: string }[];
}

export class HarnessPlanningStart extends LightElement {
	static override properties = { model: { attribute: false } };

	constructor() {
		super();
		this.model = undefined;
	}

	declare model: PlanningStartModel | undefined;

	protected override render() {
		const model = this.model;
		if (!model) return nothing;
		return html`
		<form
			class="planning-start-form"
			data-form="planning-start"
			data-repository=${model.repository}
		>
			<label for="planning-brief">Starting point</label>
			<textarea
				id="planning-brief"
				name="brief"
				rows="5"
				.value=${live(model.draft.brief)}
				required
			></textarea>
			<label for="planning-initiative-trigger">Initiative</label>
			<harness-selector
				.controlId=${'planning-initiative'}
				.name=${'initiative'}
				.label=${'Initiative'}
				.value=${model.draft.initiative}
				.options=${[
						{ value: '', label: 'Not yet defined' },
						...model.initiatives.map((initiative) => ({
							value: initiative.id,
							label: initiative.title,
						})),
					]}
			></harness-selector>
			<fieldset>
				<legend>Mode</legend>
				${repeat(
						[
							{ value: 'plan', label: 'Plan' },
							{ value: 'pioneer', label: 'Pioneer' },
						],
						(mode) => mode.value,
						(mode) => html`
						<label>
							<input
								type="radio"
								name="mode"
								value=${mode.value}
								.checked=${live(model.draft.mode === mode.value)}
							/>
							${mode.label}
						</label>
						`
					)}
			</fieldset>
			<div class="dialog-actions">
				<button class="primary">${renderIcon(Play)}Start planning</button>
			</div>
		</form>
		`;
	}
}

customElements.define('harness-planning-start', HarnessPlanningStart);

declare global {
	interface HTMLElementTagNameMap {
		'harness-planning-start': HarnessPlanningStart;
	}
}
