import { html, nothing, type PropertyValues } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { LightElement } from './light-element.js';
import { type IssueModel } from './issue-card.js';
import './route-section.js';
import './prd-context.js';

export interface RouteSection {
	key: string;
	kind: 'current' | 'serial' | 'parallel' | 'final';
	stage: number;
	issues: IssueModel[];
	status: IssueModel['status'];
	prerequisites: string;
	nextReference: string;
}

export interface PrdModel {
	index: number;
	title: string;
	issueCount: number;
	assigned: IssueModel[];
}

export interface InitiativeModel {
	title: string;
	summary: string;
	integrated: number;
	issueCount: number;
	assignedCount: number;
	stageCount: number;
	parallelCount: number;
	resetVersion: number;
	sections: RouteSection[];
	prds: PrdModel[];
	unlinked: IssueModel[];
}

export class HarnessInitiativeRoute extends LightElement {
	static override properties = { model: { attribute: false } };

	constructor() {
		super();
		this.model = undefined;
	}

	declare model: InitiativeModel | undefined;
	protected expandedSections = new Set<string>();
	protected contextOpen = false;

	protected override willUpdate(changed: PropertyValues<this>) {
		const previous = changed.get('model');
		if (previous && previous.resetVersion !== this.model?.resetVersion) {
			this.expandedSections.clear();
			this.contextOpen = false;
			return;
		}
		for (const section of this.querySelectorAll<HTMLDetailsElement>('[data-route-segment]')) {
			const key = section.dataset.routeSegment!;
			if (section.open) this.expandedSections.add(key);
			else this.expandedSections.delete(key);
		}
		const context = this.querySelector<HTMLDetailsElement>('.initiative-work-context');
		if (context) this.contextOpen = context.open;
	}

	protected handleSectionToggle(event: CustomEvent<{ key: string; open: boolean }>) {
		if (event.detail.open) this.expandedSections.add(event.detail.key);
		else this.expandedSections.delete(event.detail.key);
	}

	protected handleContextToggle(event: CustomEvent<{ open: boolean }>) {
		this.contextOpen = event.detail.open;
	}

	protected renderSection(section: RouteSection) {
		const sectionClass =
			section.kind === 'current' ? 'route-stage route-stage-current' : 'route-segment';
		return html`
		<li class=${sectionClass}>
			<harness-route-section
				.section=${section}
				.assignedCount=${this.model?.assignedCount ?? 0}
				.expanded=${this.expandedSections.has(section.key)}
				@harness-route-toggle=${this.handleSectionToggle}
			></harness-route-section>
		</li>
		`;
	}

	protected override render() {
		const model = this.model;
		if (!model) return nothing;
		return html`
		<section class="initiative-route">
			<div class="route-heading">
				<div>
					<div class="eyebrow muted">Initiative / simulated</div>
					<h2>${model.title}</h2>
					<p>${model.summary}</p>
				</div>
				<span class="route-progress">${model.integrated} / ${model.issueCount} integrated</span>
			</div>
			<div class="route-summary">
				<h3>Work route</h3>
				<span
					>${model.stageCount} dependency stages / ${model.parallelCount} parallel stages</span
				>
			</div>
			<ol
				class="work-route long-work-route"
				aria-label="Initiative issue route"
			>
				${repeat(
						model.sections,
						(section) => section.key,
						(section) => this.renderSection(section)
					)}
			</ol>
			<harness-prd-context
				.model=${model}
				.expanded=${this.contextOpen}
				@harness-context-toggle=${this.handleContextToggle}
			></harness-prd-context>
		</section>
		`;
	}
}

customElements.define('harness-initiative-route', HarnessInitiativeRoute);

declare global {
	interface HTMLElementTagNameMap {
		'harness-initiative-route': HarnessInitiativeRoute;
	}
}
