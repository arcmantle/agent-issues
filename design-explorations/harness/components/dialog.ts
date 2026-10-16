import { html, nothing } from 'lit';
import { choose } from 'lit/directives/choose.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { ArrowLeft, ArrowUpRight, FolderOpen, Send, Terminal, X } from 'lucide';
import type { DialogState, FolderBrowser } from '../application-state.js';
import type { HarnessSimulation, ChangeRequest, Initiative } from '../simulation.js';
import { reference } from '../simulation.js';
import type { PlanningController } from '../planning.js';
import type { RepositoryModel } from './repository-header.js';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface DialogModel {
	state: DialogState | undefined;
	simulation: HarnessSimulation;
	planning: PlanningController;
	repository: RepositoryModel;
	initiative: Initiative | undefined;
	browsing: boolean;
	workerAnswerBlocked: boolean;
	request: ChangeRequest | undefined;
	requestDraft: string;
	requestTarget: number;
	folder: FolderBrowser;
}

export class HarnessWorkerQuestion extends LightElement {
	static override properties = {
		draft: { attribute: false },
		blocked: { attribute: false },
		controlId: { attribute: false },
	};
	constructor() {
		super();
		this.draft = '';
		this.blocked = false;
		this.controlId = 'inbox-answer';
	}
	declare draft: string;
	declare blocked: boolean;
	declare controlId: string;
	protected override render() {
		const inputId = this.controlId;
		return html`
		<article class="inbox-item agent-question">
			<div class="eyebrow muted">Worker 02 / DEMO-02</div>
			<h3>Usage limit</h3>
			<p>Should the limit apply across all workers?</p>
			<form data-form="answer">
				<label for=${inputId}>Your answer</label
				><textarea
					id=${inputId}
					name="answer"
					rows="3"
					.value=${live(this.draft)}
					?disabled=${this.blocked}
					required
				></textarea
				><button
					class="primary"
					?disabled=${this.blocked}
				>
					${renderIcon(Send)}Send answer
				</button>
			</form>
		</article>
		`;
	}
}
customElements.define('harness-worker-question', HarnessWorkerQuestion);

export class HarnessDialog extends LightElement {
	static override properties = {
		open: { attribute: false },
		model: { attribute: false },
		controlId: { attribute: false },
		label: { attribute: false },
	};

	constructor() {
		super();
		this.open = false;
		this.model = undefined;
		this.controlId = 'action-dialog';
		this.label = '';
	}

	declare open: boolean;
	declare model: DialogModel | undefined;
	declare controlId: string;
	declare label: string;

	protected override updated() {
		const dialog = this.querySelector('dialog')!;
		if (this.open && !dialog.open) dialog.showModal();
		if (!this.open && dialog.open) dialog.close();
	}

	protected handleClose() {
		this.dispatchEvent(
			new CustomEvent('harness-dialog-close', { bubbles: true, detail: { id: this.controlId } })
		);
	}

	protected renderRequestDialog() {
		const request = this.model!.request;
		if (!request)
			return html`
			<h2>Request change</h2>
			<form data-form="change-start">
				<label for="change-brief">Required change</label
				><textarea
					id="change-brief"
					name="change-brief"
					rows="5"
					.value=${live(this.model!.requestDraft)}
					required
				></textarea>
				<div class="dialog-actions">
					<button
						type="button"
						data-action="close-dialog"
					>
						Cancel</button
					><button class="primary">${renderIcon(Send)}Send request</button>
				</div>
			</form>
			`;
		const target = this.model!.simulation.workers.find(
			(worker) => worker.issue === reference(this.model!.requestTarget)
		);
		return html`
		<h2>Change request</h2>
		<p class="muted">${this.model!.repository!.name} / Coordinating agent</p>
		<div
			class="change-conversation"
			aria-label="Change conversation"
		>
			${repeat(
					request.messages,
					(_message, index) => index,
					(message) =>
						html`<div class="change-message">
						<strong>${message.role === 'user' ? 'You' : 'Coordinating agent'}</strong>
						<p>${message.text}</p>
					</div>`
				)}
		</div>
		${choose(
				request.status,
				[
					[
						'question',
						() =>
							html`
						<form data-form="change-answer">
							<label for="change-answer">Required result and acceptance criteria</label>
							<textarea
								id="change-answer"
								name="change-answer"
								rows="4"
								.value=${live(request.draft)}
								required
							></textarea>
							<div class="dialog-actions">
								<button
									type="button"
									data-action="close-dialog"
								>
									Close
								</button>
								<button
									class="primary"
									type="submit"
								>
									${renderIcon(Send)}Send answer
								</button>
							</div>
						</form>
						`,
					],
					[
						'proposal',
						() => html`
						<form data-form="change-approval">
							<label for="change-target-trigger">Related issue</label
							><harness-selector
								.controlId=${'change-target'}
								.name=${'target'}
								.label=${'Related issue'}
								.value=${String(this.model!.requestTarget)}
								.options=${this.model!.simulation.issues.flatMap((issue, index) =>
										index !== 5
											? [{ value: String(index), label: `${reference(index)} / ${issue.title}` }]
											: []
									)}
							></harness-selector>
							<div class="change-proposal-actions">
								<button
									class="primary"
									name="choice"
									value="followup"
								>
									Approve follow-up</button
								><button
									name="choice"
									value="revise"
									?disabled=${Boolean(target) ||
										this.model!.simulation.integrated.has(this.model!.requestTarget)}
								>
									Approve queued revision</button
								><button
									name="choice"
									value="pause"
								>
									Approve pause and follow-up
								</button>
							</div>
						</form>
						<div class="dialog-actions">
							<button data-action="decline-change">Decline</button
							><button data-action="separate-planning">Start separate planning</button>
						</div>
						`,
					],
				],
				() => html`<p class="status">${request.status}</p>`
			)}
		${when(request.status !== 'question', () => html`
		<div class="dialog-actions"><button data-action="close-dialog">Close</button></div>
		`)}
		`;
	}

	protected renderRecordDialog(recordKind: string, index: number) {
		const initiative = this.model!.initiative;
		if (recordKind !== 'issue' || this.model!.browsing) {
			const title =
				recordKind === 'issue'
					? initiative?.issues[index]
					: recordKind === 'prd'
						? this.model!.browsing
							? initiative?.prd
							: this.model!.simulation.prds[index]?.title
						: recordKind === 'story'
							? this.model!.browsing
								? initiative?.story
								: this.model!.simulation.prds[index]?.story
							: initiative?.adrs[index];
			return html`<div class="eyebrow muted">${recordKind} / simulated record</div>
			<h2>${title}</h2>
			<p>${initiative?.summary}</p>
			<div class="dialog-actions"><button data-action="close-dialog">Close</button></div>`;
		}
		const issue = this.model!.simulation.issues[index]!;
		const worker = this.model!.simulation.workers.find(
			(candidate) => candidate.issue === reference(index)
		);
		return html`
		<div class="eyebrow muted">
			${reference(index)} / ${this.model!.simulation.issueModel(index).status.label}
		</div>
		<h2>${issue.title}</h2>
		<section class="record-section">
			<h3>Outcome</h3>
			<p>${issue.outcome}</p>
			<h3>Acceptance criteria</h3>
			<ul>
				${repeat(
						issue.criteria,
						(criterion) => criterion,
						(criterion) => html`<li>${criterion}</li>`
					)}
			</ul>
		</section>
		<section class="record-section">
			<h3>Requirements</h3>
			${repeat(
					this.model!.simulation.issueModel(index).prds,
					(prd) => prd,
					(prd) =>
						html`<button
							class="record-link"
							data-action="record"
							data-kind="prd"
							data-index=${prd}
						>
							${this.model!.simulation.prds[prd]!.title}</button
						><span class="muted">${this.model!.simulation.prds[prd]!.story}</span>`
				)}${when(
					!this.model!.simulation.issueModel(index).prds.length,
					() => html`<p>No PRD link.</p>`
				)}
		</section>
		<section class="record-section">
			<h3>Dependencies</h3>
			${repeat(
					issue.dependencies,
					(dependency) => dependency,
					(dependency) =>
						html`<button
						class="record-link"
						data-action="record"
						data-kind="issue"
						data-index=${dependency}
					>
						${reference(dependency)} / ${this.model!.simulation.issues[dependency]!.title}
					</button>`
				)}
			<h3>Unblocks</h3>
			${repeat(
					this.model!.simulation.issues.flatMap((candidate, candidateIndex) =>
						candidate.dependencies.includes(index) ? [candidateIndex] : []
					),
					(candidate) => candidate,
					(candidate) =>
						html`<button
						class="record-link"
						data-action="record"
						data-kind="issue"
						data-index=${candidate}
					>
						${reference(candidate)} / ${this.model!.simulation.issues[candidate]!.title}
					</button>`
				)}
		</section>
		<section class="record-section">
			<h3>Validation evidence</h3>
			<p>${issue.evidence}</p>
			${when(worker, () => html`<p>Worker ${worker!.id} / Copilot / attempt ${worker!.id}.1</p>`)}
		</section>
		<div class="dialog-actions">
			<button data-action="close-dialog">Close</button>${when(
					worker,
					() =>
						html`<button
						class="primary"
						data-action="agent"
						data-id=${worker!.id}
					>
						${renderIcon(Terminal)}Show terminal
					</button>`
				)}
		</div>
		`;
	}

	protected renderFolderDialog() {
		return html`
		<h2>Open folder</h2>
		<form data-form="folder-path">
			<label for="folder-path">Folder path</label>
			<div class="folder-path-row">
				<input
					id="folder-path"
					name="path"
					.value=${live(this.model!.folder.path)}
					placeholder="Absolute folder path"
				/><button
					aria-label="Browse folder"
					title="Browse folder"
				>
					${renderIcon(ArrowUpRight)}
				</button>
			</div>
		</form>
		<div class="folder-navigation">
			<button
				data-action="folder-browse"
				data-path=""
				title="Home"
			>
				${renderIcon(FolderOpen)}Home</button
			>${when(
					this.model!.folder.parent,
					() =>
						html`<button
						data-action="folder-browse"
						data-path=${this.model!.folder.parent!}
					>
						${renderIcon(ArrowLeft)}Parent
					</button>`
				)}
		</div>
		<p
			class="folder-status"
			role="status"
		>
			${this.model!.folder.loading ? 'Loading folders...' : this.model!.folder.path}
		</p>
		<p
			class="folder-error"
			role="alert"
		>
			${this.model!.folder.error}
		</p>
		<div class="folder-list">
			${repeat(
					this.model!.folder.entries,
					(entry) => entry.path,
					(entry) =>
						html`<button
						data-action="folder-browse"
						data-path=${entry.path}
						?disabled=${this.model!.folder.loading}
					>
						${renderIcon(FolderOpen)}${entry.name}
					</button>`
				)}
		</div>
		<div class="dialog-actions">
			<button data-action="close-dialog">Cancel</button
			><button
				class="primary"
				data-action="folder-select"
				?disabled=${this.model!.folder.loading ||
					Boolean(this.model!.folder.error) ||
					!this.model!.folder.path}
			>
				${renderIcon(FolderOpen)}Open repository
			</button>
		</div>
		`;
	}

	protected renderDialog() {
		const dialog = this.model?.state;
		if (!dialog) return nothing;
		if (dialog.kind === 'request') return this.renderRequestDialog();
		if (dialog.kind === 'record') return this.renderRecordDialog(dialog.recordKind, dialog.index);
		if (dialog.kind === 'folder') return this.renderFolderDialog();
		if (dialog.kind === 'agent') {
			const worker = this.model!.simulation.workers.find(
				(candidate) => candidate.id === dialog.worker
			)!;
			return html`<div class="agent-overlay-heading">
				<strong>Worker ${worker.id} / ${worker.title}</strong
				><button
					class="icon-button"
					data-action="close-dialog"
					title="Close agent"
					aria-label="Close agent"
				>
					${renderIcon(X)}
				</button>
			</div>
			${when(worker.id === '02' && this.model!.simulation.question, () =>
					this.renderWorkerQuestion()
				)}
			${when(this.model!.simulation.reviewFeedbacks.some((feedback) => feedback.reference === worker.issue), () => html`
			<div
				class="change-conversation"
				aria-label="Review feedback"
			>
				${repeat(this.model!.simulation.reviewFeedbacks.filter((feedback) => feedback.reference === worker.issue),
					(feedback) => feedback.checkpoint,
					(feedback) => html`
					<div class="change-message">
						<strong>Review feedback / ${feedback.checkpoint}</strong>
						<p>${feedback.note}</p>
					</div>
					`)}
			</div>
			`)}
			<div class="terminal-header">
				<strong>Copilot / ${worker.issue}</strong><span>${worker.label}</span>
			</div>
			<div class="agent-session-mount"></div>
			<div class="terminal-footer">
				<span>${worker.manual ? 'Input: you' : 'Input: harness'}</span
				><button
					data-action="takeover"
					data-id=${worker.id}
				>
					${renderIcon(Terminal)}${worker.manual ? 'Return control' : 'Take control'}
				</button>
			</div>`;
		}
		if (dialog.kind === 'pioneer-ticket') {
			const context = this.model!.planning.current!;
			const ticket = context.model.tickets[dialog.index]!;
			return html`<div class="eyebrow muted">
				Pioneer ticket / ${ticket.type} / ${ticket.status}
			</div>
			<h2>${ticket.title}</h2>
			<section class="record-section">
				<h3>Question</h3>
				<p>${ticket.question}</p>
				<h3>Dependencies</h3>
				<p>
					${ticket.dependencies
							.map((dependency) => context.model.tickets[dependency]!.title)
							.join(' + ') || 'None'}
				</p>
				<h3>Recorded resolution</h3>
				<p>${context.resolutions[dialog.index] || 'Not resolved'}</p>
			</section>
			<button data-action="close-dialog">Close</button>`;
		}
		return html`<form data-form=${dialog.kind}>
		<h2>
			${dialog.kind === 'revision'
					? 'Request a revised resolution'
					: dialog.kind === 'merge-stop'
						? 'Stop merge agent?'
						: 'Terminate workers?'}
		</h2>
		${when(
				dialog.kind === 'revision',
				() =>
					html`<label for="revision-note">Revision request</label
					><textarea
						id="revision-note"
						name="note"
						rows="4"
						required
					></textarea>`,
				() => html`<p>Recorded changes remain available. No live process is affected.</p>`
			)}
		<div class="dialog-actions">
			<button
				type="button"
				data-action="close-dialog"
			>
				Cancel</button
			><button class="primary">${dialog.kind === 'revision' ? 'Send request' : 'Confirm'}</button>
		</div>
	</form>`;
	}

	protected renderWorkerQuestion() {
		return html`
		<harness-worker-question
			.draft=${this.model!.simulation.answerDraft}
			.blocked=${this.model!.workerAnswerBlocked}
			.controlId=${'agent-answer'}
		></harness-worker-question>
		`;
	}

	protected override render() {
		return html`
		<dialog
			id=${this.controlId}
			aria-label=${this.label}
			@close=${this.handleClose}
		>
			${this.renderDialog()}
		</dialog>
		`;
	}
}

customElements.define('harness-dialog', HarnessDialog);

declare global {
	interface HTMLElementTagNameMap {
		'harness-worker-question': HarnessWorkerQuestion;
		'harness-dialog': HarnessDialog;
	}
	interface HTMLElementEventMap {
		'harness-dialog-close': CustomEvent<{ id: string }>;
	}
}
