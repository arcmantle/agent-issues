const workspace = document.querySelector('#merge-workspace');
const sidebar = document.querySelector('#repository-sidebar');
const switcher = document.querySelector('#prototype-switcher');
const dialog = document.querySelector('#merge-dialog');
const issues = [
	{ reference: 'DEMO-03', title: 'Approval checkpoint', branch: 'worker/approval-checkpoint', checkpoint: 'c7b90a2' },
	{ reference: 'DEMO-04', title: 'Serial integration', branch: 'worker/serial-integration', checkpoint: 'a21df06' },
	{ reference: 'DEMO-05', title: 'Restart confirmation', branch: 'worker/restart-confirmation', checkpoint: 'b86f1c4' },
];
const examples = [
	{ requirement: 'Verify the exact approved revision before integration.', retained: 'Require explicit integration approval.', name: 'verifyIntegration', stem: 'approval-checkpoint', operation: 'await verifyApprovedRevision(record);', retainedOperation: 'const approval = await readIntegrationApproval(record);', field: 'revisionVerified: true,', retainedField: 'approved: approval.accepted,', assertion: 'expect(session.revisionVerified).toBe(true);', retainedAssertion: 'expect(session.approved).toBe(true);', status: 'approvalState', good: 'approved', bad: 'outdated' },
	{ requirement: 'Integrate one issue at a time.', retained: 'Require approval for each issue.', name: 'integrateNextIssue', stem: 'serial-integration', operation: 'await acquireIntegrationTurn(record);', retainedOperation: 'const approval = await readIntegrationApproval(record);', field: 'serialTurn: true,', retainedField: 'approved: approval.accepted,', assertion: 'expect(session.serialTurn).toBe(true);', retainedAssertion: 'expect(session.approved).toBe(true);', status: 'integrationState', good: 'serialized', bad: 'concurrent' },
	{ requirement: 'Check restored tracker, Git, and session state before restart.', retained: 'Check shared provider usage before restart.', name: 'checkWorkerRestart', stem: 'restart-confirmation', operation: 'await verifyRestoredState(record);', retainedOperation: 'const usage = await checkSharedUsageLimit(record);', field: 'stateVerified: true,', retainedField: 'usageAllowed: usage.allowed,', assertion: 'expect(session.stateVerified).toBe(true);', retainedAssertion: 'expect(session.usageAllowed).toBe(true);', status: 'restartState', good: 'awaiting-confirmation', bad: 'running' },
];
const phases = {
	review: ['Ready for approval', 'Approve merge', 'check'],
	inspecting: ['Inspecting branches', 'Inspect branches', 'scan-search'],
	conflict: ['Conflicts found', 'Build resolution', 'git-pull-request'],
	resolving: ['Preparing resolution', 'Review resolution', 'file-diff'],
	'resolution-review': ['Resolution needs approval', 'Approve resolution', 'check'],
	checking: ['Checking merge result', 'Run checks', 'flask-conical'],
	failed: ['Required check failed', 'Ask agent to repair', 'wrench'],
	repairing: ['Repairing merge result', 'Review repair', 'file-diff'],
	validated: ['Checks passed', 'Complete integration', 'git-merge'],
	integrated: ['Integrated', null, 'circle-check'],
	stopped: ['Stopped / Changes preserved', 'Resume merge session', 'play'],
};
const variant = 'C';
let selectedIssue = 0;
let targetHead = '6f21bd8';
let integrationCount = 0;
let sessions = issues.map(newSession);
const simulationScenario = new URL(location.href).searchParams.get('scenario');
if (['conflict', 'clean', 'failed'].includes(simulationScenario)) sessions[0].scenario = simulationScenario;
const terminalSessions = new Map();
const harnessThemeStyles = `
.harness-theme-toggle{flex-shrink:0;width:34px;height:34px;padding:7px}
.application-navigation :is(.harness-theme-toggle,.harness-reset){align-self:center;width:44px;height:44px}
@media(max-width:1150px){.harness-theme-toggle{width:44px;height:44px}}
:root[data-harness-theme="dark"]{color-scheme:dark;--canvas:#16181c;--surface:#202328;--subtle:#292d33;--ink:#e7e9ed;--muted:#a9b1bb;--border:#3c424b;--accent:#80d7ad;--green:#80d7ad;--green-light:#263d34;--warning:#e7bd6e;--warning-surface:#3b3124;--amber:#e7bd6e;--danger:#f09090;--red:#f09090;--terminal:#16191d;color:var(--ink);background:var(--canvas)}
:root[data-harness-theme="dark"] body{color:var(--ink);background:var(--canvas)}
:root[data-harness-theme="dark"] :is(.review-layout,.workspace,.run-header,.workspace-tabs,.workspace-header,.run-inbox,dialog,.terminal-panel,.terminal-header,.terminal-meta,.terminal-footer,.code-grid,.diff-scroll,.diff-pane,.agent-conversation,.merge-view-tabs,.file-tabs,.changes,.merge-context-popover,.resolution-evidence){color:var(--ink);border-color:var(--border);background:var(--surface)}
:root[data-harness-theme="dark"] :is(.rail,.application-navigation,.prototype-notice,.branch-strip,.repository-sidebar,.app-navigation,.desk-agent,.viewport-label,.agent-selection,.file-heading,.diff-pane header,.code-pane header,.diff-line-number){color:var(--muted);border-color:var(--border);background:var(--subtle)}
:root[data-harness-theme="dark"] :is(button,input,textarea,select){color:var(--ink);border-color:var(--border);background:var(--surface)}
:root[data-harness-theme="dark"] button:hover:not(:disabled){border-color:#728b80;background:var(--subtle)}
:root[data-harness-theme="dark"] :is(.primary,.primary:hover:not(:disabled)){color:#f1fff8;border-color:#3c8a68;background:#2f7359;--compact-surface:#2f7359;--compact-border:#3c8a68}
:root[data-harness-theme="dark"] :is(.run-actions,.page-heading,.tablet-drawer-header) button:not(.primary){--compact-surface:var(--surface);--compact-border:var(--border)}
:root[data-harness-theme="dark"] :is(.route-issue.ready,.route-issue.integrated,.queue-item.selected,.file-tabs button[aria-pressed="true"]){background:var(--green-light)}
:root[data-harness-theme="dark"] :is(dialog p,.record-section p,.run-subtitle,.workspace-header p,.action-panel p,.terminal-status,.terminal-ownership,.terminal-meta,.terminal-footer,.message p,.line-number,.phase-badge){color:var(--muted)}
:root[data-harness-theme="dark"] :is(.terminal-host,.merge-terminal-host,.code-pane pre,.diff-scroll pre){color:var(--ink);background:var(--terminal)}
:root[data-harness-theme="dark"] :is(.phase-badge,.message.agent,.target-code header,.conflict-hunk,.conflict-line){color:var(--amber);background:var(--warning-surface)}
:root[data-harness-theme="dark"] :is(.result-code header,.result-code pre,.resolved-line){color:var(--green);background:var(--green-light)}
:root[data-harness-theme="dark"] .check-error{color:var(--red);background:#3d282b}
:root[data-harness-theme="dark"] :is(.diff-removed,.diff .removed){color:#ffc3bf;background:#422a2f}
:root[data-harness-theme="dark"] :is(.diff-added,.diff .added){color:#a7edc4;background:#233f31}
:root[data-harness-theme="dark"] .diff-empty{background:repeating-linear-gradient(135deg,#24282e,#24282e 4px,#30353d 4px,#30353d 5px)}
:root[data-harness-theme="dark"] dialog::backdrop{background:rgb(0 0 0 / 55%)}
`;

function harnessTerminalTheme(theme) {
	return theme === 'dark'
		? { background: '#16191d', foreground: '#dfe5e2', cursor: '#80d7ad', selectionBackground: '#345447' }
		: { background: '#f6f7f6', foreground: '#445149', cursor: '#245c48', selectionBackground: '#dce9e2' };
}
function applyPrototypeColors(targetDocument, theme) {
	targetDocument.documentElement.dataset.harnessTheme = theme;
	if (targetDocument.querySelector('#harness-theme-style')) return;
	const style = targetDocument.createElement('style');
	style.id = 'harness-theme-style';
	style.textContent = harnessThemeStyles;
	targetDocument.head.append(style);
}
function applyPrototypeTheme(theme) {
	applyPrototypeColors(document, theme);
	const palette = harnessTerminalTheme(theme);
	for (const { terminal } of terminalSessions.values()) {
		if (terminal.options.theme.background !== palette.background) terminal.options.theme = palette;
	}
}

function newSession() {
	return { phase: 'review', scenario: 'conflict', file: 0, strategy: 'combine', paused: false, previousPhase: null, repaired: false, revised: false, approved: false, revision: 1, draft: '', messages: [], checks: 'pending', targetBase: targetHead, targetChanged: false, integrationHead: null, events: [] };
}
function session() { return sessions[selectedIssue]; }
function icon(name) { return `<i data-lucide="${name}" aria-hidden="true"></i>`; }
function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function activeMerge() { return sessions.findIndex((item) => !['review', 'integrated', 'stopped'].includes(item.phase)); }
function message(role, text) { session().messages.push({ role, text }); }
function isResolution() { return ['resolution-review', 'checking', 'failed', 'repairing', 'validated', 'integrated'].includes(session().phase === 'stopped' ? session().previousPhase : session().phase); }
function example() { return examples[selectedIssue]; }
function filePaths() { return [`src/runner/${example().stem}.ts`, `tests/${example().stem}.test.ts`, `src/runner/${example().stem}-options.ts`, `docs/${example().stem}.md`]; }
function filePath() { return filePaths()[session().file]; }
function hasConflict() { return session().scenario !== 'clean' && session().file < 2; }
function branchCode(branch) {
	const fixture = example();
	if (session().scenario === 'clean' && branch === 'source') return branchCode('result');
	if (session().file >= 2) return branch === 'target' ? '(File not present on the initiative branch)' : session().file === 2 ? `export const options = {\n  requireApproval: true,\n  preserveExistingPolicy: true,\n};` : `# ${issues[selectedIssue].title}\n\n${fixture.requirement}\n${fixture.retained}\n\nDependent work waits for checked integration.`;
	if (session().file === 1) {
		const assertions = branch === 'target' ? [fixture.retainedAssertion] : branch === 'source' ? [fixture.assertion] : [fixture.retainedAssertion, fixture.assertion, `expect(session.${fixture.status}).toBe('${fixture.good}');`];
		if (branch === 'result' && session().revised) assertions.push(`expect(session.${fixture.status}).not.toBe('${fixture.bad}');`);
		return `it('preserves both requirements', async () => {\n  const session = await ${fixture.name}(record);\n${assertions.map((assertion) => `  ${assertion}`).join('\n')}\n});`;
	}
	const operations = branch === 'target' ? [fixture.retainedOperation] : branch === 'source' ? [fixture.operation] : [fixture.operation, fixture.retainedOperation];
	const fields = branch === 'target' ? [fixture.retainedField, `${fixture.status}: '${fixture.bad}',`] : branch === 'source' ? [fixture.field, `${fixture.status}: '${fixture.bad}',`] : [fixture.retainedField, fixture.field, `${fixture.status}: '${session().scenario === 'failed' && !session().repaired ? fixture.bad : fixture.good}',`];
	return `async function ${fixture.name}(record) {\n${operations.map((operation) => `  ${operation}`).join('\n')}\n  return {\n    ...record,\n${fields.map((field) => `    ${field}`).join('\n')}\n  };\n}`;
}
function fileControls() {
	const inspected = !['review', 'inspecting'].includes(session().phase);
	return `<div class="file-tabs" role="group" aria-label="Changed files">${filePaths().map((path, index) => { const conflict = inspected && session().scenario !== 'clean' && index < 2; const status = conflict ? isResolution() ? 'Resolved' : 'Conflict' : inspected ? 'Clean' : 'Not inspected'; return `<button data-action="file" data-value="${index}" title="${escapeHtml(path)}" aria-pressed="${session().file === index}">${icon(conflict ? 'git-merge' : 'file-plus-2')}<span>${escapeHtml(path)}</span><span class="file-status">${status}</span></button>`; }).join('')}</div>`;
}
function codePane(title, branch, tone = '') {
	const lines = branchCode(branch).split('\n');
	const marked = hasConflict() && !['review', 'inspecting'].includes(session().phase);
	const targetLines = new Set(branchCode('target').split('\n').map((line) => line.trim()));
	const sourceLines = new Set(branchCode('source').split('\n').map((line) => line.trim()));
	const code = lines.map((line, index) => {
		const unchanged = branch === 'target' ? sourceLines.has(line.trim()) : branch === 'source' ? targetLines.has(line.trim()) : targetLines.has(line.trim()) && sourceLines.has(line.trim());
		return `<span class="code-line ${marked && !unchanged ? branch === 'result' ? 'resolved-line' : 'conflict-line' : ''}"><span class="line-number" aria-hidden="true">${index + 1}</span><span>${escapeHtml(line) || ' '}</span></span>`;
	}).join('');
	return `<section class="code-pane ${tone}" aria-label="${title}"><header><strong>${title}</strong><span class="mono">${branch === 'target' ? session().targetBase : branch === 'source' ? issues[selectedIssue].checkpoint : `resolution-r${session().revision}`}</span></header><pre><code>${code}</code></pre></section>`;
}
function changes(split = false) {
	const resolved = isResolution();
	const inspected = !['review', 'inspecting'].includes(session().phase);
	const conflict = inspected && hasConflict();
	const explanation = conflict ? session().file === 0 ? 'Both branches replace the same return block. Keeping only one branch removes a required behavior.' : 'Both branches replace the same test block. The agent retains both assertions and adds the result-state assertion.' : session().file >= 2 ? 'New file from the issue branch. Included without a competing initiative change.' : inspected ? 'Non-overlapping changes combined cleanly. Required checks still apply.' : 'Inspection pending. These branch versions do not yet indicate a detected conflict.';
	const hunk = conflict ? `<details class="conflict-hunk"><summary>Original Git conflict / overlapping block</summary><pre>${escapeHtml(`<<<<<<< harness/initiative\n${branchCode('target')}\n=======\n${branchCode('source')}\n>>>>>>> ${issues[selectedIssue].branch}`)}</pre></details>` : '';
	return `<section class="changes" aria-label="Merge changes"><div class="section-heading"><h2>${resolved ? 'Resolution comparison' : 'Changed files'}</h2><span class="muted">4 files / ${!inspected ? 'inspection pending' : session().scenario === 'clean' ? '0 conflicts' : resolved ? '2 resolved / 0 unresolved' : '2 conflicts / 2 clean'}</span></div>${fileControls()}<div class="file-heading mono">${escapeHtml(filePath())}</div><div class="file-explanation"><strong>${conflict ? 'Why these changes conflict' : 'File status'}</strong><p>${explanation}</p>${resolved && conflict ? '<p class="success-text">Agent result: preserve both requirements. Amber marks the competing blocks; green marks the combined result.</p>' : ''}</div>${hunk}<div class="code-grid ${split ? 'split' : ''}">${split || !resolved ? codePane('Initiative / before merge', 'target', 'target-code') : ''}${split || !resolved ? codePane('Issue / approved change', 'source', 'source-code') : ''}${resolved ? codePane(session().phase === 'integrated' ? 'Integrated result' : 'Proposed result', 'result', 'result-code') : ''}</div></section>`;
}
function mergeSummary() {
	const proposal = session().phase === 'review' ? 'Inspect all four files against the current initiative branch.' : session().scenario === 'clean' ? 'No overlapping changes. Retain both requirements and check the merged result.' : 'Combine the two competing blocks. Retain both requirements and include the two clean additions.';
	return `<section class="merge-summary" aria-label="Merge requirements"><div class="section-heading"><h2>Required result</h2><span class="mono">${issues[selectedIssue].reference}</span></div><dl><div><dt>Add from this issue</dt><dd>${example().requirement}</dd></div><div><dt>Keep from the initiative</dt><dd>${example().retained}</dd></div><div><dt>Agent proposal</dt><dd>${proposal}</dd></div></dl><p class="muted">Target ${session().targetBase}. ${session().phase === 'integrated' ? 'Dependent work released. Final merge to main awaits separate approval.' : 'Branch update waits for approval and passing checks.'}</p></section>`;
}
function evidenceTimeline() {
	return `<section class="merge-history" aria-label="Merge activity"><div class="section-heading"><h2>Merge activity</h2><span class="muted">${session().events.length} events</span></div>${session().events.length ? `<ol>${session().events.map((entry, index) => `<li><span class="mono">${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(entry.title)}</strong><p>${escapeHtml(entry.detail)}</p></div></li>`).join('')}</ol>` : '<p class="muted">Worker checks and independent review passed. Merge approval pending.</p>'}</section>`;
}
function progress(vertical = false) {
	const phase = session().phase;
	const step = phase === 'review' ? -1 : ['inspecting', 'conflict'].includes(phase) ? 0 : ['resolving', 'resolution-review', 'repairing'].includes(phase) ? 1 : ['checking', 'failed', 'validated'].includes(phase) ? 2 : phase === 'integrated' ? 4 : 0;
	return `<ol class="progress ${vertical ? 'vertical' : ''}" aria-label="Merge progress">${[['Inspect', 'scan-search'], ['Resolve', 'git-pull-request'], ['Check', 'flask-conical'], ['Integrate', 'git-merge']].map(([name, symbol], index) => `<li class="${index < step ? 'done' : index === step ? 'current' : ''}" ${index === step ? 'aria-current="step"' : ''}>${icon(index < step ? 'check' : symbol)}<span>${name}</span></li>`).join('')}</ol>`;
}
function checks() {
	const result = session().checks;
	const failedIndex = session().strategy === 'source' ? 2 : 1;
	const failure = `File: ${filePaths()[1]}\nExpected ${example().good}; received ${example().bad}.\nInitiative branch unchanged. Integration blocked.`;
	return `<section class="checks" aria-label="Validation results"><div class="section-heading"><h2>Merge checks</h2><span class="muted">${result === 'pending' ? 'Not run' : result === 'failed' ? '2 passed / 1 failed' : '3 passed'}</span></div><p class="muted mono">resolution-r${session().revision} / target ${session().targetBase}</p>${['Type check', `${issues[selectedIssue].title} tests`, 'Initiative regression tests'].map((name, index) => { const failed = result === 'failed' && index === failedIndex; return `<div class="check-row"><span>${icon(result === 'pending' ? 'circle-dashed' : failed ? 'circle-x' : 'circle-check')}${name}</span><strong class="${failed ? 'danger-text' : result === 'passed' ? 'success-text' : 'muted'}">${result === 'pending' ? 'Not run' : failed ? 'Failed' : 'Passed'}</strong></div>`; }).join('')}${result === 'failed' ? `<pre class="check-error">${failure}</pre>` : ''}</section>`;
}
function conversation(compact = false) {
	if (variant === 'C') {
		const current = session();
		const blocked = current.paused || ['review', 'integrated', 'stopped'].includes(current.phase) || (activeMerge() !== -1 && activeMerge() !== selectedIssue);
		return `<section class="agent-conversation terminal-session" aria-label="Resolution agent terminal"><div class="section-heading"><h2>${icon('terminal')}Resolution agent</h2><span class="agent-provider">Copilot CLI / simulated</span></div><div class="terminal-ownership"><span>${current.manual ? 'Input owner / You' : 'Input owner / Agent'}</span><button data-action="terminal-control" ${blocked ? 'disabled' : ''}>${icon(current.manual ? 'bot' : 'keyboard')}${current.manual ? 'Return control' : 'Take control'}</button></div><div class="merge-terminal-mount"></div><p class="terminal-status">${blocked ? 'Terminal input unavailable in this state.' : current.manual ? 'Input routed to the simulated CLI session.' : 'Agent owns input. Waiting at the result approval checkpoint.'}</p></section>`;
	}
	const messages = session().messages.length ? session().messages : [{ role: 'agent', text: 'I will inspect the approved issue against the current initiative branch. No merge session has started.' }];
	return `<section class="agent-conversation ${compact ? 'compact' : ''}" aria-label="Merge agent conversation"><div class="section-heading"><h2>${icon('bot')}Merge agent</h2><span class="agent-provider">Copilot</span></div><div class="messages" role="log" aria-label="Agent messages">${messages.map((item) => `<article class="message ${item.role}"><header>${item.role === 'user' ? 'You' : 'Merge agent'}<span>${item.role === 'user' ? icon('user-round') : icon('bot')}</span></header><p>${escapeHtml(item.text)}</p></article>`).join('')}</div><form id="agent-message"><label class="sr-only" for="agent-draft">Message merge agent</label><textarea id="agent-draft" name="message" rows="2" placeholder="Message merge agent" ${['review', 'integrated', 'stopped'].includes(session().phase) || session().paused ? 'disabled' : ''}>${escapeHtml(session().draft)}</textarea><button type="submit" class="icon-button" aria-label="Send message" title="Send message" ${['review', 'integrated', 'stopped'].includes(session().phase) || session().paused ? 'disabled' : ''}>${icon('send')}</button></form></section>`;
}
function resolutionOptions() {
	return '';
}
function mountResolutionTerminal() {
	const mount = workspace.querySelector('.merge-terminal-mount');
	if (!mount) return;
	const current = session();
	let record = terminalSessions.get(current);
	if (!window.Terminal || !window.FitAddon) {
		mount.innerHTML = '<p role="alert">Terminal library unavailable. Reload after restoring network access.</p>';
		return;
	}
	if (!record) {
		const host = document.createElement('div');
		host.className = 'merge-terminal-host';
		const terminal = new window.Terminal({ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, lineHeight: 1.45, convertEol: true, scrollback: 1000, theme: harnessTerminalTheme(document.documentElement.dataset.harnessTheme) });
		const fit = new window.FitAddon.FitAddon();
		terminal.loadAddon(fit);
		mount.append(host);
		terminal.open(host);
		terminal.writeln('Copilot CLI / resolution session / simulated');
		terminal.writeln('No CLI process, provider call, or Git write.');
		terminal.writeln('');
		const observer = new ResizeObserver(() => { if (host.clientWidth && host.clientHeight) fit.fit(); });
		observer.observe(host);
		record = { host, terminal, fit, observer, printed: 0, prompt: false };
		terminalSessions.set(current, record);
		terminal.onData((data) => {
			if (session() !== current || !current.manual || current.paused || ['review', 'integrated', 'stopped'].includes(current.phase) || (activeMerge() !== -1 && activeMerge() !== selectedIssue)) return;
			if (data.includes('\x1b')) return;
			for (const character of Array.from(data.replace(/\r\n/g, '\r').replace(/\n/g, '\r'))) {
			if (character === '\r') {
				const input = current.draft;
				if (!input.trim()) continue;
				terminal.write('\r\n');
				current.draft = '';
				record.prompt = false;
				message('user', input);
				record.printed += 1;
				if (current.phase === 'resolution-review' && /re.?evaluat|reconsider|check|why|review|revise/i.test(input)) {
					current.revision += 1;
					current.revised = true;
					current.repaired = true;
					current.approved = false;
					current.checks = 'pending';
					current.events.push({ title: 'CLI re-evaluation request', detail: `Prepared simulated resolution-r${current.revision}; fresh approval required.` });
					message('agent', `I reconsidered the example result. Both requirements remain necessary. I added an explicit assertion against ${example().bad} in resolution-r${current.revision}. Inspect the updated test. Approval remains unset. This response is simulated.`);
				} else message('agent', 'Input recorded in this simulated CLI session. No command was executed. The result and approval are unchanged.');
				render();
				terminal.focus();
			} else if (character === '\u007f') {
				if (current.draft.length) { current.draft = Array.from(current.draft).slice(0, -1).join(''); terminal.write('\r\n> ' + current.draft); }
			} else if (!/[\x00-\x1f\x7f]/.test(character)) { current.draft += character; terminal.write(character); }
			}
		});
	} else mount.append(record.host);
	if (record.host.clientWidth && record.host.clientHeight) record.fit.fit();
	if (record.printed < current.messages.length) {
		if (record.prompt) { record.terminal.write('\r\n'); record.prompt = false; }
		for (const entry of current.messages.slice(record.printed)) {
			record.terminal.writeln(entry.role === 'user' ? '> ' + entry.text.replace(/[\x00-\x1f\x7f]/g, '') : entry.text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ''));
			record.terminal.writeln('');
		}
		record.printed = current.messages.length;
	}
	if (current.manual && !record.prompt) { record.terminal.write('> ' + current.draft); record.prompt = true; }
	if (!current.manual && record.prompt) { record.terminal.write('\r\n'); record.prompt = false; }
	record.terminal.options.cursorBlink = Boolean(current.manual && !current.paused);
}
function disposeResolutionTerminal(current) {
	const record = terminalSessions.get(current);
	if (!record) return;
	record.observer.disconnect();
	record.terminal.dispose();
	terminalSessions.delete(current);
}
function isRunBlocked() {
	return connectedInitiative && !window.parent.canIntegrateHarnessIssue?.();
}
function actionPanel(compact = false) {
	const current = session();
	const phase = current.phase;
	const busyOther = isRunBlocked() || activeMerge() !== -1 && activeMerge() !== selectedIssue;
	const status = current.paused ? 'Merge session paused' : phases[phase][0];
	const detail = { review: 'Worker checks and independent review passed. Issue approval starts the merge agent.', 'resolution-review': `The agent resolved two overlapping files and included two clean additions. Approve resolution-r${current.revision}, or request a revision. Required checks have not run on this result.`, failed: `A required check failed: expected ${example().good}, received ${example().bad}. The branch is unchanged. Ask the agent to repair the result.`, integrated: 'The approved result passed checks and was integrated. Dependent work is released. Final merge to main still needs separate approval.', stopped: 'The session is stopped. Changes and evidence are preserved.' }[phase] || 'The merge agent is working on the current checkpoint.';
	const actions = `${phases[phase][1] ? `<button class="primary" data-action="advance" ${current.paused || busyOther ? 'disabled' : ''}>${icon(phases[phase][2])}${phases[phase][1]}</button>` : `<span class="success-text">Integration recorded / ${current.integrationHead}</span>`}${phase === 'resolution-review' ? `<button data-action="revision" ${current.paused || busyOther ? 'disabled' : ''}>${icon('message-square')}Request revision</button>` : ''}${phase === 'failed' ? `<button data-action="manual" ${current.paused || busyOther ? 'disabled' : ''}>${icon('pencil')}Manual resolution</button>` : ''}`;
	if (compact) return `<div class="header-merge-actions" role="group" aria-label="Merge actions">${actions}</div>`;
	return `<section class="action-panel" aria-label="Merge session state"><div class="state-label">${icon(phases[phase][2])}<strong>${status}</strong></div><p>${detail}</p>${busyOther ? '<p class="warning-text">Another issue merge is active. This session must wait.</p>' : ''}<div class="action-buttons">${actions}</div><dl class="session-facts"><div><dt>Result approval</dt><dd>${current.approved ? `Recorded / r${current.revision}` : 'Not recorded'}</dd></div><div><dt>Initiative branch</dt><dd>${phase === 'integrated' ? 'Updated' : 'Unchanged'}</dd></div><div><dt>Dependent work</dt><dd>${phase === 'integrated' ? 'Unblocked' : 'Waiting for integration'}</dd></div></dl></section>`;
}
function VariantA() {
	return `<div class="merge-desk"><div class="desk-review">${progress()}${mergeSummary()}${changes(true)}${checks()}${evidenceTimeline()}</div><aside class="desk-agent">${actionPanel()}${conversation()}</aside></div>`;
}
function VariantB() {
	return `<div class="conversation-layout"><div class="conversation-main">${progress()}${actionPanel()}${mergeSummary()}${conversation()}${evidenceTimeline()}</div><aside class="evidence-sidebar"><div class="section-heading"><h2>Merge evidence</h2><span class="mono">r${session().revision}</span></div>${changes(true)}${checks()}</aside></div>`;
}
function fullFileCode(branch) {
	const code = branchCode(branch);
	if (session().file >= 2) return code;
	const before = Array.from({ length: 48 }, (_, index) => session().file === 0 ? `function canResumeCheckpoint${index + 1}(checkpoint) {\n  return checkpoint.worktreeVerified\n    && checkpoint.approvalRecorded;\n}\n` : `it('keeps checkpoint ${index + 1} isolated', () => {\n  expect(checkpoints[${index}].worktree).toBeDefined();\n});\n`).join('\n');
	const after = Array.from({ length: 40 }, (_, index) => session().file === 0 ? `function canSendInput${index + 1}(record, owner) {\n  return record.inputOwner === owner\n    && record.status !== 'stopped';\n}\n` : `it('records attempt ${index + 1}', () => {\n  expect(attempts[${index}].checkpoint).toBeDefined();\n});\n`).join('\n');
	const expectedState = branch === 'result' || session().scenario === 'clean' && branch === 'source' ? session().scenario === 'failed' && !session().repaired ? example().bad : example().good : example().bad;
	return `${before}\n${code}\n\n${after}\nexport const expectedState = '${expectedState}';`;
}
function diffRows() {
	const branch = isResolution() ? session().comparison || 'target' : 'target';
	const left = session().file >= 2 && branch === 'target' ? [] : fullFileCode(branch).split('\n');
	const right = fullFileCode(isResolution() ? 'result' : 'source').split('\n');
	if (!window.Diff) return null;
	const parts = window.Diff.diffArrays(left, right);
	const rows = [];
	let leftNumber = 0;
	let rightNumber = 0;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (!part.added && !part.removed) {
			for (const text of part.value) rows.push({ left: text, right: text, leftNumber: ++leftNumber, rightNumber: ++rightNumber, changed: false });
			continue;
		}
		const removed = part.removed ? part.value : [];
		let added = part.added ? part.value : [];
		if (part.removed && parts[index + 1]?.added) added = parts[++index].value;
		for (let offset = 0; offset < Math.max(removed.length, added.length); offset += 1) rows.push({ left: removed[offset], right: added[offset], leftNumber: offset < removed.length ? ++leftNumber : null, rightNumber: offset < added.length ? ++rightNumber : null, changed: true });
	}
	return { rows, leftCount: left.length, rightCount: right.length };
}
function fullDiffView() {
	const diff = diffRows();
	if (!diff) return '<p role="alert">Diff library unavailable. Reload after restoring network access.</p>';
	const changes = diff.rows.reduce((count, row, index) => count + Number(row.changed && !diff.rows[index - 1]?.changed), 0);
	const resolved = isResolution();
	const comparison = resolved ? session().comparison || 'target' : 'target';
	const scrollKey = `${session().file}:${comparison}`;
	const changeIndex = session().diffPositions?.[`${scrollKey}:left`]?.changeIndex ?? -1;
	const resultLabel = session().phase === 'integrated' ? 'Integrated result' : resolved ? 'Proposed resolution' : 'Issue / pending inspection';
	const pane = (side) => `<section class="full-diff-pane" aria-label="${side === 'left' ? 'Original file' : 'Result file'}"><header><strong>${side === 'left' ? comparison === 'source' ? 'Issue / approved change' : 'Initiative / before merge' : resultLabel}</strong><span class="mono">${side === 'left' ? comparison === 'source' ? issues[selectedIssue].checkpoint : session().targetBase : session().phase === 'integrated' ? session().integrationHead : resolved ? `r${session().revision}` : issues[selectedIssue].checkpoint}</span>${side === 'left' && !diff.leftCount ? '<span>File not present</span>' : ''}</header><div class="diff-scroll" data-scroll-key="${scrollKey}:${side}" data-change-index="${changeIndex}" tabindex="0" aria-label="${side === 'left' ? 'Original' : 'Result'} file scroll"><pre>${diff.rows.map((row, index) => `<span class="diff-row ${row[side] === undefined ? 'diff-empty' : row.changed ? side === 'left' ? 'diff-removed' : 'diff-added' : ''}" data-row="${index}" ${row.changed && !diff.rows[index - 1]?.changed ? 'data-change="true"' : ''}><span class="diff-line-number">${row[`${side}Number`] || ''}</span><span class="diff-sign" aria-hidden="true">${row.changed && row[side] !== undefined ? side === 'left' ? '-' : '+' : ' '}</span><code>${row[side] === undefined ? ' ' : escapeHtml(row[side]) || ' '}</code></span>`).join('')}</pre></div></section>`;
	const comparisonControls = resolved ? `<div class="comparison-controls" role="group" aria-label="Compare resolution"><button data-action="comparison" data-value="target" aria-label="Initiative / Result" title="Compare Initiative with Result" aria-pressed="${comparison === 'target'}">Initiative</button><button data-action="comparison" data-value="source" aria-label="Issue / Result" title="Compare Issue with Result" aria-pressed="${comparison === 'source'}">Issue</button></div>` : '<span>Initiative / Issue</span>';
	return `<div class="full-diff-view"><aside class="diff-file-list"><div class="section-heading"><h2>Changed files</h2><span>4</span></div>${fileControls()}<div class="diff-resolution-note"><strong>${resolved ? resultLabel : 'Required result'}</strong><p>${example().retained}</p><p>${example().requirement}</p><p>${resolved ? hasConflict() ? 'Both requirements retained in the result.' : 'Clean file included in the result.' : 'No resolution prepared.'}</p></div></aside><section class="diff-document"><div class="diff-toolbar"><div class="diff-path"><strong class="mono">${escapeHtml(filePath())}</strong><span>${diff.leftCount} / ${diff.rightCount} lines / ${changes} change groups</span></div>${comparisonControls}<div class="change-navigation"><button class="icon-button" data-action="diff-previous" title="Previous change" aria-label="Previous change" ${changes ? '' : 'disabled'}>${icon('arrow-up')}</button><span class="diff-change-position">${changeIndex < 0 ? `${changes} changes` : `${changeIndex + 1} / ${changes}`}</span><button class="icon-button" data-action="diff-next" title="Next change" aria-label="Next change" ${changes ? '' : 'disabled'}>${icon('arrow-down')}</button></div></div><div class="full-diff-grid">${pane('left')}${pane('right')}</div></section></div>`;
}
function VariantC() {
	const diffs = session().mergeView === 'diffs';
	const queue = embedded ? `<nav class="merge-queue" aria-label="Issue merge sessions">${issues.map((issue, index) => `<button data-action="issue" data-value="${index}" aria-pressed="${selectedIssue === index}" ${connectedInitiative && index > 0 ? 'disabled title="Waiting for a worker checkpoint"' : ''}>${issue.reference}<span>${connectedInitiative && index > 0 ? 'Waiting for work' : sessions[index].phase === 'integrated' ? 'Integrated' : index === activeMerge() ? 'Active' : sessions[index].phase === 'review' ? 'Awaiting approval' : 'Waiting'}</span></button>`).join('')}</nav>` : '';
	return `<div class="merge-view-shell"><div class="merge-navigation"><nav class="merge-view-tabs" role="tablist" aria-label="Merge session view"><button id="merge-agent-view" role="tab" aria-selected="${!diffs}" aria-controls="merge-agent-panel" tabindex="${diffs ? -1 : 0}" data-action="merge-view" data-value="agent">${icon('terminal')}Agent</button><button id="merge-diffs-view" role="tab" aria-selected="${diffs}" aria-controls="merge-diffs-panel" tabindex="${diffs ? 0 : -1}" data-action="merge-view" data-value="diffs">${icon('file-diff')}Diffs</button></nav>${queue}</div><section id="merge-agent-panel" role="tabpanel" aria-labelledby="merge-agent-view" ${diffs ? 'hidden' : ''}><div class="resolution-layout chat-led"><div class="resolution-conversation">${conversation()}</div><aside class="resolution-evidence">${mergeSummary()}${checks()}<details class="activity-details"><summary>Merge activity</summary>${evidenceTimeline()}</details></aside></div></section><section id="merge-diffs-panel" role="tabpanel" aria-labelledby="merge-diffs-view" ${diffs ? '' : 'hidden'}>${diffs ? fullDiffView() : ''}</section></div>`;
}
let renderedSession;
function render(focusAction) {
	const current = session();
	if (renderedSession) {
		renderedSession.contextOpen = workspace.querySelector('.merge-context-details')?.open ?? renderedSession.contextOpen;
		renderedSession.diffPositions ??= {};
		for (const region of workspace.querySelectorAll('.diff-scroll')) renderedSession.diffPositions[region.dataset.scrollKey] = { top: region.scrollTop, left: region.scrollLeft, changeIndex: Number(region.dataset.changeIndex) };
	}
	renderedSession = current;
	document.body.dataset.variant = variant;
	workspace.dataset.phase = current.phase;
	sidebar.innerHTML = `<div class="repository-identity"><div class="repository-title">${icon('folder-git-2')}<strong>agent-issues</strong><a href="/?variant=C&page=project-settings" class="icon-button" aria-label="Project Settings" title="Project Settings">${icon('settings-2')}</a></div><p class="mono">~/Developer/Personal/agent-issues</p><p>Project / agent-issues</p><p>Tenant / local-roen</p></div><section class="queue"><div class="section-heading"><h2>Integration queue</h2><span>${sessions.filter((item) => item.phase !== 'integrated').length}</span></div>${issues.map((issue, index) => `<button data-action="issue" data-value="${index}" class="queue-item ${index === selectedIssue ? 'selected' : ''}" aria-pressed="${index === selectedIssue}"><span class="queue-reference">${issue.reference}${icon(sessions[index].phase === 'integrated' ? 'circle-check' : index === activeMerge() ? 'bot' : 'circle-dashed')}</span><strong>${issue.title}</strong><small>${sessions[index].phase === 'review' ? 'Awaiting approval' : phases[sessions[index].phase][0]}</small></button>`).join('')}</section><div class="worker-summary"><span class="live-dot"></span><strong>2 issue workers running</strong><p>Overlapping files / Separate worktrees</p></div>`;
	workspace.innerHTML = `<header class="workspace-header"><div><a class="back-link" href="/?variant=C&page=workspace">${icon('arrow-left')}Workspace / Review</a><h1>${current.phase === 'review' ? 'Issue merge approval' : 'Merge session'}</h1><p>${issues[selectedIssue].reference} <span class="muted">/</span> ${issues[selectedIssue].title}</p></div><div class="session-controls"><span class="phase-badge">${current.paused ? 'Paused' : phases[current.phase][0]}</span>${!['review', 'integrated', 'stopped'].includes(current.phase) ? `<button class="icon-button" data-action="pause" aria-label="${current.paused ? 'Resume' : 'Pause'} merge agent" title="${current.paused ? 'Resume' : 'Pause'} merge agent">${icon(current.paused ? 'play' : 'pause')}</button><button class="icon-button" data-action="stop" aria-label="Stop merge agent" title="Stop merge agent">${icon('square')}</button>` : ''}</div></header><div class="branch-strip"><span>${icon('git-branch')}<span class="mono">${issues[selectedIssue].branch}</span></span>${icon('arrow-right')}<span>${icon('git-merge')}<strong class="mono">harness/initiative</strong></span><span class="checkpoint-label mono">${issues[selectedIssue].checkpoint} / merge-r${current.revision}</span></div><div class="variant-content">${({ A: VariantA, B: VariantB, C: VariantC })[variant]()}</div>`;
	if (embedded && variant !== 'C') workspace.querySelector('.branch-strip').insertAdjacentHTML('afterend', `<nav class="merge-queue" aria-label="Issue merge sessions">${issues.map((issue, index) => `<button data-action="issue" data-value="${index}" aria-pressed="${selectedIssue === index}">${issue.reference}<span>${sessions[index].phase === 'integrated' ? 'Integrated' : index === activeMerge() ? 'Active' : 'Waiting'}</span></button>`).join('')}</nav>`);
		if (variant === 'C') {
			const header = workspace.querySelector('.workspace-header');
			header.classList.add('compact-merge-header');
			header.firstElementChild.className = 'merge-heading';
			header.firstElementChild.innerHTML = `<a class="back-link icon-button" href="/?variant=C&page=workspace" aria-label="Return to Review" title="Return to Review">${icon('arrow-left')}</a><div class="merge-context"><h1 title="${escapeHtml(issues[selectedIssue].title)}">${issues[selectedIssue].reference} / ${issues[selectedIssue].title}</h1><details class="merge-context-details" ${current.contextOpen ? 'open' : ''}><summary title="Branch and checkpoint details">${icon('git-branch')}<span class="mono">${issues[selectedIssue].branch} / harness/initiative</span>${icon('chevron-down')}</summary><div class="merge-context-popover"><dl><div><dt>Issue branch</dt><dd class="mono">${issues[selectedIssue].branch}</dd></div><div><dt>Initiative branch</dt><dd class="mono">harness/initiative</dd></div><div><dt>Issue checkpoint</dt><dd class="mono">${issues[selectedIssue].checkpoint}</dd></div><div><dt>Target checkpoint</dt><dd class="mono">${current.targetBase}</dd></div><div><dt>Result revision</dt><dd class="mono">r${current.revision}</dd></div></dl></div></details></div>`;
			workspace.querySelector('.branch-strip').remove();
			workspace.querySelector('.session-controls').insertAdjacentHTML('afterbegin', actionPanel(true));
			if (isRunBlocked()) workspace.querySelector('.phase-badge').textContent = 'Integration blocked';
			else if (current.phase === 'resolution-review' && !current.paused) workspace.querySelector('.phase-badge').remove();
			const revisionButton = workspace.querySelector('[data-action="revision"]');
			if (revisionButton) revisionButton.remove();
		}
	switcher.setAttribute('aria-label', 'Simulation controls');
	switcher.innerHTML = `<button class="icon-button" popovertarget="scenario-menu" aria-label="Simulation scenario" title="Simulation scenario">${icon('git-pull-request')}</button><div id="scenario-menu" popover><h2>Simulation scenario</h2>${[['conflict', 'Conflicting changes'], ['clean', 'Clean merge'], ['failed', 'Failed merge check']].map(([value, label]) => `<button data-action="scenario" data-value="${value}" aria-pressed="${current.scenario === value}">${icon(current.scenario === value ? 'check' : 'minus')}${label}</button>`).join('')}</div><button class="icon-button" data-action="reset" aria-label="Reset simulation" title="Reset simulation">${icon('rotate-ccw')}</button>`;
	window.lucide?.createIcons();
	mountResolutionTerminal();
	for (const region of workspace.querySelectorAll('.diff-scroll')) {
		region.scrollTop = current.diffPositions?.[region.dataset.scrollKey]?.top || 0;
		region.scrollLeft = current.diffPositions?.[region.dataset.scrollKey]?.left || 0;
		region.addEventListener('scroll', () => {
			for (const sibling of workspace.querySelectorAll('.diff-scroll')) {
				if (sibling !== region && sibling.scrollTop !== region.scrollTop) sibling.scrollTop = region.scrollTop;
			}
			current.diffPositions ??= {};
			current.diffPositions[region.dataset.scrollKey] = { top: region.scrollTop, left: region.scrollLeft, changeIndex: Number(region.dataset.changeIndex) };
		});
	}
	for (const log of workspace.querySelectorAll('.messages')) {
		log.scrollTop = log.scrollHeight;
		if (variant === 'C') {
			const latest = log.lastElementChild;
			if (latest) log.scrollTop += latest.getBoundingClientRect().top - log.getBoundingClientRect().top;
		}
	}
	if (focusAction) {
		const target = workspace.querySelector(`[data-action="${focusAction}"]`) || switcher.querySelector(`[data-action="${focusAction}"]`) || sidebar.querySelector(`[data-action="${focusAction}"][data-value="${selectedIssue}"]`);
		if (target && !target.disabled) target.focus({ preventScroll: true });
		else { workspace.querySelector('h1').tabIndex = -1; workspace.querySelector('h1').focus({ preventScroll: true }); }
	}
	document.querySelector('#announcement').textContent = `${issues[selectedIssue].reference}: ${phases[current.phase][0]}`;
}
function advance() {
	const current = session();
	if (isRunBlocked() || current.paused || (activeMerge() !== -1 && activeMerge() !== selectedIssue)) return;
	if (!['review', 'integrated'].includes(current.phase) && current.targetBase !== targetHead) {
		current.targetBase = targetHead;
		current.targetChanged = true;
		current.approved = false;
		current.checks = 'pending';
		current.revision += 1;
		current.phase = 'inspecting';
		message('agent', 'The initiative branch changed while this session was stopped. The prior approval and checks are outdated. I will prepare a new result for inspection and approval.');
		render('advance');
		return;
	}
	const failsCheck = (current.scenario === 'failed' || current.strategy !== 'combine') && !current.repaired;
	const transitions = { review: 'inspecting', inspecting: current.targetChanged ? 'resolving' : current.scenario === 'clean' ? 'checking' : 'conflict', conflict: 'resolving', resolving: 'resolution-review', 'resolution-review': 'checking', checking: failsCheck ? 'failed' : 'validated', failed: 'repairing', repairing: 'resolution-review', validated: 'integrated', stopped: current.previousPhase || 'inspecting' };
	const next = transitions[current.phase];
	if (!next) return;
	if (current.phase === 'review') { current.targetBase = targetHead; current.approved = true; message('user', `Approved ${issues[selectedIssue].checkpoint} for merge into harness/initiative.`); }
	if (['resolving', 'repairing'].includes(current.phase)) { current.revision += 1; current.approved = false; if (current.phase === 'repairing') { current.repaired = true; current.strategy = 'combine'; } }
	if (current.phase === 'resolution-review') { current.approved = true; message('user', `Approved resolution-r${current.revision} and its resulting changes.`); }
	if (current.phase === 'checking') current.checks = next === 'failed' ? 'failed' : 'passed';
	if (current.phase === 'failed') current.checks = 'pending';
	current.phase = next;
	if (next === 'integrated') { targetHead = `9d3c${String(++integrationCount).padStart(3, '0')}`; current.integrationHead = targetHead; }
	current.events.push({ title: phases[next][0], detail: ({ inspecting: `Approved ${issues[selectedIssue].checkpoint}; inspecting target ${current.targetBase}.`, conflict: '4 files inspected: 2 overlapping blocks and 2 clean additions.', resolving: 'Combining both requirements and retaining regression assertions.', 'resolution-review': `New resolution-r${current.revision} needs approval. Initiative branch unchanged.`, checking: `Required checks on resolution-r${current.revision} against ${current.targetBase}.`, failed: `Expected ${example().good}; received ${example().bad}. Integration blocked.`, repairing: `Repairing ${example().status}; fresh approval required.`, validated: 'All 3 required checks passed for the approved result.', integrated: `Integrated ${current.integrationHead}; dependent work released. Final merge to main pending.` })[next] || 'Resumed session.' });
		message('agent', ({ inspecting: `I am comparing ${issues[selectedIssue].checkpoint} with initiative checkpoint ${current.targetBase}. Other workers continue.`, conflict: `Two files conflict. The issue requires: ${example().requirement} The initiative requires: ${example().retained} Keeping only one branch loses a required behavior.`, resolving: 'I am combining both branch operations and all required assertions. The options and documentation files are clean additions.', 'resolution-review': `Recommendation for resolution-r${current.revision}: combine both branch changes.\n\nWhat conflicted: ${filePaths()[0]} and ${filePaths()[1]} replace the same implementation and test blocks.\n\nKeep from the initiative: ${example().retained}\nAdd from the issue: ${example().requirement}\n\nWhy: choosing either branch alone removes a required behavior. The combined result preserves both operations and their assertions. The options and documentation files are clean additions.\n\nRequired checks have not run on this result. You can approve it or ask me to re-evaluate it. The initiative branch is unchanged.`, checking: `Approval recorded for resolution-r${current.revision}. Running type, issue behavior, and initiative regression checks.`, failed: `The result-state assertion failed: expected ${example().good}, received ${example().bad}. No initiative update. I can prepare a repair.`, repairing: `I am changing ${example().status} to ${example().good} and preserving both requirements. The repair will need fresh approval.`, validated: 'All three checks passed for the approved result and target checkpoint. Completing integration.', integrated: `Integrated ${current.integrationHead} into harness/initiative. Dependent work released. Final merge to main requires separate approval. No push.` })[next] || 'The merge session resumed with its existing checkpoint.');
	if (next === 'integrated' && window.parent !== window) window.parent.postMessage({ type: 'merge-integrated', checkpoint: current.integrationHead, issue: selectedIssue }, location.origin);
	render('advance');
}
function runAgent() {
	if (isRunBlocked()) return;
	advance();
	while (['inspecting', 'conflict', 'resolving', 'checking', 'repairing', 'validated'].includes(session().phase) && !isRunBlocked() && !session().paused && (activeMerge() === -1 || activeMerge() === selectedIssue)) advance();
}
document.addEventListener('click', (event) => {
	const control = event.target.closest('[data-action]');
	if (!control || control.disabled) return;
	const action = control.dataset.action;
	if (action === 'advance') runAgent();
	else if (action === 'merge-view') { session().mergeView = control.dataset.value; render(); workspace.querySelector(`#merge-${session().mergeView === 'diffs' ? 'diffs' : 'agent'}-view`).focus({ preventScroll: true }); }
	else if (action === 'comparison') { session().comparison = control.dataset.value; render(); }
	else if (action === 'diff-next' || action === 'diff-previous') {
		const region = workspace.querySelector('.diff-scroll');
		const positions = [...region.querySelectorAll('[data-change]')].map((row) => row.offsetTop - region.querySelector('pre').offsetTop);
		const previous = Number(region.dataset.changeIndex);
		const next = previous < 0 ? action === 'diff-next' ? 0 : positions.length - 1 : (previous + (action === 'diff-next' ? 1 : -1) + positions.length) % positions.length;
		for (const pane of workspace.querySelectorAll('.diff-scroll')) { pane.dataset.changeIndex = next; pane.scrollTop = positions[next]; }
		workspace.querySelector('.diff-change-position').textContent = `${next + 1} / ${positions.length}`;
	}
	else if (action === 'terminal-control') { session().manual = !session().manual; render(); if (session().manual) terminalSessions.get(session())?.terminal.focus(); }
	else if (action === 'file') { session().file = Number(control.dataset.value); render(); workspace.querySelector(`[data-action="file"][data-value="${session().file}"]`).focus({ preventScroll: true }); }
	else if (action === 'issue') { selectedIssue = Number(control.dataset.value); render('issue'); }
	else if (action === 'scenario') { disposeResolutionTerminal(session()); sessions[selectedIssue] = newSession(); session().scenario = control.dataset.value; if (embedded && selectedIssue === 0) window.parent.postMessage({ type: 'merge-reset', scenario: control.dataset.value }, location.origin); render('reset'); }
	else if (action === 'reset') { for (const current of sessions) disposeResolutionTerminal(current); targetHead = '6f21bd8'; integrationCount = 0; sessions = issues.map(newSession); selectedIssue = 0; if (embedded) window.parent.postMessage({ type: 'merge-reset' }, location.origin); render('reset'); }
	else if (action === 'pause') { session().paused = !session().paused; render('pause'); }
	else if (action === 'revision') {
		dialog.innerHTML = `<form method="dialog"><h2>Request a revised resolution</h2><label for="revision-note">Revision request</label><textarea id="revision-note" required rows="4" placeholder="Keep both requirements and clarify the result"></textarea><p>This example adds explicit result-state evidence to the proposed test. No live agent call.</p><div class="dialog-actions"><button value="cancel" formnovalidate>Cancel</button><button value="revision" class="primary">Send request</button></div></form>`;
		if (variant === 'C') { dialog.querySelector('h2').textContent = 'Re-evaluate resolution'; dialog.querySelector('label').textContent = 'What should the agent reconsider?'; dialog.querySelector('textarea').placeholder = 'Question an assumption, a retained change, or the proposed test'; }
		dialog.returnValue = '';
		dialog.showModal();
	}
	else if (action === 'stop' || action === 'manual') {
		dialog.innerHTML = action === 'stop' ? `<form method="dialog"><h2>Stop merge agent?</h2><p>Keep proposed changes, approvals, and session evidence.</p><div class="dialog-actions"><button value="cancel">Cancel</button><button value="stop" class="danger-button">${icon('square')}Stop agent</button></div></form>` : `<form method="dialog"><h2>Manual resolution</h2><label for="manual-note">Resolution note</label><textarea id="manual-note" rows="4" required placeholder="Record the intended resolution"></textarea><p class="muted">Simulated checkpoint / No local files are read or changed</p><div class="dialog-actions"><button value="cancel" formnovalidate>Cancel</button><button value="manual" class="primary">${icon('file-check')}Review checkpoint</button></div></form>`;
		dialog.returnValue = '';
		window.lucide?.createIcons();
		dialog.showModal();
	}
});
dialog.addEventListener('close', () => {
	if (dialog.returnValue === 'revision') {
		const note = dialog.querySelector('textarea').value.trim();
		if (!note) return;
		message('user', note);
		session().revision += 1;
		session().approved = false;
		session().checks = 'pending';
		session().repaired = true;
		session().revised = true;
		session().events.push({ title: 'Revised resolution prepared', detail: `Request recorded; result-state evidence added to resolution-r${session().revision}. Fresh approval required.` });
		message('agent', `Your request is recorded. This simulated revision explicitly asserts the result state and preserves both requirements. Inspect resolution-r${session().revision} before approval.`);
		render('advance');
	}
	if (dialog.returnValue === 'stop') { session().previousPhase = session().phase; session().phase = 'stopped'; session().paused = false; message('agent', 'The merge session stopped. Proposed changes and evidence are preserved.'); render('advance'); }
	if (dialog.returnValue === 'manual') { const note = dialog.querySelector('textarea').value.trim(); if (!note) return; message('user', `Manual resolution: ${note}`); session().revision += 1; session().approved = false; session().repaired = true; session().revised = true; session().checks = 'pending'; session().phase = 'resolution-review'; session().strategy = 'combine'; message('agent', 'This simulated manual checkpoint restores the required result state and adds its assertion. Inspect the resulting changes before approval.'); render('advance'); }
});
document.addEventListener('input', (event) => { if (event.target.id === 'agent-draft') session().draft = event.target.value; });
document.addEventListener('change', (event) => { if (event.target.name === 'strategy') session().strategy = event.target.value; });
document.addEventListener('submit', (event) => {
	if (event.target.id !== 'agent-message') return;
	event.preventDefault();
	if (!session().draft.trim() || session().paused || ['review', 'integrated', 'stopped'].includes(session().phase)) return;
	message('user', session().draft.trim());
	session().draft = '';
	message('agent', 'I recorded your message for this merge session. The current proposal and approval state are unchanged.');
	render();
	workspace.querySelector('#agent-draft').focus({ preventScroll: true });
});
document.addEventListener('keydown', (event) => {
	if (event.target.closest('.merge-view-tabs') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
		event.preventDefault();
		const value = event.key === 'Home' ? 'agent' : event.key === 'End' ? 'diffs' : session().mergeView === 'diffs' ? 'agent' : 'diffs';
		workspace.querySelector(`[data-action="merge-view"][data-value="${value}"]`).click();
		return;
	}
});
const embedded = new URL(location.href).searchParams.has('embedded');
const connectedInitiative = embedded && new URL(location.href).searchParams.has('initiative');
document.body.classList.toggle('embedded-merge', embedded);
render();
if (embedded && new URL(location.href).searchParams.has('approved')) runAgent();
if (!embedded) mountInitiativeHost();

function mountInitiativeHost() {
	document.body.classList.add('initiative-host');
	let theme = 'light';
	const applicationPages = ['workspace', 'planning', 'repositories', 'global-settings', 'project-settings'];
	const entryUrl = new URL(location.href);
	const initialPage = applicationPages.includes(entryUrl.searchParams.get('page')) ? entryUrl.searchParams.get('page') : 'workspace';
	entryUrl.pathname = '/';
	entryUrl.searchParams.delete('variant');
	if (entryUrl.searchParams.has('page')) entryUrl.searchParams.set('page', initialPage);
	history.replaceState(null, '', entryUrl);
	const host = document.createElement('iframe');
	host.className = 'initiative-frame';
	host.title = 'Initiative workspace';
	const hostUrl = new URL('/harness-workspace-prototype.html', location.origin);
	hostUrl.searchParams.set('variant', 'C');
	hostUrl.searchParams.set('page', initialPage);
	host.src = hostUrl.href;
	document.body.append(host);
	window.addEventListener('popstate', () => host.contentWindow.switchPage?.(new URL(location.href).searchParams.get('page') || 'workspace', false));
	host.addEventListener('load', () => {
		const hostDocument = host.contentDocument;
		const simulationControls = hostDocument.querySelector('.prototype-switcher');
		const resetControl = hostDocument.querySelector('#reset-prototype');
		resetControl.classList.add('icon-button', 'harness-reset');
		resetControl.addEventListener('click', () => { hostDocument.querySelector('#initiative-tab')?.click(); attach(); attachThemeToggle(); });
		simulationControls.style.display = 'none';
		hostDocument.querySelector('#app').style.paddingBottom = '0';
		host.contentWindow.changeVariant = () => {};
		const switchPage = host.contentWindow.switchPage;
		host.contentWindow.switchPage = (page, updateHistory = true) => {
			const selectedPage = applicationPages.includes(page) ? page : 'workspace';
			closeAgent(false);
			closeDrawer();
			switchPage(selectedPage, false);
			const childUrl = new URL(host.contentWindow.location.href);
			childUrl.searchParams.set('page', selectedPage);
			host.contentWindow.history.replaceState(null, '', childUrl.href);
			if (updateHistory) {
				const url = new URL(location.href);
				url.searchParams.set('page', selectedPage);
				history.pushState(null, '', url);
			}
		};
		let open = false;
		let integrated = false;
		let started = false;
		let view = 'review';
		const mergeFrame = document.createElement('iframe');
		mergeFrame.title = 'Issue merge session';
		mergeFrame.className = 'initiative-merge-frame';
		const renderWorkspace = host.contentWindow.render;
		host.contentWindow.render = () => {
			if (mergeFrame.isConnected && mergeFrame.hasAttribute('src')) {
				mergeFrame.style.display = 'none';
				hostDocument.body.moveBefore(mergeFrame, null);
			}
			renderWorkspace();
			attach();
			mergeFrame.contentWindow.render?.();
		};
		const style = hostDocument.createElement('style');
		style.textContent = '.initiative-merge-frame{display:block;width:100%;height:100%;min-height:0;border:0}#initiative-merge-panel{flex:1;min-height:0;overflow:hidden}.workspace-views:has(#initiative-merge-panel:not([hidden])){height:auto;min-height:0}.review-layout [data-page-panel="workspace"]>.workspace-body:has(#initiative-merge-panel:not([hidden])){flex-basis:0}.workspace-body:has(#initiative-merge-panel:not([hidden])){grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}.workspace-body:has(#initiative-merge-panel:not([hidden]))>.run-inbox{display:none}body:has(#initiative-merge-panel:not([hidden]))>.prototype-switcher{display:none}body:has(#initiative-merge-panel:not([hidden])) #app{padding-bottom:0}.connected-review{padding:24px;overflow:auto}.connected-review p{margin:12px 0;line-height:1.6}.connected-review li{margin:12px 0;overflow-wrap:anywhere}.connected-review h2{margin-bottom:14px}';
		hostDocument.head.append(style);
		style.textContent += '@property --harness-issue-beam-angle{syntax:"<angle>";inherits:false;initial-value:0deg}.route-issue.running{position:relative;isolation:isolate}.route-issue.running::after{position:absolute;inset:-1px;padding:2px;border-radius:inherit;background:conic-gradient(from var(--harness-issue-beam-angle),transparent 0deg 270deg,#285d49 304deg,#65bd91 337deg,#d1ffe8 352deg,transparent 360deg);-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;content:"";animation:harness-issue-beam 4s linear infinite}@keyframes harness-issue-beam{to{--harness-issue-beam-angle:360deg}}@media(prefers-reduced-motion:reduce){.route-issue.running{border-color:#65bd91}.route-issue.running::after{display:none;animation:none}}';
		style.textContent += '#action-dialog:has(#record-title){width:min(640px,calc(100% - 48px));max-width:calc(100% - 48px);max-height:calc(100dvh - 48px);overflow:auto}';
		style.textContent += '.review-layout .workspace>.run-header{align-items:center;flex-direction:row;flex-wrap:wrap;gap:12px;padding:8px 20px}.review-layout .workspace>.run-header>div:first-child{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px}.review-layout .workspace>.run-header h1{font-size:16px}.review-layout .workspace>.run-header .run-subtitle{margin:0;font-size:11px}.review-layout .workspace .workspace-tabs{min-height:40px;padding:0 16px}.review-layout .workspace .workspace-tabs button{min-height:40px;padding-top:6px;padding-bottom:6px}@media(max-width:1150px){.review-layout .workspace .workspace-tabs,.review-layout .workspace .workspace-tabs button{min-height:44px}}';
		style.textContent += '@media(max-width:1150px){.review-layout{grid-template-columns:56px 184px minmax(0,1fr)}.review-layout .rail{padding:16px 12px}.review-layout .run-header{flex-direction:row;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 16px}.review-layout .run-header h1{font-size:18px}.review-layout .run-actions{gap:8px}.review-layout .workspace-tabs{gap:16px;padding:0 16px}.review-layout button,dialog button,[popover] button,.select-trigger,.select-menu [role="option"],.settings-models .settings-toggle,input:not([type="checkbox"]):not([type="radio"]),select,label:has(input[type="checkbox"]),label:has(input[type="radio"]){min-height:44px}.review-layout .application-navigation a{width:44px;min-width:44px;min-height:44px}.review-layout [aria-label="Project Settings"]{width:44px;height:44px;min-width:44px;min-height:44px;flex-shrink:0}.review-layout .workspace-tabs button{min-height:44px;font-size:12px}.icon-button{min-width:44px;min-height:44px}.review-layout .workspace-views{height:auto;min-height:0}.review-layout [data-page-panel="workspace"]>.workspace-body{flex-basis:0}}';
		style.textContent += '.tablet-navigation-trigger{display:none}.tablet-navigation-drawer{position:fixed;inset:0 auto 0 0;width:320px;max-width:calc(100% - 48px);height:100%;max-height:100%;margin:0;padding:0;border:0;border-right:1px solid var(--border);border-radius:0;background:var(--surface);color:inherit}.tablet-navigation-drawer::backdrop{background:rgb(0 0 0 / 32%)}.tablet-drawer-header{display:flex;align-items:center;justify-content:space-between;height:60px;padding:8px 16px;border-bottom:1px solid var(--border)}.tablet-drawer-body.review-layout{display:grid;grid-template-columns:56px minmax(0,1fr);height:calc(100% - 60px);min-height:0;overflow:hidden}.tablet-drawer-body .rail{min-width:0;overflow:auto}.tablet-drawer-body .application-navigation{height:100%;min-height:0}@media(max-width:1150px){#app .review-layout{grid-template-columns:minmax(0,1fr)}#app .review-layout>.application-navigation,#app .review-layout>.rail{display:none}.tablet-navigation-trigger{display:inline-flex;flex-shrink:0;width:44px;height:44px;align-items:center;justify-content:center}.run-header>div:has(.tablet-navigation-trigger){display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}}';
		const tabletQuery = host.contentWindow.matchMedia('(max-width:1150px)');
		style.textContent += '@media(max-width:1150px){:is(.run-actions,.page-heading,.tablet-drawer-header) button,.tablet-navigation-trigger{position:relative;isolation:isolate;gap:6px;padding:6px 10px;border-color:transparent;background:transparent;font-size:12px;line-height:18px;--compact-surface:var(--surface);--compact-border:var(--border)}:is(.run-actions,.page-heading,.tablet-drawer-header) button::before,.tablet-navigation-trigger::before{position:absolute;z-index:-1;inset:5px 0;border:1px solid var(--compact-border);border-radius:4px;background:var(--compact-surface);content:"";pointer-events:none}:is(.run-actions,.page-heading,.tablet-drawer-header) button.icon-button::before,.tablet-navigation-trigger::before{inset:5px}:is(.run-actions,.page-heading,.tablet-drawer-header) button:hover:not(:disabled),.tablet-navigation-trigger:hover{background:transparent;--compact-surface:#eef3ef;--compact-border:#94a89d}:is(.run-actions,.page-heading) button.primary{--compact-surface:var(--green,#285d49);--compact-border:var(--green,#285d49)}:is(.run-actions,.page-heading,.tablet-drawer-header) button svg,.tablet-navigation-trigger svg{width:14px;height:14px}}';
		style.textContent += '@media(max-width:1150px){:is(.run-actions,.page-heading) button.primary:hover:not(:disabled){color:white;--compact-surface:#1e4939;--compact-border:var(--green,#285d49)}}';
		function syncMergeControls() {
			const body = mergeFrame.contentDocument?.body;
			if (!body) return;
			body.classList.toggle('tablet-controls', tabletQuery.matches);
			body.classList.toggle('desktop-controls', !tabletQuery.matches);
		}
		mergeFrame.addEventListener('load', syncMergeControls);
		mergeFrame.addEventListener('load', () => mergeFrame.contentWindow.applyPrototypeTheme?.(theme));
		tabletQuery.addEventListener('change', syncMergeControls);
		style.textContent += '@media(max-width:1150px){.page-heading:has(.tablet-navigation-trigger){justify-content:flex-start;gap:12px}.page-heading:has(.tablet-navigation-trigger)>button:not(.tablet-navigation-trigger):last-child{margin-left:auto}}';
		const drawer = hostDocument.createElement('dialog');
		drawer.id = 'tablet-navigation-drawer';
		drawer.className = 'tablet-navigation-drawer';
		drawer.setAttribute('aria-label', 'Navigation');
		drawer.innerHTML = `<div class="tablet-drawer-header"><strong>Navigation</strong><button class="icon-button" aria-label="Close navigation" title="Close navigation">${icon('x')}</button></div><div class="tablet-drawer-body review-layout"></div>`;
		hostDocument.body.append(drawer);
		let drawerTrigger = null;
		let drawerOrigins = [];
		function closeDrawer() {
			if (!drawer.open) return;
			for (const { element, marker } of drawerOrigins) {
				if (marker.isConnected) marker.replaceWith(element);
				else element.remove();
			}
			drawerOrigins = [];
			drawer.close();
			drawerTrigger?.setAttribute('aria-expanded', 'false');
			if (tabletQuery.matches) {
				const trigger = drawerTrigger?.isConnected ? drawerTrigger : [...hostDocument.querySelectorAll('.tablet-navigation-trigger')].find((element) => element.getClientRects().length);
				trigger?.focus();
			}
		}
		function openDrawer(trigger) {
			if (!tabletQuery.matches || drawer.open) return;
			drawerTrigger = trigger;
			const body = drawer.querySelector('.tablet-drawer-body');
			for (const element of hostDocument.querySelectorAll('#app .review-layout>.application-navigation,#app .review-layout>.rail')) {
				const marker = hostDocument.createComment('tablet-navigation');
				element.replaceWith(marker);
				body.append(element);
				drawerOrigins.push({ element, marker });
			}
			trigger.setAttribute('aria-expanded', 'true');
			drawer.showModal();
			drawer.querySelector('button').focus();
		}
		function attachDrawerTrigger() {
			let added = false;
			for (const header of hostDocument.querySelectorAll('.run-header,.page-heading')) {
				if (header.querySelector('.tablet-navigation-trigger')) continue;
				const trigger = hostDocument.createElement('button');
				trigger.className = 'icon-button tablet-navigation-trigger';
				trigger.setAttribute('aria-label', 'Open navigation');
				trigger.title = 'Open navigation';
				trigger.setAttribute('aria-controls', drawer.id);
				trigger.setAttribute('aria-haspopup', 'dialog');
				trigger.setAttribute('aria-expanded', 'false');
				trigger.innerHTML = icon('menu');
				(header.matches('.run-header') ? header.querySelector('div') ?? header : header).prepend(trigger);
				trigger.addEventListener('click', () => openDrawer(trigger));
				added = true;
			}
			if (added) host.contentWindow.lucide?.createIcons();
		}
		drawer.addEventListener('cancel', (event) => { event.preventDefault(); closeDrawer(); });
		drawer.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape' || hostDocument.querySelector('[popover]:popover-open')) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			closeDrawer();
		}, true);
		drawer.addEventListener('click', (event) => {
			const bounds = drawer.getBoundingClientRect();
			if (event.target.closest('[aria-label="Close navigation"]') || event.target === drawer && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeDrawer();
		});
		hostDocument.addEventListener('click', (event) => {
			const action = event.target.closest('[data-action]');
			if (!drawer.contains(event.target) || !action) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			closeDrawer();
			action.click();
		}, true);
		tabletQuery.addEventListener('change', () => { if (!tabletQuery.matches) closeDrawer(); });
		style.textContent += '.tablet-inbox-trigger{display:none}.tablet-inbox-trigger .count{display:inline-grid;min-width:18px;height:18px;margin:0;padding:0 4px;place-items:center;font-size:10px;line-height:18px}.tablet-inbox-close{display:none}@media(max-width:1150px){.tablet-inbox-trigger{display:inline-flex;min-width:44px;min-height:44px}.tablet-inbox-close{display:inline-flex}.review-layout .workspace-body{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}#app .workspace-body>.run-inbox:not(:popover-open){display:none}#app .workspace-body>.run-inbox:popover-open{position:fixed;inset:0 0 0 auto;display:flex;flex-direction:column;width:360px;max-width:calc(100% - 48px);height:100%;max-height:100%;margin:0;padding:0;overflow:auto;border:0;border-left:1px solid var(--border);border-radius:0;background:var(--surface);color:var(--ink)}.run-inbox[popover]::backdrop{background:rgb(0 0 0 / 24%)}.run-inbox[popover]>.panel-title{flex-shrink:0;min-height:52px;padding:4px 12px}.run-inbox[popover]>.tabs{flex-shrink:0}.run-inbox[popover] button{min-height:44px}.run-inbox[popover] .tablet-inbox-close{width:44px;height:44px;padding:10px;border:0;background:transparent}.run-inbox[popover] .tablet-inbox-close svg{width:14px;height:14px}.run-inbox[popover] textarea{min-height:96px}.run-inbox[popover]>section{flex:1;min-height:0;overflow:auto}.run-inbox[popover] .panel-title h2{font-size:14px}}';
		let inboxOpen = false;
		const configuredInboxes = new WeakSet();
		function attachInbox() {
			const inbox = hostDocument.querySelector('.run-inbox');
			const actions = hostDocument.querySelector('.run-header .run-actions');
			if (!inbox || !actions) return;
			let trigger = actions.querySelector('.tablet-inbox-trigger');
			if (!trigger) {
				trigger = hostDocument.createElement('button');
				trigger.className = 'tablet-inbox-trigger';
				trigger.title = 'Run inbox';
				trigger.setAttribute('aria-haspopup', 'dialog');
				trigger.setAttribute('aria-controls', 'tablet-run-inbox');
				trigger.innerHTML = `${icon('inbox')}<span class="count"></span>`;
				actions.prepend(trigger);
				trigger.addEventListener('click', () => {
					const panel = hostDocument.querySelector('#tablet-run-inbox');
					if (!tabletQuery.matches || !panel) return;
					panel.togglePopover();
					if (panel.matches(':popover-open')) panel.querySelector('.tablet-inbox-close').focus();
				});
				host.contentWindow.lucide?.createIcons();
			}
			const count = inbox.querySelector('.count')?.textContent ?? '0';
			if (trigger.querySelector('.count').textContent !== count) trigger.querySelector('.count').textContent = count;
			trigger.setAttribute('aria-label', `Run inbox, ${count} pending`);
			trigger.setAttribute('aria-expanded', String(inboxOpen));
			if (!tabletQuery.matches) {
				inboxOpen = false;
				if (inbox.matches(':popover-open')) inbox.hidePopover();
				inbox.removeAttribute('popover');
				inbox.removeAttribute('role');
				return;
			}
			inbox.id = 'tablet-run-inbox';
			inbox.setAttribute('popover', 'auto');
			inbox.setAttribute('role', 'dialog');
			inbox.setAttribute('aria-label', 'Run inbox');
			if (!inbox.querySelector('.tablet-inbox-close')) {
				const close = hostDocument.createElement('button');
				close.className = 'icon-button tablet-inbox-close';
				close.setAttribute('aria-label', 'Close run inbox');
				close.title = 'Close run inbox';
				close.innerHTML = icon('x');
				close.addEventListener('click', () => { inboxOpen = false; inbox.hidePopover(); trigger.focus(); });
				inbox.querySelector('.panel-title').append(close);
				host.contentWindow.lucide?.createIcons();
			}
			if (configuredInboxes.has(inbox)) return;
			configuredInboxes.add(inbox);
			inbox.addEventListener('toggle', () => {
				if (!inbox.isConnected) return;
				inboxOpen = inbox.matches(':popover-open');
				trigger.setAttribute('aria-expanded', String(inboxOpen));
			});
			inbox.addEventListener('keydown', (event) => {
				if (event.key !== 'Escape' || !inbox.matches(':popover-open')) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				inboxOpen = false;
				inbox.hidePopover();
				trigger.focus();
			}, true);
			if (inboxOpen) inbox.showPopover();
		}
		hostDocument.addEventListener('click', (event) => {
			const action = event.target.closest('.run-inbox [data-action="open-review"],.run-inbox [data-action="changes"],.run-inbox [data-action="approve"]');
			if (!action) return;
			inboxOpen = false;
			const inbox = action.closest('.run-inbox');
			if (inbox.matches(':popover-open')) inbox.hidePopover();
		}, true);
		tabletQuery.addEventListener('change', attachInbox);
		style.textContent += '.route-issues>li:has(.initiative-agent-trigger){position:relative}.route-issues>li:has(.initiative-agent-trigger)>.route-issue{padding-right:58px}.initiative-agent-trigger{position:absolute;top:8px;right:8px;width:44px;height:44px;padding:10px}.initiative-agent-trigger svg{width:14px;height:14px}#agents-panel[popover]:popover-open{position:fixed;inset:0 0 0 auto;display:flex;flex-direction:column;width:680px;max-width:calc(100% - 48px);height:100%;max-height:100%;margin:0;padding:0;border:0;border-left:1px solid var(--border);border-radius:0;background:var(--surface);color:var(--ink)}#agents-panel[popover]::backdrop{background:rgb(0 0 0 / 24%)}.agent-overlay-heading{display:flex;flex-shrink:0;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:4px 16px;border-bottom:1px solid var(--border)}.agent-overlay-heading strong{font-size:14px}.agent-overlay-heading button{width:44px;height:44px;padding:10px;border:0;background:transparent}.agent-overlay-heading svg{width:14px;height:14px}#agents-panel[popover]>.viewport-label,#agents-panel[popover]>.agent-selection{display:none}#agents-panel[popover]>.terminal-grid{display:flex;flex:1;min-height:0;padding:0}#agents-panel[popover] .terminal-panel{display:none;flex:1;flex-direction:column;min-width:0;min-height:0;margin:0;border:0;border-radius:0}#agents-panel[popover] .terminal-panel.overlay-active{display:flex}#agents-panel[popover] .terminal-host{flex:1;height:auto;min-height:0}#agents-panel[popover] :is(.terminal-header,.terminal-meta,.terminal-footer){flex-shrink:0}';
		let agentWorker = null;
		let agentTrigger = null;
		const configuredAgents = new WeakSet();
		style.textContent += '.agent-question{padding:16px 20px;border-bottom:1px solid var(--border);background:var(--surface)}.agent-question h3{font-size:14px}.agent-question p{margin:8px 0;line-height:1.5}';
		const agentBridge = hostDocument.createElement('script');
		agentBridge.textContent = `window.canIntegrateHarnessIssue = () => state.mode === 'running' && !['paused', 'stopping', 'stopped', 'terminated'].includes(state.workers[2].status);
		window.recordHarnessIntegration = (checkpoint) => {
			if (state.integrated || !window.canIntegrateHarnessIssue()) return;
			state.approved = true;
			state.integrated = true;
			const worker = state.workers[2];
			worker.status = 'integrated';
			worker.lines.push('User approval recorded.', 'Simulated integration complete: ' + checkpoint);
			terminals.find(({ host }) => host.dataset.terminal === worker.id)?.terminal.write('\\r\\nUser approval recorded.\\r\\nSimulated integration complete: ' + checkpoint + '\\r\\n');
			state.activity.unshift('Approved DEMO-03 changes integrated into the initiative branch.');
			const snapshot = JSON.parse(app.dataset.state);
			snapshot.approved = true;
			snapshot.integrated = true;
			snapshot.workers.find((item) => item.id === worker.id).status = worker.status;
			app.dataset.state = JSON.stringify(snapshot);
			refreshChangeRequests();
		};
		window.applyHarnessTerminalTheme = (palette) => {
			for (const { terminal } of terminals) {
				if (terminal.options.theme.background !== palette.background) terminal.options.theme = palette;
			}
		};
		window.ensureHarnessAgent = (id) => {
			if (app.querySelector('[data-terminal="' + id + '"]')) return;
			const worker = state.workers.find((item) => item.id === id);
			if (!worker) return;
			worker.visible = true;
			app.querySelector('[data-worker="' + id + '"]').checked = true;
			app.dataset.state = JSON.stringify({ ...JSON.parse(app.dataset.state), visible: state.workers.filter((item) => item.visible).map((item) => item.id) });
			const markup = document.createElement('template');
			markup.innerHTML = terminalGrid();
			const panel = markup.content.querySelector('[data-terminal="' + id + '"]').closest('.terminal-panel');
			let grid = app.querySelector('#agents-panel .terminal-grid');
			if (!grid) {
				grid = document.createElement('div');
				grid.className = 'terminal-grid';
				app.querySelector('#agents-panel .empty-terminals')?.remove();
				app.querySelector('#agents-panel').append(grid);
			}
			grid.append(panel);
			window.lucide?.createIcons();
			const host = panel.querySelector('[data-terminal]');
			if (!window.Terminal || !window.FitAddon) {
				host.innerHTML = '<pre>' + escapeHtml(worker.lines.join('\\n')) + '</pre>';
				return;
			}
			const terminal = new window.Terminal({ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, lineHeight: 1.45, cursorBlink: worker.manual, theme: { background: '#f6f7f6', foreground: '#445149', cursor: '#245c48', selectionBackground: '#dce9e2' }, scrollback: 300, convertEol: true });
			const fit = new window.FitAddon.FitAddon();
			terminal.loadAddon(fit);
			terminal.open(host);
			worker.lines.forEach((line) => terminal.writeln(line));
			terminal.scrollToTop();
			worker.input ??= '';
			if (worker.input) terminal.write(worker.input);
			terminal.onData((data) => {
				if (!worker.manual || !['running', 'paused'].includes(state.mode)) return;
				if (data === '\\r') {
					worker.lines.push('> ' + worker.input, 'Simulated input recorded.');
					terminal.write('\\r\\nSimulated input recorded.\\r\\n> ');
					worker.input = '';
				} else if (data === '\\u007f') {
					if (worker.input.length) { worker.input = worker.input.slice(0, -1); terminal.write('\\b \\b'); }
				} else if (/^[\\x20-\\x7e]+$/.test(data)) {
					worker.input += data;
					terminal.write(data);
				}
			});
			const observer = new ResizeObserver(() => { if (host.offsetWidth && host.offsetHeight) fit.fit(); });
			observer.observe(host);
			terminals.push({ terminal, observer, fit, host });
		};`;
		hostDocument.head.append(agentBridge);
		function applyHostTheme() {
			applyPrototypeColors(hostDocument, theme);
			host.contentWindow.applyHarnessTerminalTheme(harnessTerminalTheme(theme));
			mergeFrame.contentWindow.applyPrototypeTheme?.(theme);
			let changed = false;
			for (const button of hostDocument.querySelectorAll('.harness-theme-toggle')) {
				if (button.dataset.theme === theme) continue;
				button.dataset.theme = theme;
				button.setAttribute('aria-checked', String(theme === 'dark'));
				button.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
				button.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
				changed = true;
			}
			if (changed) host.contentWindow.lucide?.createIcons();
		}
		function attachThemeToggle() {
			for (const link of hostDocument.querySelectorAll('a[data-action="page"]')) link.setAttribute('href', `/?page=${link.dataset.page}`);
			for (const actions of hostDocument.querySelectorAll('.application-navigation .repository-navigation')) {
				const toggle = actions.querySelector('.harness-theme-toggle');
				if (resetControl.parentElement !== actions || resetControl.nextElementSibling !== toggle) actions.insertBefore(resetControl, toggle);
				if (toggle) continue;
				const button = hostDocument.createElement('button');
				button.type = 'button';
				button.className = 'icon-button harness-theme-toggle';
				button.setAttribute('role', 'switch');
				button.setAttribute('aria-label', 'Dark theme');
				actions.append(button);
			}
			applyHostTheme();
		}
		function closeAgent(restoreFocus = false) {
			const worker = agentWorker;
			agentWorker = null;
			const panel = hostDocument.querySelector('#agents-panel');
			if (panel) attachAgentQuestion(panel);
			if (panel?.matches(':popover-open')) panel.hidePopover();
			if (restoreFocus) (agentTrigger?.isConnected ? agentTrigger : hostDocument.querySelector(`[data-agent-worker="${worker}"]`))?.focus({ preventScroll: true });
		}
		function attachAgentQuestion(panel) {
			const inboxForm = hostDocument.querySelector('.run-inbox [data-form="answer"]');
			const inboxQuestion = inboxForm?.closest('.inbox-item') || hostDocument.querySelector('.run-inbox [data-agent-question="02"]');
			let question = panel.querySelector('.agent-question');
			if (!inboxQuestion) { question?.remove(); return; }
			inboxQuestion.dataset.agentQuestion = '02';
			if (!inboxQuestion.querySelector('[data-agent-question-open]')) {
				const trigger = hostDocument.createElement('button');
				trigger.type = 'button';
				trigger.dataset.agentQuestionOpen = '';
				trigger.dataset.agentWorker = '02';
				trigger.textContent = 'Open agent';
				inboxQuestion.append(trigger);
			}
			if (agentWorker === '02') {
				const currentForm = question?.querySelector('[data-form="answer"]');
				if (inboxForm && currentForm) {
					for (const selector of ['textarea', 'button']) currentForm.querySelector(selector).disabled = inboxForm.querySelector(selector).disabled;
					inboxForm.remove();
				} else if (inboxForm) {
					question?.remove();
					question = hostDocument.createElement('section');
					question.className = 'agent-question';
					question.setAttribute('aria-label', 'Worker 02 question');
					for (const text of inboxQuestion.querySelectorAll('h3,p')) question.append(text.cloneNode(true));
					inboxForm.style.display = '';
					question.append(inboxForm);
					panel.querySelector('.agent-overlay-heading').after(question);
				}
			} else {
				const form = inboxForm || question?.querySelector('[data-form="answer"]');
				if (form) {
					form.style.display = 'none';
					if (form.parentElement !== inboxQuestion) inboxQuestion.append(form);
				}
				question?.remove();
			}
		}
		function attachAgents(views) {
			const tabs = views.querySelector('.workspace-tabs');
			const initiative = tabs.querySelector('#initiative-tab');
			if (initiative && tabs.firstElementChild !== initiative) tabs.prepend(initiative);
			tabs.querySelector('#agents-tab')?.remove();
			let added = false;
			for (const row of views.querySelectorAll('#initiative-panel .route-issue')) {
				const worker = String(Number(row.dataset.index) + 1).padStart(2, '0');
				if (!hostDocument.querySelector(`[data-worker="${worker}"]`) || row.parentElement.querySelector('.initiative-agent-trigger')) continue;
				const trigger = hostDocument.createElement('button');
				trigger.className = 'icon-button initiative-agent-trigger';
				trigger.dataset.agentWorker = worker;
				trigger.setAttribute('aria-label', `Open Worker ${worker} agent`);
				trigger.setAttribute('aria-controls', 'agents-panel');
				trigger.setAttribute('aria-haspopup', 'dialog');
				trigger.title = `Open Worker ${worker} agent`;
				trigger.innerHTML = icon('terminal');
				row.parentElement.append(trigger);
				added = true;
			}
			const panel = views.querySelector('#agents-panel');
			if (!panel) return;
			panel.removeAttribute('data-workspace-panel');
			panel.removeAttribute('aria-labelledby');
			panel.hidden = false;
			panel.setAttribute('popover', 'auto');
			panel.role = 'dialog';
			panel.setAttribute('aria-label', 'Agent session');
			if (!panel.querySelector('.agent-overlay-heading')) {
				const heading = hostDocument.createElement('div');
				heading.className = 'agent-overlay-heading';
				heading.innerHTML = `<strong>Agent session</strong><button class="icon-button" aria-label="Close agent" title="Close agent">${icon('x')}</button>`;
				heading.querySelector('button').addEventListener('click', () => closeAgent(true));
				panel.prepend(heading);
				added = true;
			}
			if (!configuredAgents.has(panel)) {
				configuredAgents.add(panel);
				panel.addEventListener('beforetoggle', (event) => {
					if (panel.isConnected && event.newState === 'closed') { agentWorker = null; attachAgentQuestion(panel); }
				});
				panel.addEventListener('keydown', (event) => {
					if (event.key !== 'Escape') return;
					event.preventDefault();
					event.stopImmediatePropagation();
					closeAgent(true);
				}, true);
			}
			for (const terminal of panel.querySelectorAll('.terminal-panel')) terminal.classList.toggle('overlay-active', terminal.querySelector('[data-terminal]').dataset.terminal === agentWorker);
			attachAgentQuestion(panel);
			if (added) host.contentWindow.lucide?.createIcons();
			if (agentWorker && panel.querySelector('.overlay-active') && !panel.matches(':popover-open')) panel.showPopover();
		}
		function openAgent(worker, trigger) {
			closeDrawer();
			agentWorker = worker;
			agentTrigger = trigger;
			host.contentWindow.ensureHarnessAgent(worker);
			const views = hostDocument.querySelector('.workspace-views');
			if (views) attachAgents(views);
			hostDocument.querySelector('#agents-panel .agent-overlay-heading button')?.focus();
		}
		function attach() {
			const views = hostDocument.querySelector('.workspace-views');
			if (!views) return;
			attachAgents(views);
			let tab = views.querySelector('#merge-tab');
			if (!tab) {
				tab = hostDocument.createElement('button');
				tab.id = 'merge-tab';
				tab.role = 'tab';
				tab.setAttribute('aria-controls', 'initiative-merge-panel');
				tab.textContent = 'Merge';
				views.querySelector('.workspace-tabs').append(tab);
			}
			let panel = views.querySelector('#initiative-merge-panel');
			if (!panel) {
				panel = hostDocument.createElement('section');
				panel.id = 'initiative-merge-panel';
				panel.role = 'tabpanel';
				panel.setAttribute('aria-labelledby', 'merge-tab');
				views.append(panel);
			}
			if (!panel.contains(mergeFrame)) {
				if (mergeFrame.isConnected) panel.moveBefore(mergeFrame, null);
				else panel.append(mergeFrame);
			}
			mergeFrame.style.display = '';
			panel.hidden = !open;
			tab.setAttribute('aria-selected', String(open));
			tab.tabIndex = open ? 0 : -1;
			if (open) {
				for (const sibling of views.querySelectorAll('[data-workspace-panel]')) sibling.hidden = true;
				for (const sibling of views.querySelectorAll('[data-action="workspace-view"]')) { sibling.setAttribute('aria-selected', 'false'); sibling.tabIndex = -1; }
			} else if (mergeFrame.getAttribute('src')) {
				for (const sibling of views.querySelectorAll('[data-workspace-panel]')) sibling.hidden = sibling.dataset.workspacePanel !== view;
				for (const sibling of views.querySelectorAll('[data-action="workspace-view"]')) { sibling.setAttribute('aria-selected', String(sibling.dataset.view === view)); sibling.tabIndex = sibling.dataset.view === view ? 0 : -1; }
			}
			const review = views.querySelector('#review-panel');
			if (review && review.dataset.connected !== `${started}/${integrated}`) {
				review.dataset.connected = `${started}/${integrated}`;
				review.innerHTML = `<section class="connected-review"><h2>${issues[0].reference} / ${issues[0].title}</h2><p>Worker checks and independent review passed. Checkpoint ${issues[0].checkpoint}.</p><p><strong>Add:</strong> ${examples[0].requirement}<br><strong>Keep:</strong> ${examples[0].retained}</p><h3>4 issue files</h3><ul>${filePaths().map((path) => `<li class="mono">${path}</li>`).join('')}</ul><p>${integrated ? 'Integration complete. Open Merge for approval and check evidence. Final merge to main still requires separate approval.' : started ? 'The merge session has started. Review and approve its changed result in Merge. The initiative branch remains unchanged.' : 'Initiative branch unchanged. Approval starts the merge agent inside this initiative.'}</p><button class="primary" data-connected-approve>${integrated ? 'Open merge evidence' : started ? 'Open merge session' : 'Approve merge'}</button></section>`;
			}
		}
		function showMerge(approve, scenario = 'conflict') {
			if (!mergeFrame.getAttribute('src')) mergeFrame.src = `/harness-merge-prototype.html?embedded=1&initiative=1&scenario=${scenario}${approve ? '&approved=1' : ''}`;
			else if (approve && mergeFrame.contentDocument?.querySelector('#merge-workspace')?.dataset.phase === 'review') mergeFrame.contentDocument.querySelector('[data-action="advance"]')?.click();
			if (approve) started = true;
			open = true;
			attach();
			hostDocument.querySelector('#merge-tab').focus();
		}
		hostDocument.addEventListener('click', (event) => {
			if (event.target.closest('.harness-theme-toggle')) { event.preventDefault(); event.stopImmediatePropagation(); theme = theme === 'light' ? 'dark' : 'light'; applyHostTheme(); }
			else if (event.target.closest('[data-connected-approve], [data-action="approve"]')) { event.preventDefault(); event.stopImmediatePropagation(); showMerge(!started && !integrated); }
			else if (event.target.closest('#merge-tab')) { event.preventDefault(); showMerge(false); }
			else if (event.target.closest('[data-agent-worker],[data-action="show-worker"]')) {
				const trigger = event.target.closest('[data-agent-worker],[data-action="show-worker"]');
				event.preventDefault();
				event.stopImmediatePropagation();
				const recordDialog = hostDocument.querySelector('#action-dialog');
				if (recordDialog?.open) recordDialog.close();
				openAgent(trigger.dataset.agentWorker ?? trigger.dataset.id, trigger);
			}
			else if (event.target.closest('[data-action="workspace-view"]')) {
				open = false;
				view = event.target.closest('[data-action="workspace-view"]').dataset.view;
				if (mergeFrame.getAttribute('src')) { event.preventDefault(); event.stopImmediatePropagation(); attach(); }
			}
			else if (event.target.closest('[data-action="reset"]') || event.target.closest('#reset-prototype')) {
				closeAgent(false);
				open = false;
				started = false;
				integrated = false;
				view = 'initiative';
				mergeFrame.removeAttribute('src');
			}
		}, true);
		host.contentWindow.addEventListener('message', (event) => {
			if (event.origin !== location.origin || event.source !== mergeFrame.contentWindow) return;
			if (event.data.type === 'merge-integrated' && event.data.issue === 0) { host.contentWindow.recordHarnessIntegration(event.data.checkpoint); started = true; integrated = true; attach(); }
			if (event.data.type === 'merge-reset') {
				resetControl.click();
				if (['conflict', 'clean', 'failed'].includes(event.data.scenario)) showMerge(false, event.data.scenario);
			}
			if (event.data.type === 'merge-back') { open = false; view = 'review'; attach(); hostDocument.querySelector('#review-tab')?.focus(); }
		});
		hostDocument.addEventListener('keydown', (event) => {
			if (!event.target.closest('.workspace-tabs') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const tabs = [...hostDocument.querySelectorAll('.workspace-tabs [role="tab"]')];
			const index = tabs.indexOf(event.target);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
			tabs[next].click();
			tabs[next].focus();
		}, true);
		new MutationObserver(() => {
			if (!hostDocument.querySelector('#merge-tab')) attach();
			const views = hostDocument.querySelector('.workspace-views');
			if (views) attachAgents(views);
			attachDrawerTrigger();
			attachInbox();
			attachThemeToggle();
			if (drawer.open && drawerOrigins.some(({ marker }) => !marker.isConnected)) closeDrawer();
		}).observe(hostDocument.querySelector('#app'), { childList: true, subtree: true });
		hostDocument.querySelector('#initiative-tab')?.click();
		attach();
		attachDrawerTrigger();
		attachInbox();
		attachThemeToggle();
	});
}
document.addEventListener('click', (event) => {
	if (embedded && event.target.closest('.back-link')) { event.preventDefault(); window.parent.postMessage({ type: 'merge-back' }, location.origin); }
});