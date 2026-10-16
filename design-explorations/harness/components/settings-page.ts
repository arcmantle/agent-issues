import { html, nothing, type PropertyValues } from 'lit';
import { live } from 'lit/directives/live.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { ChevronDown, Plug, RotateCcw, Save, Unplug, X } from 'lucide';
import {
	SettingsController,
	money,
	providerIds,
	providers,
	type NumericSetting,
	type ProviderId,
	type SettingsValues,
} from '../settings.js';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import './selector.js';

export class HarnessSettingsPage extends LightElement {
	static override properties = {
		controller: { attribute: false },
		repository: { attribute: false },
		scope: { attribute: false },
	};

	constructor() {
		super();
		this.controller = undefined;
		this.repository = 'agent-issues';
		this.scope = 'global';
	}

	declare controller: SettingsController | undefined;
	declare repository: string;
	declare scope: 'global' | 'project';
	protected draft: SettingsValues | undefined;
	protected overrides = new Set<NumericSetting>();
	protected customProviders = false;
	protected customModels = false;
	protected approval = 'inherit';
	protected status = 'Saved';
	protected error = '';
	protected searches = new Map<ProviderId, string>();
	protected selectedOnly = new Set<ProviderId>();

	protected override willUpdate(changes: PropertyValues<this>) {
		if (changes.has('controller') || changes.has('repository') || changes.has('scope')) this.load();
	}

	protected load() {
		if (!this.controller) return;
		const project = this.controller.projects[this.repository] ?? {};
		this.draft = structuredClone(
			this.scope === 'global' ? this.controller.global : this.controller.effective(this.repository)
		);
		this.overrides = new Set(
			(['budget', 'warning', 'workers'] as const).filter((key) => project[key] !== undefined)
		);
		this.customProviders = project.providers !== undefined;
		this.customModels = project.models !== undefined;
		this.approval = project.approval === undefined ? 'inherit' : String(project.approval);
		this.status = 'Saved';
		this.error = '';
	}

	refresh() {
		this.load();
		this.requestUpdate();
	}

	protected handleInput(event: Event) {
		const input = event.target as HTMLInputElement;
		if (!this.draft) return;
		const provider = input.dataset.provider as ProviderId;
		if (input.dataset.modelSearch !== undefined)
			this.searches.set(provider, input.value.toLowerCase());
		else if (input.dataset.modelSelectedOnly !== undefined) {
			if (input.checked) this.selectedOnly.add(provider);
			else this.selectedOnly.delete(provider);
		} else {
			this.status = 'Unsaved changes';
			if (input.name.startsWith('override-')) {
				const key = input.name.slice(9) as NumericSetting;
				if (input.checked) this.overrides.add(key);
				else this.overrides.delete(key);
			} else if (input.name === 'provider-mode') this.customProviders = input.value === 'custom';
			else if (input.name === 'model-mode') this.customModels = input.value === 'custom';
			else if (input.name === 'approval') {
				this.approval = input.value;
				this.draft.approval = input.checked;
			} else if (input.name === 'providers')
				this.draft.providers = providerIds.filter((id) =>
					id === input.value ? input.checked : this.draft!.providers.includes(id)
				);
			else if (input.name.startsWith('models-'))
				this.draft.models[provider] = providers[provider].models.filter((model) =>
					model === input.value ? input.checked : this.draft!.models[provider].includes(model)
				);
			else if (input.type === 'number')
				this.draft[input.name as NumericSetting] = input.valueAsNumber;
		}
		this.requestUpdate();
	}

	protected handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		if (!form.reportValidity()) return;
		this.error = this.controller!.save(this.scope, this.repository, new FormData(form));
		if (!this.error) {
			this.load();
			this.dispatchEvent(new CustomEvent('harness-settings-saved', { bubbles: true }));
		}
		this.requestUpdate();
	}

	protected handleDefaults() {
		delete this.controller!.projects[this.repository];
		this.load();
		this.requestUpdate();
		this.dispatchEvent(new CustomEvent('harness-settings-saved', { bubbles: true }));
	}

	protected handleConnection(event: Event) {
		const provider = (event.currentTarget as HTMLElement).dataset.provider as ProviderId;
		this.controller!.global.connections[provider] = !this.controller!.global.connections[provider];
		this.requestUpdate();
	}

	protected handleModelToggle(event: Event) {
		const menu = event.currentTarget as HTMLElement;
		const trigger = menu.parentElement!.querySelector('button')!;
		const bounds = trigger.getBoundingClientRect();
		const width = Math.min(360, innerWidth - 24);
		menu.style.width = `${width}px`;
		menu.style.left = `${Math.max(12, Math.min(bounds.left, innerWidth - width - 12))}px`;
		menu.style.top = `${Math.min(bounds.bottom + 8, innerHeight - 380)}px`;
	}

	protected renderNumber(key: NumericSetting, label: string, maximum?: number) {
		const project = this.scope === 'project';
		const integer = ['workers', 'projectWorkers', 'copilotRequests', 'interpreterCalls'].includes(
			key
		);
		const inherited = project && !this.overrides.has(key);
		return html`
		<div
			class="settings-field"
			data-setting-row=${key}
		>
			<label for=${`${this.scope}-${key}`}>${label}</label>
			${when(
					project,
					() => html`
					<label class="settings-toggle">
						<input
							type="checkbox"
							name=${`override-${key}`}
							aria-label=${`Override ${label}`}
							.checked=${live(!inherited)}
						/>
						Project override
					</label>
					`
				)}
			<input
				id=${`${this.scope}-${key}`}
				name=${key}
				type="number"
				min=${integer
						? key === 'copilotRequests'
							? 18
							: key === 'interpreterCalls'
								? 42
								: 1
						: 0}
				max=${ifDefined(maximum)}
				step=${integer ? 1 : '.01'}
				.value=${live(Number.isNaN(this.draft![key]) ? '' : String(this.draft![key]))}
				?disabled=${inherited}
				?required=${!inherited}
			/>
			<span class="muted"
				>${inherited ? 'Inherited' : project ? 'Project override' : 'Global'}</span
			>
		</div>
		`;
	}

	protected renderProvider(provider: ProviderId) {
		const definition = providers[provider];
		const project = this.scope === 'project';
		const global = this.controller!.global;
		const blocked = project && !global.providers.includes(provider);
		const connected = global.connections[provider];
		const matches = definition.models.filter(
			(model) =>
				model.toLowerCase().includes(this.searches.get(provider) ?? '') &&
				(!this.selectedOnly.has(provider) || this.draft!.models[provider].includes(model))
		);
		return html`
		<fieldset class="settings-provider">
			<legend>${definition.name}</legend>
			<label class="settings-toggle">
				<input
					type="checkbox"
					name="providers"
					value=${provider}
					.checked=${live(this.draft!.providers.includes(provider))}
					?disabled=${(project && !this.customProviders) || blocked}
				/>
				Permitted${when(blocked, () => ' / Blocked globally')}
			</label>
			${when(
					!project,
					() => html`
					<div class="settings-connection">
						<span>${connected ? 'Connected / Example' : 'Not connected'}</span>
						<button
							type="button"
							data-provider=${provider}
							@click=${this.handleConnection}
						>
							${renderIcon(connected ? Unplug : Plug)}${connected ? 'Disconnect' : 'Connect'}
						</button>
					</div>
					`
				)}
			<div class="settings-model-selector">
				<button
					type="button"
					class="settings-model-trigger"
					popovertarget=${`${this.scope}-${provider}-models`}
					aria-label=${`${definition.name} permitted models`}
				>
					<span>Models</span
					><span>${this.draft!.models[provider].length} selected</span>${renderIcon(ChevronDown)}
				</button>
				<div
					id=${`${this.scope}-${provider}-models`}
					class="settings-model-menu"
					popover="auto"
					role="group"
					aria-label=${`${definition.name} permitted models`}
					@beforetoggle=${this.handleModelToggle}
				>
					<input
						type="search"
						data-model-search
						data-provider=${provider}
						aria-label=${`Search ${definition.name} models`}
						placeholder="Search models"
					/>
					<label class="settings-toggle"
						><input
							type="checkbox"
							data-model-selected-only
							data-provider=${provider}
						/>Selected only</label
					>
					<div class="settings-models">
						${repeat(
								definition.models,
								(model) => model,
								(model) => html`
								<label
									class="settings-toggle"
									.hidden=${live(!matches.includes(model))}
								>
									<input
										type="checkbox"
										name=${`models-${provider}`}
										value=${model}
										data-provider=${provider}
										.checked=${live(this.draft!.models[provider].includes(model))}
										?disabled=${project &&
											(!this.customModels || !global.models[provider].includes(model))}
									/>
									${model}
								</label>
								`
							)}
					</div>
					${when(!matches.length, () => html`<p class="muted">No models found</p>`)}
				</div>
			</div>
		</fieldset>
		`;
	}

	protected override render() {
		if (!this.controller || !this.draft) return nothing;
		const global = this.controller.global;
		const project = this.scope === 'project';
		const total = Object.values(this.controller.usage).reduce((sum, value) => sum + value, 0);
		const used = project ? (this.controller.usage[this.repository] ?? 0) : total;
		const values = project ? this.controller.effective(this.repository) : global;
		const limitState =
			total >= global.budget
				? 'Global stop limit reached'
				: used >= values.budget
					? 'Project stop limit reached'
					: total >= global.warning || used >= values.warning
						? 'Warning threshold reached'
						: 'Within limits';
		return html`
		<header class="page-heading">
			<h1>${project ? 'Project Settings' : 'Global Settings'}</h1>
			<button
				class="icon-button"
				data-action="close-settings"
				title="Close settings"
				aria-label="Close settings"
			>
				${renderIcon(X)}
			</button>
		</header>
		<div class="settings-content">
			<section class="settings-usage">
				<div class="section-label">
					<h2>Usage</h2>
					<span class="muted">Current month / Estimated / Example</span>
				</div>
				<dl>
					<div>
						<dt>Spend</dt>
						<dd>${money(used)}</dd>
					</div>
					<div>
						<dt>Remaining budget</dt>
						<dd>${money(Math.max(0, values.budget - used))}</dd>
					</div>
					<div>
						<dt>Global remaining</dt>
						<dd>${money(Math.max(0, global.budget - total))}</dd>
					</div>
					<div>
						<dt>Limit state</dt>
						<dd>${limitState}</dd>
					</div>
				</dl>
			</section>
			<form
				data-form="settings"
				data-scope=${this.scope}
				@input=${this.handleInput}
				@submit=${this.handleSubmit}
			>
				<section class="settings-section">
					<h2>Cost Controls</h2>
					<div class="settings-fields">
						${this.renderNumber(
								'budget',
								project ? 'Project stop limit / USD' : 'Global stop limit / USD',
								project ? global.budget : undefined
							)}
						${this.renderNumber(
								'warning',
								'Warning threshold / USD',
								project ? Math.min(global.warning, this.draft.budget) : undefined
							)}
						${when(
								!project,
								() =>
									html`${this.renderNumber(
										'projectBudget',
										'Default project budget / USD',
										this.draft!.budget
									)}${this.renderNumber(
										'copilotRequests',
										'Copilot request limit'
									)}${this.renderNumber('interpreterCalls', 'Interpreter call limit')}`
							)}
					</div>
				</section>
				<section class="settings-section">
					<h2>Workers And Approvals</h2>
					<div class="settings-fields">
						${this.renderNumber(
								'workers',
								project ? 'Project worker limit' : 'Total worker limit',
								project ? global.workers : undefined
							)}${when(!project, () =>
								this.renderNumber(
									'projectWorkers',
									'Default project worker limit',
									this.draft!.workers
								)
							)}
					</div>
					${when(
							project,
							() => html`
							<label
								>New-run approval<harness-selector
									.controlId=${'project-approval'}
									.name=${'approval'}
									.label=${'New-run approval'}
									.value=${this.approval}
									.options=${[
											{ value: 'inherit', label: 'Inherited' },
											{ value: 'true', label: 'Required' },
											{ value: 'false', label: 'Not required', disabled: global.approval },
										]}
								></harness-selector
							></label>
							`,
							() =>
								html`<label class="settings-toggle"
								><input
									type="checkbox"
									name="approval"
									.checked=${live(this.draft!.approval)}
								/>Require approval for new runs</label
							>`
						)}
					<label class="settings-toggle"
						><input
							type="checkbox"
							checked
							disabled
						/>Integration approval required</label
					>
					<label class="settings-toggle"
						><input
							type="checkbox"
							checked
							disabled
						/>Final merge approval required</label
					>
				</section>
				<section class="settings-section">
					<h2>Providers And Models</h2>
					${when(
							project,
							() => html`
							<div class="settings-fields">
								<label
									>Permitted providers<harness-selector
										.controlId=${'project-provider-mode'}
										.name=${'provider-mode'}
										.label=${'Permitted providers'}
										.value=${this.customProviders ? 'custom' : 'inherit'}
										.options=${[
												{ value: 'inherit', label: 'Inherited' },
												{ value: 'custom', label: 'Project override' },
											]}
									></harness-selector
								></label>
								<label
									>Permitted models<harness-selector
										.controlId=${'project-model-mode'}
										.name=${'model-mode'}
										.label=${'Permitted models'}
										.value=${this.customModels ? 'custom' : 'inherit'}
										.options=${[
												{ value: 'inherit', label: 'Inherited' },
												{ value: 'custom', label: 'Project override' },
											]}
									></harness-selector
								></label>
							</div>
							`
						)}
					<div class="settings-provider-list">
						${repeat(
								providerIds,
								(provider) => provider,
								(provider) => this.renderProvider(provider)
							)}
					</div>
				</section>
				<p
					class="settings-error"
					role="alert"
				>
					${this.error}
				</p>
				<div class="dialog-actions">
					<span data-settings-status>${this.status}</span>
					${when(
							project,
							() =>
								html`<button
								type="button"
								@click=${this.handleDefaults}
							>
								${renderIcon(RotateCcw)}Use Global Defaults
							</button>`
						)}
					<button
						class="primary"
						type="submit"
					>
						${renderIcon(Save)}Save settings
					</button>
				</div>
			</form>
		</div>
		`;
	}
}

customElements.define('harness-settings-page', HarnessSettingsPage);

declare global {
	interface HTMLElementTagNameMap {
		'harness-settings-page': HarnessSettingsPage;
	}
	interface HTMLElementEventMap {
		'harness-settings-saved': CustomEvent;
	}
}
