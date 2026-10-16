import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { live } from 'lit/directives/live.js';
import { when } from 'lit/directives/when.js';
import {
	Check,
	FileDiff,
	GitMerge,
	Keyboard,
	MessageSquare,
	Pause,
	Play,
	Send,
	Settings2,
	Square,
	Undo2,
} from 'lucide';
import { MergeController, mergeIssues, phaseActions, phaseLabels } from '../merge.js';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import './diff-view.js';
import './merge-files.js';
import './merge-requirements.js';
import './merge-checks.js';
import './activity-timeline.js';
import type { WorkContext } from './work-context.js';
import './work-context.js';

export class HarnessMergeWorkspace extends LightElement {
	static override properties = {
		controller: { attribute: false },
		allowed: { attribute: false },
		version: { attribute: false },
		context: { attribute: false },
	};

	constructor() {
		super();
		this.controller = undefined;
		this.allowed = true;
		this.version = 0;
		this.context = undefined;
	}

	declare controller: MergeController | undefined;
	declare allowed: boolean;
	declare version: number;
	declare context: WorkContext | undefined;

	protected override render() {
		const controller = this.controller;
		if (!controller) return nothing;
		const current = controller.current;
		const inspected = !['review', 'inspecting'].includes(current.phase);
		const files = controller.paths.map((path, index) => ({
			path,
			conflict: inspected && current.scenario !== 'clean' && index < 2,
			status: !inspected
				? 'Not inspected'
				: current.scenario !== 'clean' && index < 2
					? controller.resolution
						? 'Resolved'
						: 'Conflict'
					: 'Clean',
		}));
		const blocked =
			!this.allowed ||
			current.paused ||
			(controller.active !== -1 && controller.active !== controller.selected);
		return html`
		<div class="merge-session-header">
			<div class="work-heading">
				<span class="eyebrow muted">Merge / simulated</span>
				<harness-work-context
					.context=${this.context}
					.branch=${controller.issue.branch}
					.checkpoint=${controller.issue.checkpoint}
				></harness-work-context>
				<span class="phase-badge">${phaseLabels[current.phase]}</span>
			</div>
			<div class="merge-controls">
				<button
					class="icon-button"
					data-action="merge-pause"
					title=${current.paused ? 'Resume merge agent' : 'Pause merge agent'}
					aria-label=${current.paused ? 'Resume merge agent' : 'Pause merge agent'}
					?disabled=${current.phase === 'integrated'}
				>
					${renderIcon(current.paused ? Play : Pause)}
				</button>
				<button
					class="icon-button"
					data-action="merge-stop"
					title="Stop merge agent"
					aria-label="Stop merge agent"
					?disabled=${['review', 'integrated', 'stopped'].includes(current.phase)}
				>
					${renderIcon(Square)}
				</button>
				${when(
						phaseActions[current.phase],
						() =>
							html`<button
							class="primary"
							data-action="merge-advance"
							?disabled=${blocked}
						>
							${renderIcon(
									current.phase === 'review' || current.phase === 'resolution-review'
										? Check
										: GitMerge
								)}${phaseActions[current.phase]}
						</button>`
					)}
				<button
					class="icon-button"
					popovertarget="merge-scenario-menu"
					title="Simulation scenario"
					aria-label="Simulation scenario"
				>
					${renderIcon(Settings2)}
				</button>
				<div
					id="merge-scenario-menu"
					class="select-menu"
					popover="auto"
					role="group"
					aria-label="Simulation scenario"
				>
					${repeat(
							['conflict', 'clean', 'failed'],
							(scenario) => scenario,
							(scenario) =>
								html`<button
								data-action="merge-scenario"
								data-value=${scenario}
								aria-pressed=${String(current.scenario === scenario)}
							>
								${scenario}
							</button>`
						)}
				</div>
			</div>
		</div>
		<nav
			class="merge-issue-tabs"
			aria-label="Integration queue"
		>
			${repeat(
					controller.pending,
					(index) => index,
					(index) =>
						html`<button
						data-action="merge-issue"
						data-value=${index}
						aria-pressed=${String(controller.selected === index)}
					>
						${mergeIssues[index]!.reference}<span>${phaseLabels[controller.sessions[index]!.phase]}</span>
					</button>`
				)}
		</nav>
		<div
			class="merge-view-tabs"
			role="tablist"
			aria-label="Merge view"
		>
			<button
				id="merge-diffs-view"
				role="tab"
				data-action="merge-view"
				data-value="diffs"
				aria-selected=${String(current.view === 'diffs')}
				aria-controls="merge-diffs-panel"
				tabindex=${current.view === 'diffs' ? 0 : -1}
			>
				${renderIcon(FileDiff)}Diffs
			</button>
			<button
				id="merge-agent-view"
				role="tab"
				data-action="merge-view"
				data-value="agent"
				aria-selected=${String(current.view === 'agent')}
				aria-controls="merge-agent-panel"
				tabindex=${current.view === 'agent' ? 0 : -1}
			>
				${renderIcon(MessageSquare)}Merge agent
			</button>
		</div>
		<section
			id="merge-diffs-panel"
			class="merge-diffs-panel"
			role="tabpanel"
			aria-labelledby="merge-diffs-view"
			.hidden=${live(current.view !== 'diffs')}
		>
			<div class="merge-diff-workspace">
				<harness-merge-files
					.files=${files}
					.selected=${current.file}
				></harness-merge-files>
				<div
					class="comparison-toggle"
					role="group"
					aria-label="Diff comparison"
				>
					${repeat(
							['split', 'unified'],
							(comparison) => comparison,
							(comparison) =>
								html`<button
								data-action="comparison"
								data-value=${comparison}
								aria-pressed=${String(current.comparison === comparison)}
							>
								${comparison === 'split' ? 'Side by side' : 'Unified'}
							</button>`
						)}
				</div>
				${when(
						inspected && current.scenario !== 'clean' && current.file < 2,
						() => html`
						<details class="conflict-hunk">
							<summary>Original Git conflict / overlapping block</summary>
							<pre>
${`<<<<<<< harness/initiative\n${controller.branchCode('target')}\n=======\n${controller.branchCode('source')}\n>>>>>>> ${controller.issue.branch}`}</pre
							>
						</details>
						`
					)}
				<harness-diff-view
					.beforeCode=${controller.branchCode('target')}
					.afterCode=${controller.branchCode(controller.resolution ? 'result' : 'source')}
					.comparison=${current.comparison}
					.file=${controller.paths[current.file]!}
				></harness-diff-view>
			</div>
			<aside class="merge-evidence">
				<harness-merge-requirements
					.model=${controller.requirements}
				></harness-merge-requirements>
				<harness-merge-checks .model=${controller.checks}></harness-merge-checks>
				${when(
						current.phase === 'resolution-review',
						() =>
							html`<button
							data-action="merge-revision"
							?disabled=${blocked}
						>
							${renderIcon(MessageSquare)}Request a revised resolution
						</button>`
					)}
				<harness-activity-timeline .entries=${[...current.events]}></harness-activity-timeline>
			</aside>
		</section>
		<section
			id="merge-agent-panel"
			class="merge-agent-panel"
			role="tabpanel"
			aria-labelledby="merge-agent-view"
			.hidden=${live(current.view !== 'agent')}
		>
			<div class="terminal-header">
				<strong>Merge agent / Copilot</strong><span>${phaseLabels[current.phase]}</span>
			</div>
			${repeat(
					controller.sessions,
					(_session, index) => index,
					(_session, index) => html`
					<div
						class="merge-terminal-host terminal-host"
						data-terminal=${`merge-${index}`}
						.hidden=${live(index !== controller.selected)}
					></div>
					`
				)}
			<div class="terminal-footer">
				<span>${current.manual ? 'Input: you' : 'Input: harness'}</span
				><button data-action="merge-control">
					${renderIcon(current.manual ? Undo2 : Keyboard)}${current.manual
							? 'Return control'
							: 'Take control'}
				</button>
			</div>
			<ol
				class="merge-conversation"
				aria-label="Merge conversation"
			>
				${repeat(
						current.messages,
						(_message, index) => index,
						(message) =>
							html`<li class=${`message ${message.role}`}>
							<strong>${message.role === 'agent' ? 'Merge agent' : 'You'}</strong>
							<p>${message.text}</p>
						</li>`
					)}
			</ol>
			<form data-form="merge-message">
				<label for="merge-message">Message to merge agent</label
				><textarea
					id="merge-message"
					name="message"
					rows="2"
					.value=${live(current.draft)}
					required
				></textarea
				><button
					class="primary"
					?disabled=${blocked}
				>
					${renderIcon(Send)}Send
				</button>
			</form>
		</section>
		`;
	}
}

customElements.define('harness-merge-workspace', HarnessMergeWorkspace);

declare global {
	interface HTMLElementTagNameMap {
		'harness-merge-workspace': HarnessMergeWorkspace;
	}
}
