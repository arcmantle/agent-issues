const app = document.querySelector('#app');
const dialog = document.querySelector('#action-dialog');
const variants = ['A', 'B', 'C'];
const names = { A: 'Workbench', B: 'Signal room', C: 'Review desk' };
const initialState = () => ({
	mode: 'running', tab: 'inbox', file: 0, question: true, approved: false, integrated: false,
	limits: { copilot: 40, interpreter: 250 },
	workers: [
		{ id: '01', title: 'Session recovery', issue: 'DEMO-01', status: 'running', visible: true, manual: false, lines: ['GitHub Copilot / simulated session', '', '> /agent-issues tdd DEMO-01', '', 'Read issue context and recovery contract.', 'Run focused validation.', '', '$ pnpm test -- recovery', 'PASS  interrupted session records', 'PASS  restore pending inbox items', '', 'REFACTOR: no justified change.', 'Independent review is in progress.'] },
		{ id: '02', title: 'Usage limits', issue: 'DEMO-02', status: 'waiting', visible: true, manual: false, lines: ['GitHub Copilot / simulated session', '', '> /agent-issues implement DEMO-02', '', 'Read provider usage requirements.', 'Inspect the shared accounting boundary.', '', 'Question for the user:', 'Should the limit apply across all workers?', '', 'Waiting for your decision.', 'Independent work can continue.'] },
		{ id: '03', title: 'Approval checkpoint', issue: 'DEMO-03', status: 'review', visible: false, manual: false, lines: ['GitHub Copilot / simulated session', '', '> /agent-issues tdd DEMO-03', '', 'PASS  approval binds to recorded changes', 'PASS  changed revision requires approval', '', 'Independent review: no material findings.', 'Final focused validation: passed.', '', 'Issue complete. Integration awaits approval.'] },
	],
	activity: ['Worker 03 completed its skill review.', 'Checkpoint saved: validation / attempt 03.1.', 'Worker 02 requested a usage-limit decision.', 'Workers 01 and 02 started in separate worktrees.'],
});
let state = initialState();
let terminals = [];
let variant = new URL(location.href).searchParams.get('variant') || 'A';
if (!variants.includes(variant)) variant = 'A';
const icon = (name) => `<i data-lucide="${name}"></i>`;
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const labels = { running: 'Working', waiting: 'Needs answer', review: 'Review ready', integrated: 'Integrated', stopping: 'Shutdown requested', stopped: 'Stopped', terminated: 'Terminated' };
const pendingCount = () => Number(state.question) + Number(!state.integrated);
const runLabel = () => ({ running: 'Running', paused: 'Paused', stopping: 'Stopping', stopped: 'Stopped', terminated: 'Terminated' })[state.mode];

function controls() {
	const active = ['running', 'paused'].includes(state.mode);
	return `<div class="controls">
		<button data-action="pause" ${!active ? 'disabled' : ''}>${icon(state.mode === 'paused' ? 'play' : 'pause')}${state.mode === 'paused' ? 'Resume' : 'Pause'}</button>
		<button data-action="stop" ${!active ? 'disabled' : ''}>${icon('square')}Stop</button>
		<button class="icon-button danger" data-action="terminate" title="Terminate workers" aria-label="Terminate workers" ${!active && state.mode !== 'stopping' ? 'disabled' : ''}>${icon('octagon-x')}</button>
	</div>`;
}
function runHeader(showBrand = false) {
	return `<header class="run-header"><div>${showBrand ? '<div class="brand">agent-issues / harness</div>' : ''}<h1>Initiative execution harness</h1><div class="run-subtitle"><span class="status ${state.mode}">${runLabel()}</span><span class="mono">harness/initiative</span><span>Run 004</span></div></div>${controls()}</header>`;
}
function workerList() {
	return `<div class="section-label eyebrow"><span>Agents</span><span>${state.workers.filter((worker) => worker.visible).length} visible</span></div><div class="worker-list">${state.workers.map((worker) => `<label class="worker-row ${worker.visible ? 'selected' : ''}"><span class="worker-number">${worker.id}</span><span><strong>Worker ${worker.id}</strong><small>${labels[worker.status]}</small></span><input type="checkbox" data-worker="${worker.id}" ${worker.visible ? 'checked' : ''} aria-label="Show Worker ${worker.id} terminal" /></label>`).join('')}</div>`;
}
function usage() {
	return `<section class="usage"><div class="usage-heading"><span class="eyebrow muted">Usage / simulated</span><button data-action="limits" title="Edit usage limits" aria-label="Edit usage limits">${icon('sliders-horizontal')}</button></div><div class="usage-label"><span>Copilot requests</span><span class="mono">18 / ${state.limits.copilot}</span></div><progress max="${state.limits.copilot}" value="18" aria-label="Simulated Copilot usage"></progress><div class="usage-label"><span>Interpreter calls</span><span class="mono">42 / ${state.limits.interpreter}</span></div><progress max="${state.limits.interpreter}" value="42" aria-label="Simulated interpreter usage"></progress></section>`;
}
function rail(review = false) {
	return `<aside class="rail"><div class="rail-project"><div class="brand"><span class="brand-mark">${icon('workflow')}</span>agent-issues</div><div class="eyebrow">Repository</div><h3>agent-issues</h3><p class="mono muted">local-roen / main</p></div><section>${workerList()}</section>${review ? '<section class="review-queue"><div class="eyebrow muted">Integration queue</div><div class="queue-row"><strong>Approval checkpoint</strong><span class="status review">' + (state.integrated ? 'Integrated' : 'Awaiting approval') + '</span></div><div class="queue-row"><strong>Session recovery</strong><span class="muted">Independent review</span></div><div class="queue-row"><strong>Usage limits</strong><span class="muted">' + (state.question ? 'Needs a decision' : 'In progress') + '</span></div></section>' : ''}${usage()}</aside>`;
}
function terminalGrid() {
	const selected = state.workers.filter((worker) => worker.visible);
	if (!selected.length) return '<section class="empty-terminals"><h2>No terminals selected</h2><p>Agent execution is unchanged.</p></section>';
	return `<div class="terminal-grid" data-count="${selected.length}">${selected.map((worker) => `<section class="terminal-panel" aria-label="Worker ${worker.id} terminal"><div class="terminal-header"><strong>Worker ${worker.id} / Copilot</strong><span class="status ${worker.status}">${labels[worker.status]}</span></div><div class="terminal-meta"><span>${worker.issue}</span><span>attempt ${worker.id}.1</span></div><div class="terminal-host" data-terminal="${worker.id}"></div><div class="terminal-footer"><span>${worker.manual ? 'Input: you' : 'Input: harness'}</span><button data-action="takeover" data-id="${worker.id}">${icon(worker.manual ? 'undo-2' : 'keyboard')}${worker.manual ? 'Return control' : 'Take control'}</button></div></section>`).join('')}</div>`;
}
function questionItem() {
	if (!state.question) return '';
	const worker = state.workers[1];
	const blocked = worker.manual || ['stopping', 'stopped', 'terminated'].includes(state.mode);
	return `<article class="inbox-item"><div class="item-kicker"><span class="item-kind">${icon('message-circle')}Decision required</span><span>Worker 02</span></div><h3>One limit across all workers?</h3><p>Should Copilot usage be counted per worker or across the whole provider integration?</p><form class="answer-form" data-form="answer"><textarea name="answer" placeholder="Your decision..." aria-label="Answer for Worker 02" required ${blocked ? 'disabled' : ''}></textarea><button class="primary" ${blocked ? 'disabled' : ''}>${icon('send')}Send to Worker 02</button></form>${worker.manual ? '<p>Terminal input is owned by you.</p>' : ''}</article>`;
}
function approvalItem() {
	if (state.integrated) return '';
	return `<article class="inbox-item"><div class="item-kicker"><span class="item-kind">${icon('git-pull-request')}Integration approval</span><span>Worker 03</span></div><h3>Approval checkpoint</h3><p>DEMO-03 / attempt 03.1<br>Skill complete. Changes are not integrated.</p><div class="approval-evidence"><span>${icon('check')}6 checks passed</span><span>${icon('check')}Review passed</span><span class="mono">+24 -7</span></div><div class="approval-actions"><button data-action="changes">${icon('file-diff')}Inspect changes</button><button class="primary" data-action="approve" ${state.mode !== 'running' ? 'disabled' : ''}>${icon('git-merge')}Approve integration</button></div></article>`;
}
function inboxContent() {
	return `<div class="inbox-items">${questionItem()}${approvalItem()}${pendingCount() === 0 ? '<article class="inbox-item"><span class="item-kind">' + icon('check-check') + 'All decisions supplied</span><p>Independent work can continue.</p></article>' : ''}</div>`;
}
const fileNames = ['approval.ts', 'approval.test.ts', 'checkpoint.ts'];
const diffs = [
	['@@ approval checkpoint @@', '  export function integrate(change) {', '-   return merge(change);', '+   const approval = readApproval(change.id);', '+   verifyRevision(approval, change.revision);', '+   return mergeApproved(change, approval);', '  }'],
	['@@ public-interface checks @@', '+ test("changed revision requires approval", () => {', '+   const change = updateRecordedChanges();', '+   expect(() => integrate(change)).toThrow();', '+ });', '+ test("approved changes can integrate", () => {', '+   expect(integrate(approvedChange)).toBeDefined();', '+ });'],
	['@@ recorded checkpoint @@', '+ export const checkpoint = {', '+   issue: "DEMO-03",', '+   attempt: "03.1",', '+   stage: "review",', '+   revision: "c7b90a2",', '+ };'],
];
function changesContent() {
	return `<div class="checkpoint-bar"><span>Worker 03 / Review checkpoint</span><span class="mono">c7b90a2</span></div>${fileNames.map((file, index) => `<button class="change-file ${state.file === index ? 'active' : ''}" data-action="file" data-index="${index}"><span>${icon('file-code-2')} ${file}</span><span class="additions">+${[9, 11, 4][index]}</span></button>`).join('')}<pre class="diff" aria-label="Simulated checkpoint diff">${diffs[state.file].map((line) => `<span class="${line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}">${escapeHtml(line)}</span>`).join('')}</pre>`;
}
function activityContent() {
	return state.activity.map((entry, index) => `<div class="activity-entry"><span class="mono muted">${index === 0 ? 'now' : `-${index}m`}</span><span>${escapeHtml(entry)}</span></div>`).join('');
}
function inspector() {
	return `<div class="panel-title"><h2>Run inbox <span class="count">${pendingCount()}</span></h2><span class="eyebrow muted">Run 004</span></div><div class="tabs" role="tablist">${['inbox', 'changes', 'activity'].map((tab) => `<button role="tab" aria-selected="${state.tab === tab}" class="${state.tab === tab ? 'active' : ''}" data-action="tab" data-tab="${tab}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join('')}</div><section role="tabpanel">${state.tab === 'changes' ? changesContent() : state.tab === 'activity' ? activityContent() : inboxContent()}</section>`;
}
function VariantA() {
	return `<div class="workbench">${rail()}<section class="workspace">${runHeader()}<div class="workbench-scene"><section><div class="viewport-label"><span class="eyebrow">Agent viewport</span><span>Native terminals / simulated</span></div>${terminalGrid()}</section><aside class="inspector">${inspector()}</aside></div></section></div>`;
}
function VariantB() {
	const working = state.workers.filter((worker) => worker.status === 'running').length;
	return `<div class="signal">${runHeader(true)}<section class="metrics"><div class="metric"><strong>${state.integrated ? '4' : '3'}<span> / 9</span></strong><span>Issues integrated</span></div><div class="metric"><strong>${working}</strong><span>Agents working</span></div><div class="metric"><strong>${pendingCount()}</strong><span>Decisions pending</span></div><div class="metric"><strong>18<span> / ${state.limits.copilot}</span></strong><span>Copilot requests / simulated</span></div></section><div class="signal-body">${rail()}<section><div class="viewport-label"><span class="eyebrow">Agent viewport</span><span>Run 004 / ${runLabel()}</span></div>${terminalGrid()}<section class="signal-dock">${inspector()}</section></section></div></div>`;
}
function VariantC() {
	return `<div class="review-layout">${rail(true)}<section class="workspace">${runHeader()}<div class="review-content"><section class="review-main"><div class="panel-title"><h2>Approval checkpoint</h2><span class="status review">${state.integrated ? 'Integrated' : 'Ready for inspection'}</span></div>${changesContent()}</section><aside>${inspector()}</aside></div><section class="review-terminals"><div class="viewport-label"><span class="eyebrow">Agent viewport</span><span>${state.workers.filter((worker) => worker.visible).length} selected terminals</span></div>${terminalGrid()}</section></section></div>`;
}
function render() {
	terminals.forEach(({ terminal, observer }) => { observer.disconnect(); terminal.dispose(); });
	terminals = [];
	app.innerHTML = ({ A: VariantA, B: VariantB, C: VariantC })[variant]();
	document.querySelector('#variant-label').textContent = `${variant} / ${names[variant]}`;
	document.body.dataset.variant = variant;
	window.lucide?.createIcons();
	for (const host of app.querySelectorAll('[data-terminal]')) {
		const worker = state.workers.find((item) => item.id === host.dataset.terminal);
		if (!window.Terminal || !window.FitAddon) {
			host.innerHTML = `<pre>${escapeHtml(worker.lines.join('\n'))}</pre>`;
			continue;
		}
		const terminal = new window.Terminal({ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, lineHeight: 1.45, cursorBlink: worker.manual, theme: { background: '#17201c', foreground: '#cfddd2', cursor: '#c9ed6a', selectionBackground: '#42604c' }, scrollback: 300, convertEol: true });
		const fit = new window.FitAddon.FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host);
		fit.fit();
		worker.lines.forEach((line, index) => terminal.writeln(index === 0 ? `\x1b[38;2;201;237;106m${line}\x1b[0m` : line.startsWith('PASS') ? `\x1b[38;2;145;221;210m${line}\x1b[0m` : line));
		terminal.scrollToTop();
		let input = '';
		terminal.onData((data) => {
			if (!worker.manual || !['running', 'paused'].includes(state.mode)) return;
			if (data === '\r') {
				worker.lines.push(`> ${input}`, 'Simulated input recorded.');
				terminal.write('\r\nSimulated input recorded.\r\n> ');
				input = '';
			} else if (data === '\u007f') {
				if (input.length) { input = input.slice(0, -1); terminal.write('\b \b'); }
			} else if (/^[\x20-\x7e]+$/.test(data)) {
				input += data;
				terminal.write(data);
			}
		});
		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(host);
		terminals.push({ terminal, observer });
	}
	document.querySelector('#app').dataset.state = JSON.stringify({ mode: state.mode, visible: state.workers.filter((worker) => worker.visible).map((worker) => worker.id), workers: state.workers.map(({ id, status, manual }) => ({ id, status, manual })), pending: pendingCount(), integrated: state.integrated, limits: state.limits });
}
function notify(message) {
	const toast = document.querySelector('#toast');
	toast.textContent = message;
	toast.classList.add('visible');
	clearTimeout(notify.timer);
	notify.timer = setTimeout(() => toast.classList.remove('visible'), 3200);
}
function changeVariant(direction) {
	variant = variants[(variants.indexOf(variant) + direction + variants.length) % variants.length];
	const url = new URL(location.href);
	url.searchParams.set('variant', variant);
	history.replaceState(null, '', url);
	render();
}
function openDialog(action) {
	if (action === 'terminate') {
		dialog.innerHTML = `<form data-form="terminate"><h2>Terminate workers?</h2><p>Worker processes will end immediately. Recorded work remains available. Interrupted writes may be incomplete.</p><div class="dialog-actions"><button type="button" data-action="close-dialog">Cancel</button><button class="danger">${icon('octagon-x')}Terminate</button></div></form>`;
	} else {
		dialog.innerHTML = `<form data-form="limits"><h2>Usage limits / simulated</h2><label>Copilot requests<input type="number" name="copilot" min="18" value="${state.limits.copilot}" required /></label><label>Interpreter calls<input type="number" name="interpreter" min="42" value="${state.limits.interpreter}" required /></label><div class="dialog-actions"><button type="button" data-action="close-dialog">Cancel</button><button class="primary">Save limits</button></div></form>`;
	}
	window.lucide?.createIcons();
	dialog.showModal();
}
document.addEventListener('click', (event) => {
	const button = event.target.closest('[data-action]');
	if (!button || button.disabled) return;
	const action = button.dataset.action;
	if (['terminate', 'limits'].includes(action)) { openDialog(action); return; }
	if (action === 'close-dialog') { dialog.close(); return; }
	if (action === 'pause') {
		state.mode = state.mode === 'running' ? 'paused' : 'running';
		notify(state.mode === 'paused' ? 'New assignments and integrations paused. Current agents continue.' : 'Harness scheduling resumed.');
	}
	if (action === 'stop') {
		state.mode = 'stopping';
		state.workers.filter((worker) => ['running', 'waiting'].includes(worker.status)).forEach((worker) => { worker.status = 'stopping'; worker.lines.push('Simulated shutdown requested. Waiting for worker response.'); });
		notify('Shutdown requested. Recorded work is preserved.');
		const stoppingState = state;
		setTimeout(() => {
			if (state !== stoppingState || state.mode !== 'stopping') return;
			state.mode = 'stopped';
			state.workers.filter((worker) => worker.status === 'stopping').forEach((worker) => { worker.status = 'stopped'; worker.lines.push('Simulated worker shutdown confirmed.'); });
			render();
			notify('Simulated shutdown confirmed. Recorded work is preserved.');
		}, 1200);
	}
	if (action === 'takeover') {
		const worker = state.workers.find((item) => item.id === button.dataset.id);
		worker.manual = !worker.manual;
		notify(worker.manual ? `Worker ${worker.id}: input belongs to you.` : `Worker ${worker.id}: input returned to the harness.`);
	}
	if (action === 'tab') state.tab = button.dataset.tab;
	if (action === 'changes') state.tab = 'changes';
	if (action === 'file') state.file = Number(button.dataset.index);
	if (action === 'approve' && state.mode === 'running') {
		state.approved = true;
		state.integrated = true;
		state.workers[2].status = 'integrated';
		state.workers[2].lines.push('User approval recorded.', 'Simulated integration complete.');
		state.activity.unshift('Approved DEMO-03 changes integrated into the initiative branch.');
		notify('Simulated integration complete. No repository files changed.');
	}
	render();
});
document.addEventListener('change', (event) => {
	if (!event.target.matches('[data-worker]')) return;
	state.workers.find((worker) => worker.id === event.target.dataset.worker).visible = event.target.checked;
	render();
});
document.addEventListener('submit', (event) => {
	const form = event.target;
	if (!form.dataset.form) return;
	event.preventDefault();
	const values = new FormData(form);
	if (form.dataset.form === 'answer') {
		const worker = state.workers[1];
		if (worker.manual || ['stopping', 'stopped', 'terminated'].includes(state.mode)) return;
		state.question = false;
		worker.status = 'running';
		worker.lines.push(`User decision: ${values.get('answer')}`, 'Resume the existing skill with this decision.');
		state.activity.unshift('User decision routed to Worker 02.');
		notify('Decision sent to Worker 02 in the simulation.');
	}
	if (form.dataset.form === 'terminate') {
		state.mode = 'terminated';
		state.workers.filter((worker) => ['running', 'waiting', 'stopping'].includes(worker.status)).forEach((worker) => { worker.status = 'terminated'; worker.lines.push('Simulated termination. State check required before restart.'); });
		dialog.close();
		notify('Simulated workers terminated. Work remains recorded.');
	}
	if (form.dataset.form === 'limits') {
		state.limits = { copilot: Number(values.get('copilot')), interpreter: Number(values.get('interpreter')) };
		dialog.close();
		notify('Simulation limits updated.');
	}
	render();
});
document.querySelector('#previous-variant').addEventListener('click', () => changeVariant(-1));
document.querySelector('#next-variant').addEventListener('click', () => changeVariant(1));
document.querySelector('#reset-prototype').addEventListener('click', () => { state = initialState(); render(); notify('Simulation reset.'); });
document.addEventListener('keydown', (event) => {
	if (event.target.closest('input, textarea, select, [contenteditable], .xterm') || dialog.open) return;
	if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
		event.preventDefault();
		changeVariant(event.key === 'ArrowRight' ? 1 : -1);
	}
});
render();