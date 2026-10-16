import { html } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { Check, ChevronDown } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface SelectorOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export class HarnessSelector extends LightElement {
	static override properties = {
		options: { attribute: false },
		value: { attribute: false },
		label: { attribute: false },
		controlId: { attribute: false },
		name: { attribute: false },
		menuOpen: { state: true },
	};

	constructor() {
		super();
		this.options = [];
		this.value = '';
		this.label = '';
		this.controlId = 'initiative-selector';
		this.name = undefined;
		this.menuOpen = false;
	}

	declare options: SelectorOption[];
	declare value: string;
	declare label: string;
	declare controlId: string;
	declare name: string | undefined;
	declare protected menuOpen: boolean;
	protected searchText = '';
	protected searchTime = 0;

	protected handleTrigger() {
		const menu = this.querySelector<HTMLElement>('.select-menu')!;
		menu.togglePopover();
		if (menu.matches(':popover-open')) {
			(
				menu.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)') ??
				menu.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')
			)?.focus({ preventScroll: true });
		}
	}

	protected handleChoose(event: Event) {
		const button = event.currentTarget as HTMLButtonElement;
		this.value = button.dataset.value!;
		const input = this.querySelector('input')!;
		input.value = this.value;
		this.querySelector<HTMLElement>('.select-menu')!.hidePopover();
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
		queueMicrotask(() =>
			this.ownerDocument.getElementById(`${this.controlId}-trigger`)?.focus({ preventScroll: true })
		);
	}

	protected handleToggle(event: Event) {
		this.menuOpen = (event.currentTarget as HTMLElement).matches(':popover-open');
	}

	protected handleKeydown(event: KeyboardEvent) {
		const menu = this.querySelector<HTMLElement>('.select-menu')!;
		const open = menu.matches(':popover-open');
		const options = [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
		if ((event.key === 'Escape' && open) || (event.key === 'Tab' && open)) {
			if (event.key === 'Escape') event.preventDefault();
			event.stopPropagation();
			menu.hidePopover();
			this.querySelector<HTMLButtonElement>('.select-trigger')!.focus();
		} else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			if (!options.length) return;
			const current = options.indexOf(
				open
					? (this.ownerDocument.activeElement as HTMLButtonElement)
					: menu.querySelector('[aria-selected="true"]')!
			);
			if (!open) menu.showPopover();
			const direction = event.key === 'ArrowDown' ? 1 : -1;
			const next =
				event.key === 'Home'
					? 0
					: event.key === 'End'
						? options.length - 1
						: (current + direction + options.length) % options.length;
			options[next]!.focus();
		} else if (
			event.key.length === 1 &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			event.key !== ' '
		) {
			event.preventDefault();
			event.stopPropagation();
			const now = Date.now();
			this.searchText = now - this.searchTime < 700 ? this.searchText + event.key : event.key;
			this.searchTime = now;
			if (!open) menu.showPopover();
			options
				.find((option) =>
					option.textContent!.trim().toLowerCase().startsWith(this.searchText.toLowerCase())
				)
				?.focus();
		}
	}

	protected override render() {
		const selected = this.options.find((option) => option.value === this.value);
		return html`
		<div @keydown=${this.handleKeydown}>
			<input
				type="hidden"
				id=${this.controlId}
				name=${ifDefined(this.name)}
				.value=${live(this.value)}
			/>
			<button
				id=${`${this.controlId}-trigger`}
				type="button"
				class="select-trigger"
				aria-haspopup="listbox"
				aria-expanded=${live(String(this.menuOpen))}
				aria-controls=${`${this.controlId}-menu`}
				aria-label=${`${this.label}: ${selected?.label ?? ''}`}
				?disabled=${this.options.every((option) => option.disabled)}
				@click=${this.handleTrigger}
			>
				<span>${selected?.label}</span>${renderIcon(ChevronDown)}
			</button>
			<div
				id=${`${this.controlId}-menu`}
				class="select-menu"
				popover="auto"
				role="listbox"
				aria-label=${this.label}
				@toggle=${this.handleToggle}
			>
				${repeat(
						this.options,
						(option) => option.value,
						(option) => html`
						<button
							type="button"
							role="option"
							tabindex="-1"
							aria-selected=${String(option.value === this.value)}
							data-value=${option.value}
							?disabled=${option.disabled}
							@click=${this.handleChoose}
						>
							<span>${option.label}</span>${renderIcon(Check)}
						</button>
						`
					)}
			</div>
		</div>
		`;
	}
}

customElements.define('harness-selector', HarnessSelector);

declare global {
	interface HTMLElementTagNameMap {
		'harness-selector': HarnessSelector;
	}
}
