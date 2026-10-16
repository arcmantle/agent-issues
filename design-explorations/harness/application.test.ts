import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessApplication } from './application.js';
import { LightElement } from './components/light-element.js';
import { MergeController } from './merge.js';
import { TerminalManager } from './terminals.js';

let application: HarnessApplication | undefined;

const showPopoverDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover');

beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: vi.fn() });
});

afterAll(() => {
	if (showPopoverDescriptor)
		Object.defineProperty(HTMLElement.prototype, 'showPopover', showPopoverDescriptor);
	else delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
});

afterEach(() => {
	application?.remove();
	application = undefined;
});

async function settle() {
	await application!.updateComplete;
	for (let cycle = 0; cycle < 4; cycle++)
		await Promise.all(
			[...application!.querySelectorAll('*')]
				.filter((element): element is LightElement => element instanceof LightElement)
				.map((element) => element.updateComplete)
		);
}

async function mount(page = 'workspace') {
	history.replaceState(null, '', `/?page=${page}`);
	application = new HarnessApplication();
	document.body.append(application);
	await settle();
	return application;
}

async function click(selector: string) {
	application!.querySelector<HTMLElement>(selector)!.click();
	await settle();
}

async function highlightLine(line: number) {
	window.getSelection()?.removeAllRanges();
	application!.querySelector(`[data-diff-line="${line}"] code`)!.dispatchEvent(
		new MouseEvent('mouseup', { bubbles: true })
	);
	await settle();
}

function fill(selector: string, value: string) {
	const input = application!.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(selector: string) {
	const form = application!.querySelector<HTMLFormElement>(selector)!;
	form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
	await settle();
}

describe('Single-document Harness', () => {
	it('keeps terminal input separate and disposes a replaced Merge session', () => {
		const previousTerminal = window.Terminal;
		const previousAddon = window.FitAddon;
		class TestTerminal {
			static instances: TestTerminal[] = [];
			constructor(options: ConstructorParameters<NonNullable<typeof window.Terminal>>[0]) {
				this.options = options;
				TestTerminal.instances.push(this);
			}
			options: ConstructorParameters<NonNullable<typeof window.Terminal>>[0];
			disposed = false;
			input: (data: string) => void = () => {};
			loadAddon() {}
			open() {}
			write() {}
			writeln() {}
			focus() {}
			dispose() {
				this.disposed = true;
			}
			onData(handler: (data: string) => void) {
				this.input = handler;
				return { dispose() {} };
			}
		}
		window.Terminal = TestTerminal;
		window.FitAddon = {
			FitAddon: class {
				fit() {}
			},
		};
		const manager = new TerminalManager();
		const controller = new MergeController();
		const session = controller.current;
		const host = document.createElement('div');
		try {
			session.manual = true;
			session.draft = 'Conversation draft';
			manager.syncMerge(session, host);
			TestTerminal.instances[0]!.input('Terminal draft');
			expect(session.draft).toBe('Conversation draft');
			manager.syncMerge(session, host);
			expect(TestTerminal.instances).toHaveLength(1);
			manager.discardMerge(session);
			expect(TestTerminal.instances[0]!.disposed).toBe(true);
			manager.syncMerge(controller.newSession(), host);
			expect(TestTerminal.instances).toHaveLength(2);
		} finally {
			manager.dispose();
			window.Terminal = previousTerminal;
			window.FitAddon = previousAddon;
		}
	});
	it('uses light DOM and retains the route, Review navigator, and terminal hosts', async () => {
		const app = await mount();
		expect(app.shadowRoot).toBeNull();
		expect(app.querySelectorAll('iframe')).toHaveLength(0);
		expect(app.querySelectorAll('harness-issue-card')).toHaveLength(42);
		expect(app.querySelectorAll('.terminal-grid [data-terminal]')).toHaveLength(3);
		const host = app.querySelector('[data-terminal="01"]');
		await click('#review-tab');
		expect(app.querySelectorAll('.checkpoint-file')).toHaveLength(50);
		expect(app.querySelector('.checkpoint-diff')!.textContent).toContain('mergeApproved');
		await click('harness-review-checkpoint [data-direction="next"]');
		expect(app.querySelector('.checkpoint-diff')!.textContent).toContain(
			'changed revision requires approval'
		);
		expect(app.querySelector('[data-terminal="01"]')).toBe(host);
		await click('#merge-tab');
		expect(app.querySelector('[data-empty="merge"]')).not.toBeNull();
	});

	it('collapses navigation from inside the sidebar and returns focus to the visible control', async () => {
		const app = await mount();
		const drawer = app.querySelector<HTMLElement>('#navigation-drawer')!;
		const reopen = app.querySelector<HTMLElement>('.application-toolbar [data-action="drawer"]')!;
		const collapse = drawer.querySelector<HTMLElement>('[data-action="drawer"]')!;
		if (drawer.hidden) await click('.application-toolbar [data-action="drawer"]');
		expect(reopen.hidden).toBe(true);
		await click('#navigation-drawer [data-action="drawer"]');
		expect(drawer.hidden).toBe(true);
		expect(document.activeElement).toBe(reopen);
		await click('.application-toolbar [data-action="drawer"]');
		expect(drawer.hidden).toBe(false);
		expect(reopen.hidden).toBe(true);
		expect(document.activeElement).toBe(collapse);
		collapse.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		expect(drawer.hidden).toBe(true);
		expect(document.activeElement).toBe(reopen);
	});

	it('closes project settings without saving or losing its draft', async () => {
		const app = await mount('project-settings');
		const settings = [...app.querySelectorAll('harness-settings-page')].find(page => page.scope === 'project')!;
		settings.querySelector<HTMLInputElement>('[name="override-budget"]')!.click();
		await settle();
		fill('#project-budget', '75');
		await settle();
		settings.querySelector<HTMLElement>('[aria-label="Close settings"]')!.click();
		await settle();
		expect(location.search).toBe('?page=workspace');
		expect(document.activeElement).toBe(app.querySelector('[data-page-panel="workspace"] [role="tab"][aria-selected="true"]'));
		await click('[data-page="project-settings"]');
		expect(settings.querySelector<HTMLInputElement>('#project-budget')!.value).toBe('75');
		expect(settings.controller!.effective('agent-issues').budget).toBe(50);
	});

	it('resizes the run panel once per frame without rendering the workspace during drag', async () => {
		const app = await mount();
		await click('[data-action="run-agent"]');
		fill('#run-agent-message', 'Keep this draft.');
		await settle();
		const handle = app.querySelector<HTMLElement>('.run-panel-resizer')!;
		Object.defineProperties(handle, {
			setPointerCapture: { value: vi.fn() },
			hasPointerCapture: { value: () => true },
			releasePointerCapture: { value: vi.fn() },
		});
		const pointer = (type: string, clientX: number) => handle.dispatchEvent(new PointerEvent(type, {
			pointerId: 7, isPrimary: true, button: 0, clientX,
		}));
		const frames: FrameRequestCallback[] = [];
		const animation = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
			frames.push(callback);
			return frames.length;
		});
		const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
		const updates = vi.spyOn(app, 'requestUpdate');
		try {
			pointer('pointerdown', 800);
			await settle();
			updates.mockClear();
			pointer('pointermove', 760);
			pointer('pointermove', 720);
			expect(frames).toHaveLength(1);
			frames[0]!(performance.now());
			expect(updates).not.toHaveBeenCalled();
			expect(app.querySelector<HTMLElement>('.workspace-body')!.style.getPropertyValue('--run-panel-width')).toBe('380px');
			expect(handle.getAttribute('aria-valuenow')).toBe('380');
			pointer('pointermove', 800);
			pointer('pointerup', 800);
			await settle();
			expect(cancel).toHaveBeenCalledWith(2);
			expect(updates).toHaveBeenCalledTimes(1);
			expect(app.querySelector<HTMLElement>('.workspace-body')!.style.getPropertyValue('--run-panel-width')).toBe('300px');
			expect(handle.getAttribute('aria-valuenow')).toBe('300');
			expect(app.querySelector<HTMLTextAreaElement>('#run-agent-message')!.value).toBe('Keep this draft.');
		} finally {
			animation.mockRestore();
			cancel.mockRestore();
			updates.mockRestore();
		}
	});

	it('opens the required answer or review directly from its initiative card', async () => {
		const app = await mount();
		app.querySelector<HTMLElement>('[aria-label="Answer agent for DEMO-02"]')!.focus();
		await click('[aria-label="Answer agent for DEMO-02"]');
		expect(app.querySelector('dialog .agent-overlay-heading')?.textContent).toContain('Worker 02');
		expect(document.activeElement).toBe(app.querySelector('#agent-answer'));
		fill('#agent-answer', 'Use the shared provider limit.');
		await submit('dialog [data-form="answer"]');
		await click('dialog [data-action="close-dialog"]');
		expect(app.querySelector('[aria-label="Answer agent for DEMO-02"]')).toBeNull();
		expect(document.activeElement).toBe(app.querySelector('.route-issue[data-index="1"]'));
		await click('[aria-label="Review DEMO-03"]');
		expect(app.querySelector('#review-tab')?.getAttribute('aria-selected')).toBe('true');
		expect(app.querySelector('harness-review-checkpoint harness-work-context')?.textContent).toContain('DEMO-03');
		expect(app.querySelector('dialog[open]')).toBeNull();
		expect(document.activeElement).toBe(app.querySelector('[data-review-note]'));
		await click('[data-action="approve"]');
		expect(app.querySelector('[aria-label="Review DEMO-03"]')).toBeNull();
		expect(app.querySelector('#merge-tab')?.textContent).toContain('1');
	});

	it('expands and collapses all Review folders without losing search or file selection', async () => {
		const app = await mount();
		await click('#review-tab');
		const folders = () => [...app.querySelectorAll<HTMLDetailsElement>('.checkpoint-folder')];
		const selectedDiff = app.querySelector('.checkpoint-diff')!.textContent;
		expect(app.querySelector('[aria-label="Collapse all folders"]')).not.toBeNull();
		await click('[aria-label="Collapse all folders"]');
		expect(folders().every((folder) => !folder.open)).toBe(true);
		fill('#checkpoint-search', 'src/runner/recovery');
		await settle();
		expect(app.querySelectorAll('.checkpoint-file')).toHaveLength(1);
		expect(folders().every((folder) => !folder.open)).toBe(true);
		await click('[aria-label="Expand all folders"]');
		expect(folders().every((folder) => folder.open)).toBe(true);
		await click('[aria-label="Clear file search"]');
		expect(app.querySelectorAll('.checkpoint-file')).toHaveLength(50);
		expect(folders().every((folder) => folder.open)).toBe(true);
		const runner = app.querySelector<HTMLDetailsElement>('[data-folder="src/runner"]')!;
		runner.open = false;
		await click('harness-review-checkpoint [data-direction="next"]');
		expect(runner.open).toBe(false);
		await click('[aria-label="Collapse all folders"]');
		expect(folders().every((folder) => !folder.open)).toBe(true);
		expect(app.querySelector('.checkpoint-file.active')!.getAttribute('aria-label')).toBe(
			'src/runner/checkpoint.ts'
		);
		expect(app.querySelector('.checkpoint-diff')!.textContent).not.toBe(selectedDiff);
		fill('#checkpoint-search', 'no-matching-file');
		await settle();
		for (const label of ['Expand all folders', 'Collapse all folders']) {
			expect(app.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.disabled).toBe(true);
		}
		await click('[aria-label="Clear file search"]');
		expect(folders().every((folder) => !folder.open)).toBe(true);
	});

	it('blocks worker answers during manual control and permits them after control returns', async () => {
		const app = await mount();
		await click('[data-action="agent"][data-id="02"]');
		await click('dialog [data-action="takeover"]');
		expect(app.querySelector<HTMLTextAreaElement>('#agent-answer')!.disabled).toBe(true);
		await click('dialog [data-action="takeover"]');
		expect(app.querySelector<HTMLTextAreaElement>('#agent-answer')!.disabled).toBe(false);
		fill('#agent-answer', 'Use one shared limit.');
		await submit('dialog [data-form="answer"]');
		expect(app.querySelector('#agent-answer')).toBeNull();
		expect(app.querySelector('dialog .terminal-header')!.textContent).toContain('Running');
		app
			.querySelector('dialog button')!
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		expect(app.querySelector<HTMLDialogElement>('dialog')!.open).toBe(false);
	});

	it('retains the launch draft and records a complete plain-text answer group', async () => {
		const app = await mount('planning');
		fill('#planning-brief', 'A <plain-text> brief');
		await click('[data-page="workspace"]');
		await click('[data-page="planning"]');
		expect(app.querySelector<HTMLTextAreaElement>('#planning-brief')!.value).toBe(
			'A <plain-text> brief'
		);
		expect(app.querySelector<HTMLInputElement>('#planning-initiative')!.value).toBe('');
		await submit('[data-form="planning-start"]');
		expect(app.querySelectorAll('[data-planning-question]')).toHaveLength(3);
		for (const input of app.querySelectorAll<HTMLTextAreaElement>('[data-planning-question]'))
			fill(`#${input.id}`, '<script>Not HTML</script>');
		const lastQuestion = app.querySelectorAll<HTMLTextAreaElement>('[data-planning-question]')[2]!;
		fill(`#${lastQuestion.id}`, '  ');
		await submit('[data-form="planning-answer"]');
		expect(app.querySelectorAll('.plan-entry')).toHaveLength(0);
		fill(`#${lastQuestion.id}`, '<script>Not HTML</script>');
		await submit('[data-form="planning-answer"]');
		expect(app.querySelectorAll('.plan-entry')).toHaveLength(3);
		expect(app.querySelectorAll('.planner-message')).toHaveLength(4);
		expect(app.querySelectorAll('script')).toHaveLength(0);
	});

	it('collects highlighted comments across files before sending one review', async () => {
		const app = await mount();
		await click('#review-tab');
		expect(app.querySelectorAll('.review-line-feedback')).toHaveLength(0);
		const range = document.createRange();
		range.setStart(app.querySelector('[data-diff-line="5"] code')!.firstChild!, 0);
		range.setEnd(app.querySelector('[data-diff-line="7"] code')!.firstChild!, 1);
		window.getSelection()!.addRange(range);
		app.querySelector('[data-diff-line="6"] code')!.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Enter', bubbles: true,
		}));
		await settle();
		expect(app.querySelector('.review-inline-feedback')?.textContent).toContain('Diff line 6');
		expect(app.querySelector('.review-inline-feedback')?.getAttribute('popover')).toBe('auto');
		expect(app.querySelector('.review-feedback-snippet')?.textContent).not.toContain('readApproval');
		expect(app.querySelector<HTMLButtonElement>('[data-action="approve"]')!.disabled).toBe(true);
		fill('#review-inline-note', 'This check must reject an outdated revision.');
		app.querySelector<HTMLElement>('#checkpoint-search')!.focus();
		const dismissal = new Event('toggle');
		Object.defineProperty(dismissal, 'newState', { value: 'closed' });
		app.querySelector('.review-inline-feedback')!.dispatchEvent(dismissal);
		await settle();
		expect(app.querySelector('.review-inline-feedback')).toBeNull();
		expect(document.activeElement).toBe(app.querySelector('#checkpoint-search'));
		await highlightLine(6);
		expect(app.querySelector<HTMLTextAreaElement>('#review-inline-note')!.value).toBe('This check must reject an outdated revision.');
		await submit('.review-inline-feedback');
		expect(app.querySelector('dialog[open]')).toBeNull();
		expect(app.querySelector('[data-send-review]')?.textContent).toContain('1');
		expect(app.querySelector<HTMLButtonElement>('[data-action="approve"]')!.disabled).toBe(true);
		await click('[data-action="review-file"][data-index="2"]');
		await highlightLine(4);
		expect(app.querySelector<HTMLTextAreaElement>('#review-inline-note')!.value).toBe('');
		fill('#review-inline-note', 'Feedback for the other file.');
		await submit('.review-inline-feedback');
		expect(app.querySelector('dialog[open]')).toBeNull();
		expect(app.querySelector('[data-send-review]')?.textContent).toContain('2');
		await click('[data-review-note]');
		fill('#review-inline-note', 'Review the error paths as one workflow.');
		const dismissalWithSummary = new Event('toggle');
		Object.defineProperty(dismissalWithSummary, 'newState', { value: 'closed' });
		app.querySelector('.review-inline-feedback')!.dispatchEvent(dismissalWithSummary);
		await settle();
		expect(app.querySelector<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(true);
		await click('[data-review-note]');
		expect(app.querySelector<HTMLTextAreaElement>('#review-inline-note')!.value).toBe('Review the error paths as one workflow.');
		await submit('.review-inline-feedback');
		expect(app.querySelectorAll('.review-draft-comment')).toHaveLength(3);
		expect(app.querySelector('.review-draft-comment strong')?.textContent).toBe('Review summary');
		expect(app.querySelector<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(false);
		await click('[data-send-review]');
		expect(app.querySelector('dialog')?.textContent).toContain('src/runner/approval.ts');
		expect(app.querySelector('dialog')?.textContent).toContain('src/runner/recovery.ts');
		expect(app.querySelector('dialog')?.textContent).toContain('verifyRevision(approval, change.revision)');
		expect(app.querySelector('.change-conversation')?.textContent).toContain('This check must reject an outdated revision.');
		expect(app.querySelector('.change-conversation')?.textContent).toContain('Feedback for the other file.');
		const conversation = app.querySelector('.change-conversation')!.textContent;
		expect(conversation.indexOf('Review the error paths as one workflow.')).toBeLessThan(conversation.indexOf('This check must reject an outdated revision.'));
		expect(app.querySelector('#merge-tab')!.textContent).toContain('0');
		expect(app.querySelector('harness-initiative-route')!.model!.issueCount).toBe(42);
		await click('dialog [data-action="close-dialog"]');
		expect(app.querySelector('[data-send-review]')).toBeNull();
	});

	it('collects one general review note before starting the agent discussion', async () => {
		const app = await mount();
		await click('#review-tab');
		await click('[data-review-note]');
		expect(app.querySelector('dialog[open]')).toBeNull();
		expect(app.querySelector('.review-inline-feedback')?.textContent).toContain('Review summary');
		fill('#review-inline-note', 'Keep the approval check separate from recovery.');
		await click('.review-inline-feedback [type="button"]');
		expect(app.querySelector<HTMLButtonElement>('[data-action="approve"]')!.disabled).toBe(true);
		await click('[data-action="review-file"][data-index="2"]');
		await click('[data-review-note]');
		expect(app.querySelector<HTMLTextAreaElement>('#review-inline-note')!.value).toBe('Keep the approval check separate from recovery.');
		await submit('.review-inline-feedback');
		expect(app.querySelector('dialog[open]')).toBeNull();
		expect(app.querySelector('[data-review-note]')?.textContent).toContain('Edit review note');
		expect(app.querySelector<HTMLButtonElement>('[data-action="approve"]')!.disabled).toBe(true);
		await click('[data-review-note]');
		await click('.review-inline-feedback [type="button"]');
		expect(app.querySelector<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(false);
		await click('[data-review-note]');
		fill('#review-inline-note', 'Keep approval separate.');
		await submit('.review-inline-feedback');
		expect(app.querySelectorAll('.review-draft-comment')).toHaveLength(1);
		await click('[aria-label="Remove comment"]');
		expect(app.querySelector('[data-review-note]')?.textContent).toContain('Add review note');
		expect(app.querySelector('[data-send-review]')).toBeNull();
		await click('[data-review-note]');
		fill('#review-inline-note', 'Keep approval separate.');
		await submit('.review-inline-feedback');
		await click('[data-action="pause"]');
		expect(app.querySelector<HTMLButtonElement>('[data-send-review]')!.disabled).toBe(true);
		expect(app.querySelectorAll('.review-draft-comment')).toHaveLength(1);
		await click('[data-action="pause"]');
		await click('[data-send-review]');
		expect(app.querySelector('dialog')?.textContent).toContain('DEMO-03');
		expect(app.querySelector('dialog')?.textContent).toContain('c7b90a2');
		expect(app.querySelector('.change-conversation')?.textContent).toContain('Review summary\nKeep approval separate.');
		expect(app.querySelector('.change-conversation')?.textContent).not.toContain('src/runner/recovery.ts');
		expect(app.querySelector('.change-conversation')?.textContent).not.toContain('What result and acceptance criteria');
		expect(app.querySelector('[data-form="change-answer"]')).toBeNull();
		expect(app.querySelector('dialog .terminal-header')?.textContent).toContain('Running');
		expect(app.querySelectorAll('dialog [data-action="close-dialog"]')).toHaveLength(1);
		expect(app.querySelector('[data-form="change-approval"]')).toBeNull();
		expect(app.querySelector('[data-action="decline-change"]')).toBeNull();
		expect(app.querySelector('[data-action="separate-planning"]')).toBeNull();
		expect(app.querySelector('harness-initiative-route')!.model!.issueCount).toBe(42);
		expect(app.querySelector('#review-tab')!.textContent).toContain('0');
		expect(app.querySelector('#merge-tab')!.textContent).toContain('0');
		await click('dialog [data-action="close-dialog"]');
		expect(app.querySelector('[data-send-review]')).toBeNull();
		expect(app.querySelector('[data-action="approve"]')).toBeNull();
		expect(app.querySelector('[data-empty="review"]')?.textContent).toContain('Changes requested / DEMO-03');
		await click('[data-empty="review"] [data-action="agent"]');
		expect(app.querySelector('.change-conversation')?.textContent).toContain('Keep approval separate.');
	});

	it('keeps the required answer and shared action row for an ordinary change request', async () => {
		const app = await mount();
		await click('[data-action="request-change"]');
		fill('#change-brief', 'Change the recovery workflow.');
		await submit('[data-form="change-start"]');
		const answerActions = app.querySelector('[data-form="change-answer"] .dialog-actions');
		expect(answerActions?.querySelector('[type="button"][data-action="close-dialog"]')).not.toBeNull();
		expect(answerActions?.querySelector('[type="submit"]')?.textContent).toContain('Send answer');
		expect(app.querySelectorAll('dialog [data-action="close-dialog"]')).toHaveLength(1);
		await submit('[data-form="change-answer"]');
		expect(app.querySelector('[data-form="change-approval"]')).toBeNull();
		fill('#change-answer', 'Keep the approved revision.');
		await submit('[data-form="change-answer"]');
		expect(app.querySelector('[data-form="change-approval"]')).not.toBeNull();
	});

	it('switches comment targets without applying a previous popover close event', async () => {
		const app = await mount();
		await click('#review-tab');
		await click('[data-review-note]');
		fill('#review-inline-note', 'A general draft.');
		const previousEditor = app.querySelector('.review-inline-feedback')!;
		await highlightLine(6);
		expect(app.querySelector('.review-inline-feedback')).not.toBe(previousEditor);
		const dismissal = new Event('toggle');
		Object.defineProperty(dismissal, 'newState', { value: 'closed' });
		previousEditor.dispatchEvent(dismissal);
		await settle();
		expect(app.querySelector('.review-inline-feedback')?.textContent).toContain('Diff line 6');
		fill('#review-inline-note', 'A line draft.');
		await click('[data-review-note]');
		expect(app.querySelector<HTMLTextAreaElement>('#review-inline-note')!.value).toBe('A general draft.');
		expect(document.activeElement).toBe(app.querySelector('#review-inline-note'));
	});

	it('keeps edited drafts separate for comments on the same line', async () => {
		const app = await mount();
		await click('#review-tab');
		for (const note of ['First comment.', 'Second comment.']) {
			await highlightLine(6);
			fill('#review-inline-note', note);
			await submit('.review-inline-feedback');
		}
		await click('[aria-label="Edit comment"][data-comment="1"]');
		fill('#review-inline-note', 'Changed first comment.');
		await click('.review-inline-feedback [type="button"]');
		await click('[aria-label="Edit comment"][data-comment="2"]');
		expect(app.querySelector<HTMLTextAreaElement>('#review-inline-note')!.value).toBe('Second comment.');
		await click('.review-inline-feedback [type="button"]');
		await click('[aria-label="Remove comment"][data-comment="2"]');
		await click('[aria-label="Edit comment"][data-comment="1"]');
		expect(app.querySelector<HTMLTextAreaElement>('#review-inline-note')!.value).toBe('Changed first comment.');
		await submit('.review-inline-feedback');
		await click('[data-send-review]');
		expect(app.querySelector('.change-conversation')?.textContent).toContain('Changed first comment.');
		expect(app.querySelector('[data-form="change-answer"]')).toBeNull();
		await click('dialog [data-action="close-dialog"]');
		expect(app.querySelector('[data-action="approve"]')).toBeNull();
	});

	it('shows pending work and requires Review approval before separate Merge approvals', async () => {
		const app = await mount();
		await click('#review-tab');
		expect(app.querySelector('#review-tab')!.textContent).toContain('1');
		expect(app.querySelector('#merge-tab')!.textContent).toContain('0');
		const reviewContext = app.querySelector('harness-review-checkpoint harness-work-context');
		expect(reviewContext?.textContent).toContain('DEMO-03');
		expect(reviewContext?.textContent).toContain('Approval checkpoint');
		expect(reviewContext?.textContent).toContain('Local execution workspace');
		expect(reviewContext?.textContent).toContain('Inspect and control agent work');
		expect(reviewContext?.textContent).toContain('Safe delivery and recovery');
		expect(reviewContext?.textContent).toContain('Integrate and recover approved work');
		expect(reviewContext?.textContent).toContain('worker/approval-checkpoint');
		expect(reviewContext?.textContent).toContain('c7b90a2');
		const reviewIdentity = reviewContext?.textContent;
		const hideRelated = vi.fn();
		app.querySelector<HTMLElement>('#review-panel .work-related-panel')!.hidePopover = hideRelated;
		await click('#review-panel harness-work-context [data-kind="issue"]');
		expect(app.querySelector('dialog')?.textContent).toContain('Bind integration approval to the exact recorded changes.');
		await click('dialog [data-action="close-dialog"]');
		await click('#review-panel .work-related-trigger');
		await click('#review-panel harness-work-context [data-kind="prd"][data-index="0"]');
		expect(app.querySelector('dialog')?.textContent).toContain('Local execution workspace');
		await click('dialog [data-action="close-dialog"]');
		expect(document.activeElement).toBe(app.querySelector('#review-panel .work-related-trigger'));
		expect(hideRelated).toHaveBeenCalledOnce();
		await click('#review-panel .work-related-trigger');
		await click('#review-panel harness-work-context [data-kind="prd"][data-index="1"]');
		expect(app.querySelector('dialog')?.textContent).toContain('Safe delivery and recovery');
		await click('dialog [data-action="close-dialog"]');
		await click('#merge-tab');
		expect(app.querySelector('[data-empty="merge"]')).not.toBeNull();
		expect(app.querySelector('harness-merge-workspace')).toBeNull();
		await click('#review-tab');
		await click('[data-action="pause"]');
		expect(app.querySelector<HTMLButtonElement>('[data-action="approve"]')!.disabled).toBe(true);
		expect(app.querySelector('#review-tab')!.textContent).toContain('1');
		await click('[data-action="pause"]');
		await click('[data-action="approve"]');
		expect(app.querySelector('#review-tab')!.textContent).toContain('0');
		expect(app.querySelector('#merge-tab')!.textContent).toContain('1');
		expect(app.querySelectorAll('[data-action="merge-issue"]')).toHaveLength(1);
		expect(app.querySelector('harness-merge-workspace harness-work-context')?.textContent).toBe(reviewIdentity);
		expect(app.querySelector('harness-initiative-route')!.textContent).toContain('Waiting for merge');
		expect(app.querySelector('.phase-badge')!.textContent).toBe('Ready for approval');
		expect(app.querySelector('harness-initiative-route')!.model!.integrated).toBe(0);
		await click('#review-tab');
		expect(app.querySelector('[data-empty="review"]')).not.toBeNull();
		expect(app.querySelector('harness-review-checkpoint')).toBeNull();
		await click('#merge-tab');
		await click('[data-action="merge-advance"]');
		expect(app.querySelector('.phase-badge')!.textContent).toBe('Resolution needs approval');
		expect(app.querySelector('harness-initiative-route')!.model!.integrated).toBe(0);
		await click('[data-action="merge-advance"]');
		expect(app.querySelector('[data-empty="merge"]')).not.toBeNull();
		expect(app.querySelector('#merge-tab')!.textContent).toContain('0');
		expect(app.querySelector('harness-initiative-route')!.model!.integrated).toBe(1);
	});
});
