import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";

import "./initiative-detail-view.js";
import "./issue-detail-view.js";
import type { Entity } from "../models.js";
import type { AgentIssuesStore } from "../services/agent-issues-store.js";

class CascadeView extends SignalWatcher(LitElement) {
	static properties = {
		store: { attribute: false },
		openForkKey: { state: true }
	};

	public store: AgentIssuesStore | null = null;
	protected openForkKey: string | null = null;

	protected onCrumbClick = (event: Event) => {
		const entityId = (event.currentTarget as HTMLElement).dataset.id;
		if (entityId) {
			this.store?.truncateCascadeTo(entityId);
		}
	};

	protected onForkToggle = (event: Event) => {
		const key = (event.currentTarget as HTMLElement).dataset.forkKey ?? null;
		this.openForkKey = this.openForkKey === key ? null : key;
	};

	protected onForkSelect = (event: Event) => {
		const target = event.currentTarget as HTMLElement;
		const rootId = target.dataset.rootId;
		const storyId = target.dataset.storyId;
		this.openForkKey = null;
		if (rootId && storyId) {
			this.store?.selectCascadeBranch(rootId, storyId);
		}
	};

	protected onChipClick = (event: Event) => {
		const index = Number((event.currentTarget as HTMLElement).dataset.index);
		if (!Number.isNaN(index)) {
			this.store?.restoreReRoot(index);
		}
	};

	protected measureAvailableWidth = () => {
		const width = this.clientWidth;
		if (width > 0) {
			this.store?.cascadeAvailableWidth.set(width);
		}
	};

	protected resizeObserver: ResizeObserver | null = null;

	connectedCallback() {
		super.connectedCallback();
		this.resizeObserver = new ResizeObserver(() => this.measureAvailableWidth());
		this.resizeObserver.observe(this);
		window.addEventListener("resize", this.measureAvailableWidth);
	}

	disconnectedCallback() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		window.removeEventListener("resize", this.measureAvailableWidth);
		super.disconnectedCallback();
	}

	protected firstUpdated() {
		this.measureAvailableWidth();
	}

	protected renderColumn(entity: Entity, activeChildId: string | null) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		return html`
		<div class="cascade-column" data-column-id=${entity.id}>
			${entity.kind === "initiative"
				? html`<agent-issues-initiative-detail-view .store=${store} .initiativeId=${entity.id} .cascade=${true} .activeChildId=${activeChildId}></agent-issues-initiative-detail-view>`
				: html`<agent-issues-detail-view .store=${store} .entityId=${entity.id} .cascade=${true} .activeChildId=${activeChildId}></agent-issues-detail-view>`}
		</div>
		`;
	}

	render() {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const { columns } = store.cascadeColumnWindow.get();
		const path = store.cascadeColumns.get();
		const trail = store.reRootTrail.get();

		return html`
		${trail.length > 0
			? html`
			<div class="re-root-trail">
				${repeat(
					trail,
					(path) => path.join("~"),
					(path, index) => {
						const leafId = path[path.length - 1];
						const leaf = store.entityForId(leafId);
						return html`
						<button class="re-root-chip" data-index=${index} title=${leaf?.title ?? leafId} @click=${this.onChipClick}>
							${leafId}
						</button>
						`;
					}
				)}
			</div>
			`
			: nothing}
		${this.renderBreadcrumb(path)}
		<div class="cascade-track">
			${columns.map((entity, index) => {
				const parent = columns[index - 1];
				const seam = parent ? this.renderConnector(parent.id, entity.id) : nothing;
				const activeChildId = columns[index + 1]?.id ?? null;
				return html`${seam}${this.renderColumn(entity, activeChildId)}`;
			})}
		</div>
		`;
	}

	protected renderBreadcrumb(path: Entity[]) {
		const store = this.store;
		if (!store || path.length === 0) {
			return nothing;
		}

		return html`
		<div class="cascade-breadcrumb">
			${repeat(
				path,
				(entity) => entity.id,
				(entity, index) => {
					const isCurrent = index === path.length - 1;
					const childId = path[index + 1]?.id ?? null;
					const branch = childId ? store.cascadeSeamFor(entity.id, childId).branch : null;
					const label = html`
						<span class="crumb-id">${entity.id}</span>
						<span class="crumb-title">${entity.title}</span>
					`;
					return html`
					<div class="cascade-crumb-item">
						${isCurrent
							? html`<span class="cascade-crumb is-current" data-id=${entity.id} title=${entity.title}>${label}</span>`
							: html`<button class="cascade-crumb" data-id=${entity.id} title=${entity.title} @click=${this.onCrumbClick}>${label}</button>`}
						${branch && childId ? this.renderFork(entity.id, childId, branch) : nothing}
					</div>
					`;
				}
			)}
		</div>
		`;
	}

	protected renderFork(currentId: string, childId: string, branch: { options: Entity[]; selectedIndex: number }) {
		const open = this.openForkKey === childId;

		return html`
		<div class="crumb-fork">
			<button
				class="crumb-fork-toggle"
				type="button"
				title="Switch lineage variant"
				aria-haspopup="listbox"
				aria-expanded=${open}
				data-fork-key=${childId}
				@click=${this.onForkToggle}
			>
				<span class="crumb-fork-glyph" aria-hidden="true">⑂</span>
				<span class="crumb-fork-count">${branch.selectedIndex + 1}/${branch.options.length}</span>
			</button>
			${open
				? html`
				<ul class="crumb-fork-menu" role="listbox">
					${branch.options.map((option) => {
						const selected = option.id === currentId;
						return html`
						<li role="option" aria-selected=${selected}>
							<button
								class="crumb-fork-option ${selected ? "is-selected" : ""}"
								type="button"
								data-root-id=${childId}
								data-story-id=${option.id}
								@click=${this.onForkSelect}
							>
								<span class="crumb-fork-check" aria-hidden="true">${selected ? "✓" : ""}</span>
								<span class="crumb-fork-option-title">${option.title}</span>
							</button>
						</li>
						`;
					})}
				</ul>
				`
				: nothing}
		</div>
		`;
	}

	protected renderConnector(parentId: string, childId: string) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const { relation } = store.cascadeSeamFor(parentId, childId);
		return html`<div class="cascade-connector" aria-hidden="true">${relation ?? ""}</div>`;
	}

	static styles = css`
	:host {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.re-root-trail {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border, #d0d7de);
		background: var(--canvas, #fff);
	}
	.re-root-chip {
		display: inline-flex;
		align-items: center;
		padding: 2px 10px;
		border: 1px solid var(--border, #d0d7de);
		border-radius: 12px;
		background: var(--canvas-subtle, #f6f8fa);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.re-root-chip:hover {
		border-color: var(--accent, #0969da);
	}
	.cascade-breadcrumb {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border, #d0d7de);
		background: var(--canvas-subtle, #f6f8fa);
	}
	.cascade-crumb-item {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.cascade-crumb {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		max-width: 220px;
		padding: 2px 8px;
		border: 1px solid var(--border, #d0d7de);
		border-radius: 12px;
		background: var(--canvas, #fff);
		font: inherit;
		cursor: pointer;
	}
	button.cascade-crumb:hover {
		background: var(--canvas-subtle, #f6f8fa);
	}
	.cascade-crumb.is-current {
		border-color: var(--accent, #0969da);
		background: var(--accent-subtle, #ddf4ff);
		cursor: default;
	}
	.crumb-fork {
		position: relative;
		display: inline-flex;
	}
	.crumb-fork-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border: 1px solid var(--accent, #0969da);
		border-radius: 12px;
		background: var(--accent-subtle, #ddf4ff);
		color: var(--accent, #0969da);
		font: inherit;
		font-weight: 600;
		line-height: 1.4;
		cursor: pointer;
	}
	.crumb-fork-toggle:hover {
		filter: brightness(0.97);
	}
	.crumb-fork-glyph {
		font-size: 12px;
	}
	.crumb-fork-count {
		font-variant-numeric: tabular-nums;
	}
	.crumb-fork-menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 5;
		min-width: 200px;
		max-width: 320px;
		margin: 0;
		padding: 4px;
		list-style: none;
		border: 1px solid var(--border, #d0d7de);
		border-radius: 10px;
		background: var(--canvas, #fff);
		box-shadow: 0 6px 18px rgba(31, 35, 40, 0.18);
	}
	.crumb-fork-option {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 4px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.crumb-fork-option:hover {
		background: var(--canvas-subtle, #f6f8fa);
	}
	.crumb-fork-option.is-selected {
		font-weight: 600;
	}
	.crumb-fork-check {
		flex: 0 0 12px;
		color: var(--accent, #0969da);
	}
	.crumb-fork-option-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.crumb-id {
		font-weight: 600;
	}
	.crumb-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--fg-muted, #57606a);
	}
	.cascade-track {
		display: flex;
		align-items: stretch;
		flex: 1 1 auto;
		min-height: 0;
		gap: 16px;
		overflow-x: auto;
		overflow-y: hidden;
	}
	.cascade-column {
		flex: 0 0 480px;
		height: 100%;
		overflow-y: auto;
		border-right: 1px solid var(--border, #d0d7de);
	}
	.cascade-column:last-child {
		flex: 1 1 480px;
		border-right: 0;
	}
	.cascade-connector {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		align-self: flex-start;
		margin-top: 10px;
		padding: 2px 6px;
		border: 1px solid var(--border, #d0d7de);
		border-radius: 10px;
		background: var(--canvas-subtle, #f6f8fa);
		color: var(--fg-muted, #57606a);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		white-space: nowrap;
	}
	`;
}

customElements.define("agent-issues-cascade-view", CascadeView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-cascade-view": CascadeView;
	}
}
