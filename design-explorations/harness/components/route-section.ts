import { html, nothing } from 'lit';
import { choose } from 'lit/directives/choose.js';
import { live } from 'lit/directives/live.js';
import { when } from 'lit/directives/when.js';
import { ChevronRight, Flag, GitFork, GitMerge } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import { type RouteSection } from './initiative-route.js';
import './issue-list.js';
import './status-badge.js';

export class HarnessRouteSection extends LightElement {
	static override properties = {
		section: { attribute: false },
		assignedCount: { attribute: false },
		expanded: { attribute: false },
	};

	constructor() {
		super();
		this.section = undefined;
		this.assignedCount = 0;
		this.expanded = false;
	}

	declare section: RouteSection | undefined;
	declare assignedCount: number;
	declare expanded: boolean;

	protected handleToggle(event: Event) {
		const section = event.currentTarget as HTMLDetailsElement;
		this.dispatchEvent(
			new CustomEvent('harness-route-toggle', {
				detail: { key: this.section!.key, open: section.open },
				bubbles: true,
			})
		);
	}

	protected renderCurrent(section: RouteSection) {
		return html`
		<div class="route-stage-heading">
			<span class="route-step">${section.stage}</span>
			<div>
				<h3>Current work</h3>
				<span>${this.assignedCount} assigned / ${section.issues.length} independent issues</span>
			</div>
		</div>
		<harness-issue-list .issues=${section.issues}></harness-issue-list>
		`;
	}

	protected renderSerial(section: RouteSection) {
		const first = section.issues[0]!;
		const last = section.issues.at(-1)!;
		return html`
		<details
			data-route-segment=${section.key}
			.open=${live(this.expanded)}
			@toggle=${this.handleToggle}
		>
			<summary>
				<span class="route-step">${section.stage}</span>
				<span class="route-segment-heading">
					<strong>Serial chain / ${section.issues.length} issues</strong>
					<span>${first.reference} to ${last.reference} / ${first.title} to ${last.title}</span>
				</span>
				<harness-status-badge .status=${section.status}></harness-status-badge>
				${renderIcon(ChevronRight)}
			</summary>
			<harness-issue-list
				.issues=${section.issues}
				.listClass=${'route-issues route-serial-issues'}
			></harness-issue-list>
		</details>
		`;
	}

	protected renderBranches(section: RouteSection) {
		const final = section.kind === 'final';
		const title = final ? 'Final approval' : `Parallel work / ${section.issues.length} issues`;
		const symbol = final ? Flag : GitFork;
		const listClass = final ? 'route-issues' : 'route-issues route-parallel-issues';
		return html`
		<div class="route-fork-heading">
			<span class="route-step">${section.stage}</span>
			<span class="route-segment-heading">
				<strong>${title}</strong>
				<span>After ${section.prerequisites} integration</span>
			</span>
			${renderIcon(symbol)}
		</div>
		<harness-issue-list
			.issues=${section.issues}
			.listClass=${listClass}
		></harness-issue-list>
		${when(
				!final,
				() => html`
				<p class="route-join">
					${renderIcon(GitMerge)}Both branches must integrate before ${section.nextReference}
				</p>
				`
			)}
		`;
	}

	protected override render() {
		const section = this.section;
		if (!section) return nothing;
		return choose(
			section.kind,
			[
				['current', () => this.renderCurrent(section)],
				['serial', () => this.renderSerial(section)],
			],
			() => this.renderBranches(section)
		);
	}
}

customElements.define('harness-route-section', HarnessRouteSection);

declare global {
	interface HTMLElementTagNameMap {
		'harness-route-section': HarnessRouteSection;
	}
	interface HTMLElementEventMap {
		'harness-route-toggle': CustomEvent<{ key: string; open: boolean }>;
	}
}
