import { html } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { when } from 'lit/directives/when.js';
import {
	ArrowUpRight,
	FileDiff,
	FolderGit2,
	FolderOpen,
	Inbox,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightClose,
	PanelRightOpen,
	Moon,
	Plus,
	RotateCcw,
	Search,
	Send,
	Sun,
	X,
} from 'lucide';
import './components/elements.js';
import './components/settings-page.js';
import './components/review-checkpoint.js';
import './components/merge-workspace.js';
import './components/dialog.js';
import { HarnessApplicationState } from './application-state.js';
import { reference, initiatives } from './simulation.js';
import { mergeIssues } from './merge.js';
import { renderIcon } from './components/render-icon.js';

export class HarnessApplication extends HarnessApplicationState {
	protected renderInbox() {
		const title = this.inboxTab === 'agent' ? 'Run agent' : 'Run inbox';
		const requests = this.simulation.requests.filter((request) =>
			['question', 'proposal'].includes(request.status)
		);
		return html`
		<div class="panel-title">
			<h2>
				${title}
				<span
					class="count"
					.hidden=${live(this.inboxTab === 'agent')}
					>${requests.length +
						Number(this.simulation.question) +
						this.pendingReviews.length + this.merge.pending.length}</span
				>
			</h2>
			<button
				class="icon-button inbox-close"
				data-action="inbox-toggle"
				title=${`Close ${title.toLowerCase()}`}
				aria-label=${`Close ${title.toLowerCase()}`}
			>
				${renderIcon(X)}
			</button>
		</div>
		<div
			class="tabs"
			role="tablist"
			aria-label="Run decisions"
		>
			${repeat(
					['inbox', 'agent', 'activity'],
					(tab) => tab,
					(tab) =>
						html`<button
						role="tab"
						data-action="inbox-tab"
						data-tab=${tab}
						aria-selected=${String(this.inboxTab === tab)}
						tabindex=${this.inboxTab === tab ? 0 : -1}
					>
						${{ inbox: 'Inbox', agent: 'Run agent', activity: 'Activity' }[tab]}
					</button>`
				)}
		</div>
		${this.renderRunAgent()}
		<section .hidden=${live(this.inboxTab === 'agent')}>
			${when(
					this.inboxTab === 'activity',
					() =>
						html`${repeat(
							this.simulation.activity,
							(_entry, index) => index,
							(entry, index) =>
								html`<div class="activity-entry">
								<span class="mono muted">${index === 0 ? 'now' : `-${index}m`}</span
								><span>${entry}</span>
							</div>`
						)}`,
					() => html`
					${repeat(
							requests,
							(request) => request.id,
							(request) =>
								html`<article class="inbox-item">
								<h3>
									${request.status === 'question' ? 'Change question' : 'Proposal needs approval'}
								</h3>
								<p>${request.brief}</p>
								<button
									data-action="open-change"
									data-id=${request.id}
								>
									${renderIcon(Inbox)}Open conversation
								</button>
							</article>`
						)}
					${when(this.simulation.question, () => this.renderWorkerQuestion())}
					${when(this.pendingReviews.length, () => html`
					<article class="inbox-item">
						<h3>Review ready</h3>
						<p>${mergeIssues[this.pendingReviews[0]!]!.reference} / Validation and independent review passed.</p>
						<button data-action="open-review">${renderIcon(FileDiff)}Open review</button>
					</article>
					`)}
					${when(this.merge.pending.length, () => html`
					<article class="inbox-item">
						<h3>Merge pending</h3>
						<p>Reviewed work is waiting for integration.</p>
						<button
							data-action="workspace-view"
							data-view="merge"
						>
							${renderIcon(FolderGit2)}Open merge
						</button>
					</article>
					`)}
					${when(this.simulation.integrated.has(2), () => html`
					<article class="inbox-item">
						<h3>Integration recorded</h3>
						<p>DEMO-03 / simulated integration complete.</p>
					</article>
					`)}
					`
				)}
		</section>
		`;
	}

	protected renderRunAgent() {
		const stopped = this.simulation.mode === 'stopped';
		return html`
		<section
			class="run-agent"
			aria-label="Run agent conversation"
			.hidden=${live(this.inboxTab !== 'agent')}
		>
			<div class="run-agent-status">
				<span class="mono muted">Run 004 / Simulated</span>
				<strong role="status">${this.runAgentStatus}</strong>
			</div>
			<details class="run-agent-events">
				<summary>Run activity / ${this.simulation.activity.length}</summary>
				<ol>
					${repeat(this.simulation.activity, (_entry, index) => index, (entry) => html`
					<li>${entry}</li>
					`)}
				</ol>
			</details>
			<ol
				class="run-agent-messages"
				role="log"
				aria-label="Run conversation"
				aria-live="polite"
			>
				${repeat(this.simulation.runAgentMessages, (_message, index) => index, (message) => html`
				<li class=${`run-agent-message ${message.role}`}>
					<strong>${message.role === 'agent' ? 'Run agent' : 'You'}</strong>
					<p>${message.text}</p>
				</li>
				`)}
			</ol>
			<div class="run-agent-links">
				${when(this.simulation.question, () => html`
				<button
					data-action="answer-agent"
					data-id="02"
					data-focus-return="run-agent"
				>
					${renderIcon(ArrowUpRight)}Answer Worker 02
				</button>
				`)}
				${when(this.pendingReviews.length, () => html`
				<button
					data-action="open-review"
					data-reference=${mergeIssues[this.pendingReviews[0]!]!.reference}
				>
					${renderIcon(FileDiff)}Review ${mergeIssues[this.pendingReviews[0]!]!.reference}
				</button>
				`)}
			</div>
			<form
				class="run-agent-composer"
				data-form="run-agent"
			>
				<label for="run-agent-message">Message to run agent</label>
				<textarea
					id="run-agent-message"
					name="run-agent-message"
					rows="3"
					.value=${live(this.simulation.runAgentDraft)}
					?disabled=${stopped}
					required
				></textarea>
				<button
					class="primary"
					type="submit"
					?disabled=${stopped}
				>
					${renderIcon(Send)}Send message
				</button>
			</form>
		</section>
		`;
	}

	protected renderWorkerQuestion() {
		return html`
		<harness-worker-question
			.draft=${this.simulation.answerDraft}
			.blocked=${this.workerAnswerBlocked}
			.controlId=${'inbox-answer'}
		></harness-worker-question>
		`;
	}

	protected renderChangeHistory() {
		return html`
		${when(
				this.simulation.requests.length,
				() => html`
				<section class="change-request-history">
					<h2>Change requests</h2>
					${repeat(
							this.simulation.requests,
							(request) => request.id,
							(request) =>
								html`<div class="change-request-row">
								<button
									data-action="open-change"
									data-id=${request.id}
								>
									<strong>${request.brief}</strong
									><span
										>${request.status}${when(
												request.issue !== undefined,
												() => ` / ${reference(request.issue!)}`
											)}</span
									></button
								>${when(
										request.pausedWorkers.length,
										() =>
											html`<button
											data-action="resume-affected"
											data-id=${request.id}
											?disabled=${this.simulation.mode !== 'running'}
										>
											Resume affected work
										</button>`
									)}
							</div>`
						)}
				</section>
				`
			)}
		`;
	}

	protected renderRepositories() {
		const matches = Object.entries(this.repositories).filter((entry) =>
			[entry[1].name, entry[1].path, entry[1].projectIdentity, entry[1].tenant]
				.join(' ')
				.toLowerCase()
				.includes(this.repositoryQuery.toLowerCase().trim())
		);
		return html`
		<header class="page-heading">
			<h1>Repositories</h1>
			<button
				class="primary"
				data-action="open-folder"
			>
				${renderIcon(FolderOpen)}Open folder
			</button>
		</header>
		<div class="repositories-content">
			<div class="repository-search">
				<label for="repository-search">Search repositories</label>
				<div>
					${renderIcon(Search)}<input
						id="repository-search"
						type="search"
						.value=${live(this.repositoryQuery)}
						placeholder="Name, project, or path"
					/>
				</div>
			</div>
			<div class="repository-list-heading">
				<h2>Configured repositories</h2>
				<span class="muted">${matches.length} / ${Object.keys(this.repositories).length}</span>
			</div>
			<ul class="repository-list">
				${repeat(
						matches,
						(entry) => entry[0],
						([id, repository]) => html`
						<li class="repository-row">
							<div class="repository-name">
								${renderIcon(FolderGit2)}
								<div>
									<h3>${repository.name}</h3>
									<p class="mono muted">${repository.path}</p>
									${when(
											id === this.repository,
											() => html`<span class="repository-current">Selected</span>`
										)}
								</div>
							</div>
							<div class="repository-identity">
								<span class="eyebrow muted">Agent Issues project</span
								><strong>${repository.projectIdentity || 'Not connected'}</strong
								><span class="muted">${repository.tenant}</span>
							</div>
							<div class="repository-run">
								<span class="status"
									>${id === 'agent-issues' ? this.runLabel : 'No active run'}</span
								><span class="muted">${repository.initiatives.length} initiatives</span>
							</div>
							<button
								data-action="repository-open"
								data-id=${id}
								aria-label=${`Open ${repository.name}`}
							>
								${renderIcon(ArrowUpRight)}Open
							</button>
						</li>
						`
					)}
			</ul>
			${when(
					!matches.length,
					() => html`<div class="repository-empty"><h3>No repositories found</h3></div>`
				)}
		</div>
		`;
	}

	protected override render() {
		const currentPlanning = this.planning.current;
		const run = initiatives[this.initiative];
		const sidebar = ['workspace', 'planning', 'project-settings'].includes(this.page);
		return html`
		<div
			class="review-layout"
			data-page=${this.page}
			data-sidebar=${String(sidebar && this.drawerOpen)}
			data-drawer=${String(this.drawerOpen)}
			@click=${this.handleClick}
			@input=${this.handleInput}
			@change=${this.handleChange}
			@submit=${this.handleSubmit}
			@harness-review-feedback=${this.handleReviewFeedback}
			@keydown=${this.handleKeydown}
			@harness-settings-saved=${this.handleSettingsSaved}
		>
			<harness-application-navigation
				class="application-navigation"
				.page=${this.page}
			></harness-application-navigation>
			<div class="navigation-tools">
				<button
					class="icon-button"
					data-action="theme"
					title=${this.terminals.dark ? 'Use light theme' : 'Use dark theme'}
					aria-label=${this.terminals.dark ? 'Use light theme' : 'Use dark theme'}
				>
					${renderIcon(this.terminals.dark ? Sun : Moon)}</button
				><button
					class="icon-button"
					data-action="reset"
					title="Reset simulation"
					aria-label="Reset simulation"
				>
					${renderIcon(RotateCcw)}
				</button>
			</div>
			<div
				id="navigation-drawer"
				class="navigation-drawer"
				.hidden=${live(!sidebar || !this.drawerOpen)}
			>
				<div class="tablet-drawer-header">
					<strong>Navigation</strong
					><button
						class="icon-button"
						data-action="drawer"
						aria-controls="navigation-drawer"
						aria-expanded="true"
						title="Hide navigation"
						aria-label="Hide navigation"
					>
						${renderIcon(PanelLeftClose)}
					</button>
				</div>
				<harness-repository-sidebar
					class="rail"
					role="complementary"
					aria-label="Repository"
					.model=${this.sidebarModel()}
				></harness-repository-sidebar>
			</div>
			${when(
					this.drawerOpen,
					() =>
						html`<button
						class="drawer-backdrop"
						data-action="drawer"
						aria-label="Close navigation"
					></button>`
				)}
			<main class="application-content">
				<div class="application-toolbar">
					<button
						class="icon-button"
						data-action="drawer"
						aria-controls="navigation-drawer"
						aria-expanded=${String(this.drawerOpen)}
						title=${this.drawerOpen ? 'Hide navigation' : 'Show navigation'}
						aria-label=${this.drawerOpen ? 'Hide navigation' : 'Show navigation'}
						.hidden=${live(!sidebar || this.drawerOpen)}
					>
						${renderIcon(this.drawerOpen ? PanelLeftClose : PanelLeftOpen)}</button
					>${when(
							this.page === 'workspace' && !this.browsing,
							() =>
								html`<button
								class="icon-button"
								data-action="inbox-toggle"
								aria-controls="run-inbox"
								aria-expanded=${String(this.inboxOpen)}
								title=${this.inboxOpen ? 'Hide run panel' : 'Show run panel'}
								aria-label=${this.inboxOpen ? 'Hide run panel' : 'Show run panel'}
							>
								${renderIcon(this.inboxOpen ? PanelRightClose : PanelRightOpen)}
							</button>`
						)}
				</div>
				<section
					class="workspace execution-page"
					data-page-panel="workspace"
					.hidden=${live(this.page !== 'workspace')}
				>
					<harness-run-header
						.model=${{
								title: run?.title ?? this.repositories[this.repository]!.name,
								brand: false,
								browsing: this.browsing,
								mode: this.simulation.mode,
								label: this.runLabel,
								agentStatus: this.runAgentStatus,
							}}
					></harness-run-header>
					<div
						class="workspace-body"
						data-inbox=${String(this.inboxOpen)}
						data-resizing=${String(Boolean(this.runPanelDrag))}
						style=${styleMap({ '--run-panel-width': `${this.runPanelSize}px` })}
						.hidden=${live(this.browsing)}
					>
						<section class="workspace-views">
							<harness-view-tabs
								class="workspace-tabs"
								role="tablist"
								aria-label="Workspace view"
								.selected=${this.view}
								.reviewCount=${this.pendingReviews.length}
								.mergeCount=${this.merge.pending.length}
							></harness-view-tabs>
							<section
								id="initiative-panel"
								role="tabpanel"
								aria-labelledby="initiative-tab"
								data-workspace-panel="initiative"
								.hidden=${live(this.view !== 'initiative')}
							>
								<harness-initiative-route
									.model=${this.simulation.routeModel}
								></harness-initiative-route
								>${this.renderChangeHistory()}
							</section>
							<section
								id="review-panel"
								role="tabpanel"
								aria-labelledby="review-tab"
								data-workspace-panel="review"
								.hidden=${live(this.view !== 'review')}
							>
								${when(this.pendingReviews.length, () => html`
								<harness-review-checkpoint
									.allowed=${this.reviewAllowed}
									.reference=${mergeIssues[this.currentReview!]!.reference}
									.checkpoint=${this.reviewCheckpoint(this.currentReview!)}
									.branch=${mergeIssues[this.currentReview!]!.branch}
									.context=${this.simulation.workContext(mergeIssues[this.currentReview!]!.reference)}
								></harness-review-checkpoint>
								`, () => html`
								<div
									class="workspace-empty"
									data-empty="review"
								>
									${renderIcon(FileDiff)}
									${when(this.reviewWorker, () => html`
									<h2>Changes requested / ${this.reviewWorker!.issue}</h2>
									<button
										data-action="agent"
										data-id=${this.reviewWorker!.id}
									>
										${renderIcon(ArrowUpRight)}Open agent
									</button>
									`, () => html`<h2>No work waiting for review</h2>`)}
								</div>
								`)}
							</section>
							<section
								id="initiative-merge-panel"
								role="tabpanel"
								aria-labelledby="merge-tab"
								data-workspace-panel="merge"
								.hidden=${live(this.view !== 'merge')}
							>
								${when(this.merge.pending.length, () => html`
								<harness-merge-workspace
									.controller=${this.merge}
									.context=${this.simulation.workContext(this.merge.issue.reference)}
									.allowed=${this.mergeAllowed}
									.version=${this.version}
								></harness-merge-workspace>
								`, () => html`
								<div
									class="workspace-empty"
									data-empty="merge"
								>
									${renderIcon(FolderGit2)}
									<h2>No work waiting for merge</h2>
								</div>
								`)}
							</section>
						</section>
						<div
							class="run-panel-resizer"
							role="separator"
							tabindex="0"
							aria-label="Resize run panel"
							aria-orientation="vertical"
							aria-controls="run-inbox"
							aria-valuemin="280"
							aria-valuemax=${this.runPanelMaxWidth}
							aria-valuenow=${this.runPanelSize}
							title="Resize run panel"
							.hidden=${live(!this.inboxOpen)}
							@pointerdown=${this.handleRunPanelPointerDown}
							@pointermove=${this.handleRunPanelPointerMove}
							@pointerup=${this.handleRunPanelPointerEnd}
							@pointercancel=${this.handleRunPanelPointerEnd}
							@lostpointercapture=${this.handleRunPanelPointerEnd}
							@keydown=${this.handleRunPanelKeydown}
							@dblclick=${this.handleRunPanelReset}
						></div>
						<aside
							id="run-inbox"
							class="run-inbox"
							aria-label=${this.inboxTab === 'agent' ? 'Run agent' : 'Run inbox'}
							data-panel=${this.inboxTab}
							data-open=${String(this.inboxOpen)}
							.hidden=${live(!this.inboxOpen)}
						>
							${this.renderInbox()}
						</aside>
					</div>
					${when(
							this.browsing,
							() =>
								html`<section class="initiative-overview">
								<h2>${run?.prd ?? 'No initiatives'}</h2>
								<p>${run?.summary}</p>
								${repeat(
										run?.issues ?? [],
										(_issue, index) => index,
										(issue, index) =>
											html`<button
											class="tracked-record"
											data-action="record"
											data-kind="issue"
											data-index=${index}
										>
											${issue}<small>Ready</small>
										</button>`
									)}<button
									data-action="page"
									data-page="planning"
								>
									Start planning
								</button>
							</section>`
						)}
				</section>
				<section
					class="workspace planning-page"
					data-page-panel="planning"
					.hidden=${live(this.page !== 'planning')}
				>
					<header class="page-heading">
						<h1>Planning</h1>
						<button
							class="primary"
							data-action="new-planning-session"
						>
							${renderIcon(Plus)}New session
						</button>
					</header>
					<div id="planning-workspace-content">
						${when(
								currentPlanning?.repository === this.repository,
								() =>
									html`<harness-planning-workspace
									.model=${{ ...currentPlanning!.model }}
								></harness-planning-workspace>`,
								() =>
									html`<section class="planning-start">
									<h2>New planning session</h2>
									<harness-planning-start
										.model=${{
												repository: this.repository,
												draft: { ...this.planning.launch },
												initiatives: this.repositories[this.repository]!.initiatives.map((id) => ({
													id,
													title: initiatives[id]!.title,
												})),
											}}
									></harness-planning-start>
								</section>`
							)}
					</div>
				</section>
				<section
					class="workspace repositories-page"
					data-page-panel="repositories"
					.hidden=${live(this.page !== 'repositories')}
				>
					${this.renderRepositories()}
				</section>
				<section
					class="workspace settings-page"
					data-page-panel="global-settings"
					.hidden=${live(this.page !== 'global-settings')}
				>
					<harness-settings-page
						.controller=${this.settings}
						.repository=${this.repository}
						.scope=${'global'}
					></harness-settings-page>
				</section>
				<section
					class="workspace settings-page"
					data-page-panel="project-settings"
					.hidden=${live(this.page !== 'project-settings')}
				>
					<harness-settings-page
						.controller=${this.settings}
						.repository=${this.repository}
						.scope=${'project'}
					></harness-settings-page>
				</section>
			</main>
			<div
				class="retained-terminals"
				hidden
			>
				<harness-terminal-grid
					.workers=${this.simulation.workers.map((worker) => ({ ...worker }))}
				></harness-terminal-grid>
			</div>
			<harness-dialog
				.open=${Boolean(this.dialog)}
				.model=${{
						state: this.dialog,
						simulation: this.simulation,
						planning: this.planning,
						repository: this.repositories[this.repository]!,
						initiative: initiatives[this.initiative],
						browsing: this.browsing,
						workerAnswerBlocked: this.workerAnswerBlocked,
						request: this.currentRequest(),
						requestDraft: this.requestDraft,
						requestTarget: this.requestTarget,
						folder: this.folder,
					}}
				.label=${this.dialog?.kind ?? ''}
				@harness-dialog-close=${this.handleDialogClose}
			></harness-dialog>
			<div
				class="toast"
				role="status"
				aria-live="polite"
			>
				${this.toast}
			</div>
		</div>
		`;
	}
}

customElements.define('harness-application', HarnessApplication);

declare global {
	interface HTMLElementTagNameMap {
		'harness-application': HarnessApplication;
	}
}
