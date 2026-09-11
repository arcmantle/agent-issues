import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { map } from "lit/directives/map.js";

export type KanbanSelectMenuOption = {
	label: string;
	value: string;
};

export type KanbanSelectMenuState = {
	disabled: boolean;
	label: string;
	name: string;
	options: readonly KanbanSelectMenuOption[];
	value: string;
};

export type KanbanSelectMenuRenderService = {
	select: (value: string) => void;
	selectMenu: { get(): KanbanSelectMenuState };
};

export const kanbanSelectMenuRenderServiceContext = createContext<KanbanSelectMenuRenderService>(
	Symbol("kanban-select-menu-render-service")
);

let selectMenuId = 0;

@customElement("kanban-select-menu")
export class KanbanSelectMenu extends SignalWatcher(LitElement) {
	constructor() {
		super();
		this.selectId = `select-menu-${++selectMenuId}`;
	}

	@consume({ context: kanbanSelectMenuRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanSelectMenuRenderService | undefined;

	protected selectId: string;

	protected handleChange(event: Event) {
		const selectMenu = this.service?.selectMenu.get();
		if (selectMenu === undefined || selectMenu.disabled) {
			return;
		}

		const nextValue = (event.currentTarget as HTMLSelectElement).value;
		this.service?.select(nextValue);
		this.dispatchEvent(
			new CustomEvent("kanban-select-menu-change", {
				bubbles: true,
				composed: true,
				detail: {
					name: selectMenu.name,
					value: nextValue
				}
			})
		);
	}

	protected render() {
		const selectMenu = this.service?.selectMenu.get();
		if (selectMenu === undefined) {
			return html``;
		}

		return html`
		<div class="select-menu">
			<label for=${this.selectId}>${selectMenu.label}</label>
			<select
				?disabled=${selectMenu.disabled}
				id=${this.selectId}
				name=${selectMenu.name}
				.value=${selectMenu.value}
				@change=${this.handleChange}
			>
				${map(selectMenu.options, (option) => html`
				<option
					value=${option.value}
				>
					${option.label}
				</option>
				`)}
			</select>
		</div>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.select-menu {
		display: grid;
		gap: var(--size-4);
	}
	.select-menu label {
		color: var(--color-text-secondary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	.select-menu select {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		font: inherit;
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-strong);
		line-height: var(--line-height-ui);
		min-height: var(--size-19);
		padding: var(--size-5) var(--size-7);
		width: 100%;
	}
	.select-menu select:hover {
		border-color: var(--color-text-primary);
	}
	.select-menu select:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	.select-menu select:disabled {
		background: var(--color-surface-subtle);
		border-color: var(--color-border-subtle);
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-select-menu": KanbanSelectMenu;
	}

	interface HTMLElementEventMap {
		"kanban-select-menu-change": CustomEvent<{ name: string; value: string }>;
	}
}
