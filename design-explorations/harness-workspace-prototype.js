const app = document.querySelector('#app');
const dialog = document.querySelector('#action-dialog');
const variants = ['A', 'B', 'C'];
const names = { A: 'Workbench', B: 'Signal room', C: 'Review desk' };
const initialState = () => ({
	mode: 'running', view: 'agents', tab: 'inbox', file: 0, reviewFile: 0, fileQuery: '', collapsedFolders: [], question: true, answerDraft: '', approved: false, integrated: false,
	limits: { copilot: 40, interpreter: 250 },
	workers: [
		{ id: '01', title: 'Session recovery', issue: 'DEMO-01', status: 'running', visible: true, manual: false, lines: ['GitHub Copilot / simulated session', '', '> /agent-issues tdd DEMO-01', '', 'Read issue context and recovery contract.', 'Run focused validation.', '', '$ pnpm test -- recovery', 'PASS  interrupted session records', 'PASS  restore pending inbox items', '', 'REFACTOR: no justified change.', 'Independent review is in progress.'] },
		{ id: '02', title: 'Usage limits', issue: 'DEMO-02', status: 'waiting', visible: true, manual: false, lines: ['GitHub Copilot / simulated session', '', '> /agent-issues implement DEMO-02', '', 'Read provider usage requirements.', 'Inspect the shared accounting boundary.', '', 'Question for the user:', 'Should the limit apply across all workers?', '', 'Waiting for your decision.', 'Independent work can continue.'] },
		{ id: '03', title: 'Approval checkpoint', issue: 'DEMO-03', status: 'review', visible: true, manual: false, lines: ['GitHub Copilot / simulated session', '', '> /agent-issues tdd DEMO-03', '', 'PASS  approval binds to recorded changes', 'PASS  changed revision requires approval', '', 'Independent review: no material findings.', 'Final focused validation: passed.', '', 'Issue complete. Integration awaits approval.'] },
	],
	activity: ['Worker 03 completed its skill review.', 'Checkpoint saved: validation / attempt 03.1.', 'Worker 02 requested a usage-limit decision.', 'Workers 01 and 02 started in separate worktrees.'],
});
let state = initialState();
let viewedInitiative = 'harness';
const initiativeViews = {
	harness: { title: 'Initiative execution harness', summary: 'Coordinate agents, user decisions, and approved changes.', prd: 'Local execution workspace', story: 'Inspect and control agent work', issues: ['Session recovery', 'Usage limits', 'Approval checkpoint'], adrs: ['Native terminal workspace', 'Approved integration'] },
	navigation: { title: 'Tracker navigation', summary: 'Find tracked requirements and linked work.', prd: 'Connected work navigation', story: 'Browse initiative records', issues: ['Initiative selector', 'Linked record view', 'Work filters'], adrs: ['Shared tracker queries'], run: 'No active run' },
};
let terminals = [];
let scrollPositions = {};
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
	const browsing = variant === 'C' && viewedInitiative !== 'harness';
	return `<header class="run-header"><div>${showBrand ? '<div class="brand">agent-issues / harness</div>' : ''}<h1>${browsing ? initiativeViews[viewedInitiative].title : initiativeViews.harness.title}</h1><div class="run-subtitle">${browsing ? '<span>No active run</span><span>Read-only view</span>' : `<span class="status ${state.mode}">${runLabel()}</span><span class="mono">harness/initiative</span><span>Run 004</span>`}</div></div>${browsing ? '<button data-action="active-run">' + icon('arrow-left') + 'Return to active run</button>' : controls()}</header>`;
}
function trackedWork() {
	const initiative = initiativeViews[viewedInitiative];
	const row = (title, kind, index, status) => `<button class="tracked-record" data-action="record" data-kind="${kind}" data-index="${index}"><span>${icon(kind === 'issue' ? 'circle-dot' : 'file-text')}<span>${title}</span></span><small>${status}</small></button>`;
	return `<section class="initiative-navigation"><label class="eyebrow muted" for="initiative-selector">Initiative</label><select id="initiative-selector" aria-label="Select initiative">${Object.entries(initiativeViews).map(([key, value]) => `<option value="${key}" ${viewedInitiative === key ? 'selected' : ''}>${value.title}</option>`).join('')}</select><div class="scope-run">${viewedInitiative === 'harness' ? `Run 004 / ${runLabel()}` : initiative.run}</div>${viewedInitiative !== 'harness' ? '<button class="active-run-link" data-action="active-run">' + icon('activity') + 'Harness / ' + runLabel() + '</button>' : ''}<nav class="tracked-work" aria-label="Initiative work"><details open><summary>PRD / 1</summary>${row(initiative.prd, 'prd', 0, 'Draft')}<details open class="story-group"><summary>User story / 1</summary>${row(initiative.story, 'story', 0, 'In progress')}<div class="issue-group">${initiative.issues.map((title, index) => row(title, 'issue', index, viewedInitiative === 'harness' ? labels[state.workers[index].status] : 'Ready')).join('')}</div></details></details><details><summary>ADRs / ${initiative.adrs.length}</summary>${initiative.adrs.map((title, index) => row(title, 'adr', index, 'Current')).join('')}</details></nav></section>`;
}
function workerList() {
	return `<div class="section-label eyebrow"><span>Agents</span><span>${state.workers.filter((worker) => worker.visible).length} visible</span></div><div class="worker-list">${state.workers.map((worker) => `<label class="worker-row ${worker.visible ? 'selected' : ''}"><span class="worker-number">${worker.id}</span><span><strong>Worker ${worker.id}</strong><small>${labels[worker.status]}</small></span><input type="checkbox" data-worker="${worker.id}" ${worker.visible ? 'checked' : ''} aria-label="Show Worker ${worker.id} terminal" /></label>`).join('')}</div>`;
}
function usage() {
	return `<section class="usage"><div class="usage-heading"><span class="eyebrow muted">Usage / simulated</span><button data-action="limits" title="Edit usage limits" aria-label="Edit usage limits">${icon('sliders-horizontal')}</button></div><div class="usage-label"><span>Copilot requests</span><span class="mono">18 / ${state.limits.copilot}</span></div><progress max="${state.limits.copilot}" value="18" aria-label="Simulated Copilot usage"></progress><div class="usage-label"><span>Interpreter calls</span><span class="mono">42 / ${state.limits.interpreter}</span></div><progress max="${state.limits.interpreter}" value="42" aria-label="Simulated interpreter usage"></progress></section>`;
}
function rail(review = false) {
	const browsing = review && viewedInitiative !== 'harness';
	return `<aside class="rail"><div class="rail-project"><div class="brand"><span class="brand-mark">${icon('workflow')}</span>agent-issues</div><div class="eyebrow">Repository</div><h3>agent-issues</h3><p class="mono muted">local-roen / main</p></div>${review ? trackedWork() : ''}${!browsing ? `<section>${workerList()}</section>` : ''}${review && !browsing ? '<section class="review-queue"><div class="eyebrow muted">Integration queue</div><div class="queue-row"><strong>Approval checkpoint</strong><span class="status review">' + (state.integrated ? 'Integrated' : 'Awaiting approval') + '</span></div><div class="queue-row"><strong>Session recovery</strong><span class="muted">Independent review</span></div><div class="queue-row"><strong>Usage limits</strong><span class="muted">' + (state.question ? 'Needs a decision' : 'In progress') + '</span></div></section>' : ''}${!browsing ? usage() : ''}</aside>`;
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
	return `<article class="inbox-item"><div class="item-kicker"><span class="item-kind">${icon('message-circle')}Decision required</span><span>Worker 02</span></div><h3>One limit across all workers?</h3><p>Should Copilot usage be counted per worker or across the whole provider integration?</p><form class="answer-form" data-form="answer"><textarea name="answer" placeholder="Your decision..." aria-label="Answer for Worker 02" required ${blocked ? 'disabled' : ''}>${escapeHtml(state.answerDraft)}</textarea><button class="primary" ${blocked ? 'disabled' : ''}>${icon('send')}Send to Worker 02</button></form>${worker.manual ? '<p>Terminal input is owned by you.</p>' : ''}</article>`;
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
const checkpointFiles = Array.from({ length: 50 }, (_, index) => {
	const folders = ['src/runner', 'src/providers', 'src/checkpoints', 'src/workspace', 'tests'];
	const modules = ['approval', 'checkpoint', 'recovery', 'session', 'usage', 'worker', 'integration', 'inbox', 'limits', 'scheduler'];
	const folder = folders[Math.floor(index / 10)];
	const name = `${modules[index % 10]}${folder === 'tests' ? '.test' : ''}.ts`;
	return { index, folder, name, path: `${folder}/${name}`, added: index % 9 + 3, removed: index % 4, kind: index % 7 === 0 ? 'A' : 'M' };
});
const matchingFiles = () => checkpointFiles.filter((file) => file.path.toLowerCase().includes(state.fileQuery.toLowerCase().trim()));
function checkpointBrowser() {
	const files = matchingFiles();
	const selected = checkpointFiles[state.reviewFile];
	const position = files.findIndex((file) => file.index === state.reviewFile);
	const folders = [...new Set(files.map((file) => file.folder))];
	const diff = [`@@ ${selected.path} / simulated checkpoint @@`, ...diffs[state.reviewFile % diffs.length]];
	return `<div class="checkpoint-files" data-scroll-key="checkpoint-files" aria-label="Changed files"><div class="file-result-count">${files.length} of 50 files</div>${folders.map((folder) => `<details data-folder="${folder}" ${state.collapsedFolders.includes(folder) ? '' : 'open'}><summary>${folder} <span>${files.filter((file) => file.folder === folder).length}</span></summary>${files.filter((file) => file.folder === folder).map((file) => `<button class="checkpoint-file ${file.index === state.reviewFile ? 'active' : ''}" data-action="review-file" data-index="${file.index}" aria-current="${file.index === state.reviewFile ? 'true' : 'false'}" title="${file.path}"><span>${file.name}</span><small><b>${file.kind}</b> +${file.added} -${file.removed}</small></button>`).join('')}</details>`).join('')}${!files.length ? '<p class="no-files">No matching files</p>' : ''}</div><section class="checkpoint-selected"><div class="selected-file-header"><span class="mono">${selected.path}</span><div><span>${position < 0 ? 'Outside filter' : `${position + 1} / ${files.length}`}</span><button class="icon-button" data-action="review-previous" aria-label="Previous changed file" title="Previous changed file" ${position <= 0 ? 'disabled' : ''}>${icon('chevron-up')}</button><button class="icon-button" data-action="review-next" aria-label="Next changed file" title="Next changed file" ${position < 0 || position >= files.length - 1 ? 'disabled' : ''}>${icon('chevron-down')}</button></div></div><pre class="diff checkpoint-diff" data-scroll-key="checkpoint-diff" aria-label="Selected checkpoint diff">${diff.map((line) => `<span class="${line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}">${escapeHtml(line)}</span>`).join('')}</pre></section>`;
}
function reviewCheckpoint() {
	const added = checkpointFiles.reduce((total, file) => total + file.added, 0);
	const removed = checkpointFiles.reduce((total, file) => total + file.removed, 0);
	return `<section class="review-main"><div class="checkpoint-heading"><div><h2>Approval checkpoint</h2><div class="checkpoint-context">DEMO-03 / attempt 03.1 / c7b90a2<br>50 files <span class="additions">+${added}</span> -${removed} / simulated</div></div><button class="primary" data-action="approve" ${state.mode !== 'running' || state.integrated ? 'disabled' : ''}>${icon(state.integrated ? 'check' : 'git-merge')}${state.integrated ? 'Integrated' : 'Approve integration'}</button></div><div class="checkpoint-search"><label for="checkpoint-search">${icon('search')}</label><input id="checkpoint-search" type="search" aria-label="Search changed files" placeholder="Find a file..." value="${escapeHtml(state.fileQuery)}" /><button class="icon-button" data-action="clear-file-query" title="Clear file search" aria-label="Clear file search">${icon('x')}</button></div><div class="checkpoint-browser">${checkpointBrowser()}</div></section>`;
}
function runInbox() {
	return `<div class="panel-title"><h2>Run inbox <span class="count">${pendingCount()}</span></h2></div><div class="tabs" role="tablist" aria-label="Run decisions">${['inbox', 'activity'].map((tab) => `<button role="tab" aria-selected="${state.tab === tab}" class="${state.tab === tab ? 'active' : ''}" data-action="tab" data-tab="${tab}">${tab === 'inbox' ? 'Inbox' : 'Activity'}</button>`).join('')}</div><section>${state.tab === 'activity' ? activityContent() : `${questionItem()}${state.integrated ? '<article class="inbox-item"><h3>Integration recorded</h3><p>DEMO-03 / simulated integration complete.</p></article>' : '<article class="inbox-item"><h3>Review ready</h3><p>DEMO-03 / 6 checks passed / independent review passed. Integration awaits your approval.</p><button data-action="open-review">' + icon('file-diff') + 'Open review</button></article>'}`}</section>`;
}
function rememberScroll() {
	for (const region of app.querySelectorAll('[data-scroll-key]')) {
		if (!region.closest('[hidden]')) scrollPositions[region.dataset.scrollKey] = region.scrollTop;
	}
}
function switchWorkspace(view) {
	rememberScroll();
	state.view = view;
	for (const panel of app.querySelectorAll('[data-workspace-panel]')) panel.hidden = panel.dataset.workspacePanel !== view;
	for (const tab of app.querySelectorAll('[data-action="workspace-view"]')) {
		tab.setAttribute('aria-selected', String(tab.dataset.view === view));
		tab.tabIndex = tab.dataset.view === view ? 0 : -1;
	}
	const workspace = app.querySelector('.review-layout .workspace');
	workspace.dataset.scrollKey = `workspace-${view}`;
	workspace.scrollTop = scrollPositions[`workspace-${view}`] || 0;
	app.dataset.view = view;
	requestAnimationFrame(() => terminals.forEach(({ fit, host }) => { if (host.offsetWidth && host.offsetHeight) fit.fit(); }));
}
function rememberFolders() {
	for (const folder of app.querySelectorAll('.checkpoint-files [data-folder]')) {
		state.collapsedFolders = state.collapsedFolders.filter((name) => name !== folder.dataset.folder);
		if (!folder.open) state.collapsedFolders.push(folder.dataset.folder);
	}
}
function refreshCheckpoint() {
	const browser = app.querySelector('.checkpoint-browser');
	const listScroll = browser.querySelector('.checkpoint-files').scrollTop;
	rememberFolders();
	browser.innerHTML = checkpointBrowser();
	browser.querySelector('.checkpoint-files').scrollTop = listScroll;
	window.lucide?.createIcons();
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
	if (viewedInitiative !== 'harness') {
		const initiative = initiativeViews[viewedInitiative];
		return `<div class="review-layout">${rail(true)}<section class="workspace">${runHeader()}<section class="initiative-overview"><h2>${initiative.prd}</h2><p>${initiative.summary}</p><div class="overview-heading"><h3>Issues</h3><span class="muted">3 ready / no assignments</span></div>${initiative.issues.map((title, index) => `<button class="tracked-record" data-action="record" data-kind="issue" data-index="${index}"><span>${icon('circle-dot')}${title}</span><small>Ready</small></button>`).join('')}</section></section></div>`;
	}
	return `<div class="review-layout">${rail(true)}<section class="workspace" data-scroll-key="workspace-${state.view}">${runHeader()}<div class="workspace-body"><section class="workspace-views"><div class="workspace-tabs" role="tablist" aria-label="Workspace view"><button id="agents-tab" role="tab" data-action="workspace-view" data-view="agents" aria-controls="agents-panel" aria-selected="${state.view === 'agents'}">${icon('terminal')}Agents</button><button id="review-tab" role="tab" data-action="workspace-view" data-view="review" aria-controls="review-panel" aria-selected="${state.view === 'review'}">${icon('file-diff')}Review</button></div><section id="agents-panel" role="tabpanel" aria-labelledby="agents-tab" data-workspace-panel="agents" class="review-terminals" ${state.view !== 'agents' ? 'hidden' : ''}><div class="viewport-label"><span class="eyebrow">Agent viewport</span><span>${state.workers.filter((worker) => worker.visible).length} selected terminals</span></div>${terminalGrid()}</section><section id="review-panel" role="tabpanel" aria-labelledby="review-tab" data-workspace-panel="review" ${state.view !== 'review' ? 'hidden' : ''}>${reviewCheckpoint()}</section></section><aside class="run-inbox" aria-label="Run inbox">${runInbox()}</aside></div></section></div>`;
}
function render() {
	rememberScroll();
	rememberFolders();
	terminals.forEach(({ terminal, observer }) => { observer.disconnect(); terminal.dispose(); });
	terminals = [];
	app.innerHTML = ({ A: VariantA, B: VariantB, C: VariantC })[variant]();
	document.querySelector('#variant-label').textContent = `${variant} / ${names[variant]}`;
	document.body.dataset.variant = variant;
	app.dataset.view = state.view;
	for (const tab of app.querySelectorAll('[data-action="workspace-view"]')) tab.tabIndex = tab.dataset.view === state.view ? 0 : -1;
	app.querySelector('.review-layout .rail')?.setAttribute('data-scroll-key', 'sidebar');
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
		if (host.offsetWidth && host.offsetHeight) fit.fit();
		worker.lines.forEach((line, index) => terminal.writeln(index === 0 ? `\x1b[38;2;201;237;106m${line}\x1b[0m` : line.startsWith('PASS') ? `\x1b[38;2;145;221;210m${line}\x1b[0m` : line));
		terminal.scrollToTop();
		worker.input ??= '';
		if (worker.input) terminal.write(worker.input);
		terminal.onData((data) => {
			if (!worker.manual || !['running', 'paused'].includes(state.mode)) return;
			if (data === '\r') {
				worker.lines.push(`> ${worker.input}`, 'Simulated input recorded.');
				terminal.write('\r\nSimulated input recorded.\r\n> ');
				worker.input = '';
			} else if (data === '\u007f') {
				if (worker.input.length) { worker.input = worker.input.slice(0, -1); terminal.write('\b \b'); }
			} else if (/^[\x20-\x7e]+$/.test(data)) {
				worker.input += data;
				terminal.write(data);
			}
		});
		const observer = new ResizeObserver(() => { if (host.offsetWidth && host.offsetHeight) fit.fit(); });
		observer.observe(host);
		terminals.push({ terminal, observer, fit, host });
	}
	for (const region of app.querySelectorAll('[data-scroll-key]')) region.scrollTop = scrollPositions[region.dataset.scrollKey] || 0;
	document.querySelector('#app').dataset.state = JSON.stringify({ viewedInitiative, activeInitiative: 'harness', mode: state.mode, visible: state.workers.filter((worker) => worker.visible).map((worker) => worker.id), workers: state.workers.map(({ id, status, manual }) => ({ id, status, manual })), pending: pendingCount(), integrated: state.integrated, limits: state.limits });
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
	if (action === 'open-review') { switchWorkspace('review'); return; }
	if (action === 'workspace-view') { switchWorkspace(button.dataset.view); return; }
	if (['review-file', 'review-previous', 'review-next', 'clear-file-query'].includes(action)) {
		if (action === 'review-file') state.reviewFile = Number(button.dataset.index);
		if (action === 'clear-file-query') {
			state.fileQuery = '';
			app.querySelector('#checkpoint-search').value = '';
		} else if (action !== 'review-file') {
			const files = matchingFiles();
			const position = files.findIndex((file) => file.index === state.reviewFile);
			const next = files[position + (action === 'review-next' ? 1 : -1)];
			if (next) state.reviewFile = next.index;
		}
		refreshCheckpoint();
		app.querySelector('.checkpoint-file.active')?.scrollIntoView({ block: 'nearest' });
		return;
	}
	if (action === 'record') {
		const initiative = initiativeViews[viewedInitiative];
		const kind = button.dataset.kind;
		const index = Number(button.dataset.index);
		const title = ({ prd: [initiative.prd], story: [initiative.story], issue: initiative.issues, adr: initiative.adrs })[kind][index];
		const worker = viewedInitiative === 'harness' && kind === 'issue' ? state.workers[index] : null;
		dialog.innerHTML = `<div class="eyebrow muted">${kind === 'story' ? 'User story' : kind.toUpperCase()} / simulated record</div><h2>${title}</h2><p>${initiative.title}</p>${worker ? `<p>${worker.issue} / Worker ${worker.id}<br>${labels[worker.status]} / attempt ${worker.id}.1</p><button data-action="show-worker" data-id="${worker.id}">${icon('terminal')}Show terminal</button>` : `<p>${initiative.summary}</p>`}<div class="dialog-actions"><button data-action="close-dialog">Close</button></div>`;
		window.lucide?.createIcons();
		dialog.showModal();
		return;
	}
	if (action === 'active-run') viewedInitiative = 'harness';
	if (action === 'show-worker') {
		state.view = 'agents';
		state.workers.find((worker) => worker.id === button.dataset.id).visible = true;
		dialog.close();
	}
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
	if (action === 'changes') { state.tab = 'changes'; state.view = 'review'; }
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
document.addEventListener('input', (event) => {
	if (event.target.matches('.answer-form [name="answer"]')) state.answerDraft = event.target.value;
	if (event.target.id === 'checkpoint-search') {
		state.fileQuery = event.target.value;
		const files = matchingFiles();
		if (files.length && !files.some((file) => file.index === state.reviewFile)) state.reviewFile = files[0].index;
		refreshCheckpoint();
	}
});
document.addEventListener('change', (event) => {
	if (event.target.id === 'initiative-selector') {
		viewedInitiative = event.target.value;
		render();
		return;
	}
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
		state.answerDraft = '';
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
document.querySelector('#reset-prototype').addEventListener('click', () => { state = initialState(); viewedInitiative = 'harness'; scrollPositions = {}; app.querySelectorAll('[data-scroll-key]').forEach((region) => { region.scrollTop = 0; }); app.querySelectorAll('.checkpoint-files [data-folder]').forEach((folder) => { folder.open = true; }); render(); notify('Simulation reset.'); });
document.addEventListener('keydown', (event) => {
	if (event.target.matches('[data-action="workspace-view"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
		event.preventDefault();
		const view = event.key === 'Home' ? 'agents' : event.key === 'End' ? 'review' : state.view === 'agents' ? 'review' : 'agents';
		switchWorkspace(view);
		app.querySelector(`[data-action="workspace-view"][data-view="${view}"]`).focus();
		return;
	}
	if (event.target.closest('input, textarea, select, [contenteditable], .xterm') || dialog.open) return;
	if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
		event.preventDefault();
		changeVariant(event.key === 'ArrowRight' ? 1 : -1);
	}
});
render();