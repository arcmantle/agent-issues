const app = document.querySelector('#app');
const dialog = document.querySelector('#action-dialog');
const variants = ['A', 'B', 'C'];
const names = { A: 'Workbench', B: 'Signal room', C: 'Review desk' };
const initialState = () => ({
	page: new URL(location.href).searchParams.get('page') === 'planning' ? 'planning' : 'workspace',
	planningContext: '', nextPlanningContext: 1, planningLaunch: { brief: '', initiative: '', mode: 'plan' },
	planningContexts: [{ id: 'harness', title: 'First-release harness', initiative: 'harness', brief: 'Complete the harness design.', saved: null }],
	mode: 'running', view: 'agents', tab: 'inbox', file: 0, reviewFile: 0, fileQuery: '', collapsedFolders: [], question: true, answerDraft: '', approved: false, integrated: false,
	planningMode: 'pioneer', graphZoom: .8,
	planningSessions: {
		pioneer: { drafts: {}, paused: false, answers: [], messages: [{ role: 'agent', kind: 'Findings', paragraphs: ['Native CLI sessions and a local runner are already selected. Provider control is resolved.', 'Workspace design and approval gates can be considered together. Recovery and usage decisions depend on these results.'] }] },
		plan: { drafts: {}, paused: false, answers: [], messages: [{ role: 'agent', kind: 'Findings and recommendation', paragraphs: ['The current scope permits concurrent initiative runs in different repositories. Each repository has one active initiative.', 'Integration requires approval for each issue. Final merge requires separate approval. I recommend keeping these decisions in the first-release plan.', 'Provider choice, the plan review boundary, and release acceptance are not yet specified.'] }] },
	},
	planEntries: [
		{ role: 'scope', body: 'Support concurrent initiative runs across different repositories.' },
		{ role: 'decision', body: 'Keep one active initiative per repository.' },
		{ role: 'constraint', body: 'Require approval before integration and a separate approval before final merge.' },
	],
	pioneerResolutions: ['Use native CLI terminals. A local runner owns execution.', '', '', '', '', ''],
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
	harness: { title: 'Initiative execution harness', summary: 'Coordinate agents, user decisions, and approved changes.', prd: 'Local execution workspace', story: 'Inspect and control agent work', issues: ['Session recovery', 'Usage limits', 'Approval checkpoint', 'Serial integration', 'Restart confirmation', 'Final merge approval'], adrs: ['Native terminal workspace', 'Approved integration'] },
	navigation: { title: 'Tracker navigation', summary: 'Find tracked requirements and linked work.', prd: 'Connected work navigation', story: 'Browse initiative records', issues: ['Initiative selector', 'Linked record view', 'Work filters'], adrs: ['Shared tracker queries'], run: 'No active run' },
};
const routePrds = [
	{ title: 'Local execution workspace', story: 'Inspect and control agent work', issues: [0, 1, 2] },
	{ title: 'Safe delivery and recovery', story: 'Integrate and recover approved work', issues: [3, 4, 5] },
];
const routeIssues = [
	{ stage: 0, dependencies: [], outcome: 'Restore recorded sessions without restarting interrupted agents automatically.', criteria: ['Restore pending decisions and recorded checkpoints.', 'Require confirmation before an interrupted agent restarts.'], evidence: '2 focused checks passed. Independent review is in progress.' },
	{ stage: 0, dependencies: [], outcome: 'Apply one usage limit across all sessions in a provider integration.', criteria: ['Count usage across workers and repositories.', 'Pause new assignments when the limit is reached.'], evidence: 'Waiting for the user decision. Validation is not complete.' },
	{ stage: 0, dependencies: [], outcome: 'Bind integration approval to the exact recorded changes.', criteria: ['A changed revision requires new approval.', 'Integrate only the approved revision.'], evidence: '6 checks passed. Independent review passed.' },
	{ stage: 1, dependencies: [2], outcome: 'Integrate approved worker changes one issue at a time.', criteria: ['Keep worker changes in isolated worktrees.', 'Send conflicts to the run inbox.'], evidence: 'Not assigned. No validation evidence.' },
	{ stage: 1, dependencies: [0, 1], outcome: 'Check restored state and usage before restarting an interrupted worker.', criteria: ['Read tracker, Git, and session state.', 'Require user confirmation before restart.'], evidence: 'Not assigned. No validation evidence.' },
	{ stage: 2, dependencies: [3, 4], outcome: 'Request separate approval before the initiative branch merges to the target branch.', criteria: ['All required issue changes must be integrated.', 'Do not push automatically.'], evidence: 'Not assigned. No validation evidence.' },
];
const routeReference = (index) => `DEMO-${String(index + 1).padStart(2, '0')}`;
const harnessTickets = [
	{ title: 'Provider control', type: 'research', question: 'How should the harness control native agent sessions?', dependencies: [], position: [24, 24] },
	{ title: 'Workspace design', type: 'prototype', question: 'Which workspace layout makes agents and user decisions easy to inspect?', dependencies: [0], position: [324, 24] },
	{ title: 'Approval gates', type: 'grilling', question: 'Which approvals are required before changes can integrate?', dependencies: [0], position: [624, 24] },
	{ title: 'Recovery model', type: 'research', question: 'How should interrupted work resume without repeating unsafe operations?', dependencies: [1], position: [174, 244] },
	{ title: 'Usage accounting', type: 'task', question: 'What is the shared usage boundary across workers and repositories?', dependencies: [0, 2], position: [474, 244] },
	{ title: 'First-release scope', type: 'grilling', question: 'Which capabilities and limits belong in the first release?', dependencies: [3, 4], position: [324, 464] },
];
const discoveryTickets = [
	{ title: 'Purpose', type: 'grilling', question: 'What result should this work achieve?', dependencies: [], position: [24, 24] },
	{ title: 'Users', type: 'research', question: 'Who needs this result, and what must they be able to do?', dependencies: [0], position: [324, 24] },
	{ title: 'Scope', type: 'grilling', question: 'What belongs in the first version, and what is out of scope?', dependencies: [0], position: [624, 24] },
	{ title: 'Constraints', type: 'research', question: 'Which technical or operational constraints must the work satisfy?', dependencies: [1], position: [174, 244] },
	{ title: 'Acceptance', type: 'task', question: 'What evidence will show that the result is acceptable?', dependencies: [0, 2], position: [474, 244] },
	{ title: 'Delivery', type: 'grilling', question: 'What must be decided before implementation can start?', dependencies: [3, 4], position: [324, 464] },
];
const planningContext = () => state.planningContexts.find((context) => context.id === state.planningContext);
const pioneerTickets = () => state.planningContext === 'harness' ? harnessTickets : discoveryTickets;
function pioneerStatus(index) {
	if (state.pioneerResolutions[index]) return 'Resolved';
	return pioneerTickets()[index].dependencies.some((dependency) => !state.pioneerResolutions[dependency]) ? 'Blocked' : 'Active';
}
const harnessQuestions = [
	{ question: 'Which coding providers must the first release support?', role: 'scope', prefix: 'First-release providers' },
	{ question: 'When should the agent stop planning and ask you to review the plan?', role: 'decision', prefix: 'Plan review boundary' },
	{ question: 'What must be demonstrated before you accept the first release?', role: 'constraint', prefix: 'Release acceptance' },
];
const discoveryQuestions = [
	{ question: 'What problem should this work solve?', role: 'scope', prefix: 'Problem' },
	{ question: 'Who needs the result, and what must they be able to do?', role: 'scope', prefix: 'Intended users' },
	{ question: 'What would make the first version acceptable?', role: 'constraint', prefix: 'Acceptance' },
];
const planQuestions = () => state.planningContext === 'harness' ? harnessQuestions : discoveryQuestions;
const planningSnapshot = () => ({ planningMode: state.planningMode, graphZoom: state.graphZoom, planningSessions: state.planningSessions, planEntries: state.planEntries, pioneerResolutions: state.pioneerResolutions });
function planningStartForm() {
	const draft = state.planningLaunch;
	return `<form class="planning-start-form" data-form="planning-start"><label for="planning-brief">Starting point</label><textarea id="planning-brief" name="brief" rows="5" required>${escapeHtml(draft.brief)}</textarea><label for="planning-initiative">Initiative</label><select id="planning-initiative" name="initiative"><option value="">Not yet defined</option>${Object.entries(initiativeViews).map(([id, initiative]) => `<option value="${id}" ${draft.initiative === id ? 'selected' : ''}>${initiative.title}</option>`).join('')}</select><fieldset><legend>Mode</legend>${['plan', 'pioneer'].map((mode) => `<label><input type="radio" name="mode" value="${mode}" ${draft.mode === mode ? 'checked' : ''} />${mode === 'plan' ? 'Plan' : 'Pioneer'}</label>`).join('')}</fieldset><div class="dialog-actions"><button class="primary">${icon('play')}Start planning</button></div></form>`;
}
function planningSidebar() {
	return `<div class="eyebrow muted">Sessions</div><div class="planning-session-list">${state.planningContexts.map((context) => `<button data-action="planning-session" data-id="${context.id}" ${state.planningContext === context.id ? 'aria-current="true"' : ''}><strong>${escapeHtml(context.title)}</strong><span>${context.initiative ? escapeHtml(initiativeViews[context.initiative].title) : 'Initiative not yet defined'}</span></button>`).join('')}</div>`;
}
function planningPageContent() {
	return planningContext() ? planningWorkspace() : `<section class="planning-start"><h2>New planning session</h2>${planningStartForm()}</section>`;
}
function refreshPlanningPage() {
	app.querySelector('#planning-workspace-content').innerHTML = planningPageContent();
	app.querySelector('#planning-sidebar-content').innerHTML = planningSidebar();
	window.lucide?.createIcons();
}
function switchPlanningContext(id) {
	const current = planningContext();
	if (current) current.saved = planningSnapshot();
	const context = state.planningContexts.find((candidate) => candidate.id === id);
	context.saved ??= planningSnapshot();
	Object.assign(state, context.saved);
	state.planningContext = id;
	refreshPlanningPage();
	app.querySelector('.planning-heading h2').focus();
}
function planningQuestions() {
	if (state.planningMode === 'pioneer') {
		return pioneerTickets().flatMap((ticket, index) => !state.pioneerResolutions[index] && ticket.dependencies.every((dependency) => state.pioneerResolutions[dependency]) ? [{ index, title: ticket.title, question: ticket.question }] : []);
	}
	return planQuestions().flatMap((question, index) => index >= state.planningSessions.plan.answers.length ? [{ index, title: planningContext().title, question: question.question }] : []);
}
function planningSession() {
	const session = state.planningSessions[state.planningMode];
	const questions = planningQuestions();
	const status = session.paused ? 'Paused' : questions.length ? 'Needs your answers' : 'Ready for your review';
	return `<section class="planning-session" aria-label="Planning agent session">
		<div class="planner-agent"><span>${icon('bot')}Planning agent / Copilot</span><div><span class="status ${questions.length ? 'waiting' : 'review'}">${status}</span>${questions.length ? `<button class="icon-button" data-action="planning-pause" title="${session.paused ? 'Resume planning' : 'Pause planning'}" aria-label="${session.paused ? 'Resume planning' : 'Pause planning'}">${icon(session.paused ? 'play' : 'pause')}</button>` : ''}</div></div>
		<ol class="planner-conversation" aria-label="Planning conversation">${session.messages.map((message) => `<li class="planner-message ${message.role}"><div class="planner-message-heading"><strong>${icon(message.role === 'agent' ? 'bot' : 'user')}${message.role === 'agent' ? 'Agent' : 'You'}</strong><span>${escapeHtml(message.kind)}</span></div>${(message.paragraphs || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}${message.answers ? `<dl>${message.answers.map((answer) => `<dt>${escapeHtml(answer.question)}</dt><dd>${escapeHtml(answer.answer)}</dd>`).join('')}</dl>` : ''}${message.records ? `<ul class="planner-message-records">${message.records.map((record) => `<li>${escapeHtml(record)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ol>
		${questions.length ? `<div class="planner-question"><div class="eyebrow muted">Questions / ${questions.length}</div><form data-form="planning-answer" data-mode="${state.planningMode}">${questions.map((question, position) => `<div class="planner-question-field"><div class="eyebrow muted">${state.planningMode === 'pioneer' ? 'Active ticket / ' + question.title : 'Question ' + (question.index + 1) + ' / ' + planQuestions().length}</div><h3>${question.question}</h3><label for="planning-answer-${question.index}">Answer ${position + 1}</label><textarea id="planning-answer-${question.index}" data-planning-question="${question.index}" name="answer-${question.index}" rows="3" required ${session.paused ? 'disabled' : ''}>${escapeHtml(session.drafts[question.index] || '')}</textarea></div>`).join('')}<button class="primary" ${session.paused ? 'disabled' : ''}>${icon('send')}Send answers</button></form></div>` : `<div class="planner-question"><h3>${state.planningMode === 'pioneer' ? 'Map decisions recorded' : 'Draft plan ready'}</h3></div>`}
	</section>`;
}
function pioneerGraph() {
	const edges = pioneerTickets().flatMap((ticket, index) => ticket.dependencies.map((dependency) => {
		const source = pioneerTickets()[dependency].position;
		const target = ticket.position;
		const sameRow = source[1] === target[1];
		const start = sameRow ? [source[0] + 240, source[1] + 70] : [source[0] + 120, source[1] + 150];
		const end = sameRow ? [target[0], target[1] + 70] : [target[0] + 120, target[1]];
		const bend = (start[1] + end[1]) / 2;
		const path = sameRow && index === 2 ? `M ${source[0] + 120} ${source[1]} V 8 H ${target[0] + 120} V ${target[1]}` : sameRow ? `M ${start.join(' ')} H ${end[0]}` : `M ${start.join(' ')} C ${start[0]} ${bend}, ${end[0]} ${bend}, ${end.join(' ')}`;
		return `<path d="${path}" data-source="${dependency}" data-target="${index}" marker-end="url(#pioneer-arrow)" />`;
	}));
	return `<div class="graph-toolbar"><span>${pioneerTickets().length} tickets / ${edges.length} dependencies</span><div><button class="icon-button" data-action="graph-out" title="Zoom out" aria-label="Zoom out">${icon('minus')}</button><output aria-label="Graph zoom">${Math.round(state.graphZoom * 100)}%</output><button class="icon-button" data-action="graph-in" title="Zoom in" aria-label="Zoom in">${icon('plus')}</button><button class="icon-button" data-action="graph-fit" title="Fit graph" aria-label="Fit graph">${icon('scan')}</button></div></div><div class="pioneer-viewport" data-scroll-key="pioneer-graph" tabindex="0" aria-label="Pioneer issue graph"><div class="pioneer-bounds" style="width:${900 * state.graphZoom}px;height:${640 * state.graphZoom}px"><div class="pioneer-canvas" style="transform:scale(${state.graphZoom})"><svg class="pioneer-edges" viewBox="0 0 900 640" aria-hidden="true"><defs><marker id="pioneer-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>${edges.join('')}</svg>${pioneerTickets().map((ticket, index) => `<button class="pioneer-node ${pioneerStatus(index).toLowerCase()}" style="left:${ticket.position[0]}px;top:${ticket.position[1]}px" data-action="pioneer-ticket" data-index="${index}"><span class="route-issue-meta"><span class="mono">PIONEER-${String(index + 1).padStart(2, '0')}</span><span>${pioneerStatus(index)}</span></span><strong>${ticket.title}</strong><span>${ticket.type}</span><small>${ticket.question}</small></button>`).join('')}</div></div></div>`;
}
function singlePlan() {
	return `<div class="single-plan-heading"><div><div class="eyebrow muted">Agent-authored plan / draft</div><h2>${escapeHtml(planningContext().title)}</h2></div><span>${state.planEntries.length} entries</span></div><ol class="plan-entries">${state.planEntries.map((entry, index) => `<li class="plan-entry"><span class="plan-entry-number mono">${String(index + 1).padStart(2, '0')}</span><span><small>${entry.role}</small><span>${escapeHtml(entry.body)}</span></span></li>`).join('')}</ol>`;
}
function planningWorkspace() {
	const context = planningContext();
	return `<section class="planning-workspace"><div class="planning-heading"><div><div class="eyebrow muted">Planning / simulated / ${context.initiative ? escapeHtml(initiativeViews[context.initiative].title) : 'Initiative not yet defined'}</div><h2 tabindex="-1">${escapeHtml(context.title)}</h2></div><div class="planning-modes" role="group" aria-label="Planning mode">${[['pioneer', 'git-branch', 'Pioneer'], ['plan', 'notebook-pen', 'Plan']].map(([mode, symbol, title]) => `<button data-action="planning-mode" data-mode="${mode}" aria-pressed="${state.planningMode === mode}">${icon(symbol)}${title}</button>`).join('')}</div></div><div id="planning-session-content">${planningSession()}</div><section data-planning-panel="pioneer" ${state.planningMode !== 'pioneer' ? 'hidden' : ''}><div class="pioneer-map-summary"><div><div class="eyebrow muted">Pioneer map / destination</div><h3>${escapeHtml(context.title)}</h3><p>${escapeHtml(context.brief)}</p></div><span>${state.pioneerResolutions.filter(Boolean).length} / ${pioneerTickets().length} resolved</span></div><div id="pioneer-graph-content">${pioneerGraph()}</div></section><section data-planning-panel="plan" ${state.planningMode !== 'plan' ? 'hidden' : ''}><div id="single-plan-content">${singlePlan()}</div></section></section>`;
}
function refreshPlanning() {
	const graph = app.querySelector('.pioneer-viewport');
	const scroll = { top: graph?.scrollTop || 0, left: graph?.scrollLeft || 0 };
	app.querySelector('#planning-session-content').innerHTML = planningSession();
	app.querySelector('.pioneer-map-summary > span').textContent = `${state.pioneerResolutions.filter(Boolean).length} / ${pioneerTickets().length} resolved`;
	app.querySelector('#pioneer-graph-content').innerHTML = pioneerGraph();
	app.querySelector('#single-plan-content').innerHTML = singlePlan();
	app.querySelector('.pioneer-viewport').scrollTo(scroll.left, scroll.top);
	window.lucide?.createIcons();
}
function routeState(index) {
	const worker = state.workers[index];
	if (worker) return { label: labels[worker.status], tone: worker.status, detail: `Worker ${worker.id} / attempt ${worker.id}.1` };
	const dependencies = routeIssues[index].dependencies;
	const remaining = dependencies.filter((dependency) => state.workers[dependency]?.status !== 'integrated');
	if (remaining.length) return { label: 'Blocked', tone: 'blocked', detail: `After ${remaining.map(routeReference).join(' + ')} integration` };
	return { label: state.mode === 'running' ? 'Next available' : 'Scheduling paused', tone: 'ready', detail: 'No worker assigned' };
}
function initiativeRoute() {
	const integrated = state.workers.filter((worker) => worker.status === 'integrated').length;
	const issueNode = (index) => {
		const status = routeState(index);
		return `<li><button class="route-issue ${status.tone}" data-action="record" data-kind="issue" data-index="${index}"><span class="route-issue-meta"><span class="mono">${routeReference(index)}</span><span class="status ${status.tone}">${status.label}</span></span><strong>${initiativeViews.harness.issues[index]}</strong><span class="route-issue-detail">${status.detail}</span><span class="route-issue-prd">${icon('file-text')}${routePrds[index < 3 ? 0 : 1].title}${icon('arrow-up-right')}</span></button></li>`;
	};
	return `<section class="initiative-route"><div class="route-heading"><div><div class="eyebrow muted">Initiative / simulated</div><h2>${initiativeViews.harness.title}</h2><p>${initiativeViews.harness.summary}</p></div><span class="route-progress">${integrated} / 6 integrated</span></div><div class="route-prds">${routePrds.map((prd, index) => `<button class="route-prd" data-action="record" data-kind="prd" data-index="${index}">${icon('file-text')}<span><small>PRD ${String(index + 1).padStart(2, '0')}</small><strong>${prd.title}</strong><span>${prd.issues.length} issues / ${prd.story}</span></span>${icon('arrow-up-right')}</button>`).join('')}</div><div class="route-summary"><h3>Work route</h3><span>${icon('git-branch')}Dependencies wait for integration</span></div><ol class="work-route" aria-label="Initiative issue route">${['Current work', 'Next work', 'Final approval'].map((title, stage) => `<li class="route-stage"><div class="route-stage-heading"><span class="route-step">${stage + 1}</span><div><h3>${title}</h3><span>${['3 assigned / independent work', 'After prerequisite integration', 'After delivery and recovery'][stage]}</span></div>${stage < 2 ? icon('arrow-right') : icon('flag')}</div><ul class="route-issues">${routeIssues.flatMap((issue, index) => issue.stage === stage ? [issueNode(index)] : []).join('')}</ul></li>`).join('')}</ol></section>`;
}
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
	const prds = viewedInitiative === 'harness' ? routePrds : [{ title: initiative.prd, story: initiative.story, issues: [0, 1, 2] }];
	return `<section class="initiative-navigation"><label class="eyebrow muted" for="initiative-selector">Initiative</label><select id="initiative-selector" aria-label="Select initiative">${Object.entries(initiativeViews).map(([key, value]) => `<option value="${key}" ${viewedInitiative === key ? 'selected' : ''}>${value.title}</option>`).join('')}</select><div class="scope-run">${viewedInitiative === 'harness' ? `Run 004 / ${runLabel()}` : initiative.run}</div>${viewedInitiative !== 'harness' ? '<button class="active-run-link" data-action="active-run">' + icon('activity') + 'Harness / ' + runLabel() + '</button>' : ''}<nav class="tracked-work" aria-label="Initiative work"><details open><summary>PRDs / ${prds.length}</summary>${prds.map((prd, prdIndex) => `${row(prd.title, 'prd', prdIndex, 'Draft')}<details open class="story-group"><summary>User story</summary>${row(prd.story, 'story', prdIndex, 'In progress')}<div class="issue-group">${prd.issues.map((index) => row(initiative.issues[index], 'issue', index, viewedInitiative === 'harness' ? routeState(index).label : 'Ready')).join('')}</div></details>`).join('')}</details><details><summary>ADRs / ${initiative.adrs.length}</summary>${initiative.adrs.map((title, index) => row(title, 'adr', index, 'Current')).join('')}</details></nav></section>`;
}
function workerList(title = 'Agents') {
	return `<div class="section-label eyebrow"><span>${title}</span><span>${state.workers.filter((worker) => worker.visible).length} visible</span></div><div class="worker-list">${state.workers.map((worker) => `<label class="worker-row ${worker.visible ? 'selected' : ''}"><span class="worker-number">${worker.id}</span><span><strong>Worker ${worker.id}</strong><small>${labels[worker.status]}</small></span><input type="checkbox" data-worker="${worker.id}" ${worker.visible ? 'checked' : ''} aria-label="Show Worker ${worker.id} terminal" /></label>`).join('')}</div>`;
}
function usage() {
	return `<section class="usage"><div class="usage-heading"><span class="eyebrow muted">Usage / simulated</span><button data-action="limits" title="Edit usage limits" aria-label="Edit usage limits">${icon('sliders-horizontal')}</button></div><div class="usage-label"><span>Copilot requests</span><span class="mono">18 / ${state.limits.copilot}</span></div><progress max="${state.limits.copilot}" value="18" aria-label="Simulated Copilot usage"></progress><div class="usage-label"><span>Interpreter calls</span><span class="mono">42 / ${state.limits.interpreter}</span></div><progress max="${state.limits.interpreter}" value="42" aria-label="Simulated interpreter usage"></progress></section>`;
}
function rail(review = false) {
	const browsing = review && viewedInitiative !== 'harness';
	return `<aside class="rail"><div class="rail-project"><div class="brand"><span class="brand-mark">${icon('workflow')}</span>agent-issues</div><div class="eyebrow">Repository</div><h3>agent-issues</h3><p class="mono muted">local-roen / main</p></div><div class="sidebar-scope" ${review ? `data-sidebar-panel="workspace" ${state.page !== 'workspace' ? 'hidden' : ''}` : ''}>${review ? trackedWork() : ''}${!review && !browsing ? `<section>${workerList()}</section>` : ''}${review && !browsing ? '<section class="review-queue"><div class="eyebrow muted">Integration queue</div><div class="queue-row"><strong>Approval checkpoint</strong><span class="status review">' + (state.integrated ? 'Integrated' : 'Awaiting approval') + '</span></div><div class="queue-row"><strong>Session recovery</strong><span class="muted">Independent review</span></div><div class="queue-row"><strong>Usage limits</strong><span class="muted">' + (state.question ? 'Needs a decision' : 'In progress') + '</span></div></section>' : ''}${!browsing ? usage() : ''}</div>${review ? `<section id="planning-sidebar-content" data-sidebar-panel="planning" ${state.page !== 'planning' ? 'hidden' : ''}>${planningSidebar()}</section>` : ''}</aside>`;
}
function applicationNavigation() {
	return `<nav class="application-navigation" aria-label="Application pages">${[['workspace', 'activity', 'Workspace'], ['planning', 'notebook-pen', 'Planning']].map(([page, symbol, label]) => `<a href="?variant=C&page=${page}" data-action="page" data-page="${page}" aria-label="${label}" ${state.page === page ? 'aria-current="page"' : ''}>${icon(symbol)}<span class="page-tooltip" aria-hidden="true">${label}</span></a>`).join('')}</nav>`;
}
function terminalGrid() {
	const selected = state.workers.filter((worker) => worker.visible);
	const selection = variant === 'C' ? `<section class="agent-selection" aria-label="Terminal selection">${workerList('Terminal selection')}</section>` : '';
	if (!selected.length) return `${selection}<section class="empty-terminals"><h2>No terminals selected</h2><p>Agent execution is unchanged.</p></section>`;
	return `${selection}<div class="terminal-grid" data-count="${selected.length}">${selected.map((worker) => `<section class="terminal-panel" aria-label="Worker ${worker.id} terminal"><div class="terminal-header"><strong>Worker ${worker.id} / Copilot</strong><span class="status ${worker.status}">${labels[worker.status]}</span></div><div class="terminal-meta"><span>${worker.issue}</span><span>attempt ${worker.id}.1</span></div><div class="terminal-host" data-terminal="${worker.id}"></div><div class="terminal-footer"><span>${worker.manual ? 'Input: you' : 'Input: harness'}</span><button data-action="takeover" data-id="${worker.id}">${icon(worker.manual ? 'undo-2' : 'keyboard')}${worker.manual ? 'Return control' : 'Take control'}</button></div></section>`).join('')}</div>`;
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
function switchPage(page, updateHistory = true) {
	rememberScroll();
	state.page = page;
	app.querySelectorAll('[data-page-panel], [data-sidebar-panel]').forEach((panel) => { panel.hidden = (panel.dataset.pagePanel || panel.dataset.sidebarPanel) !== page; });
	app.querySelectorAll('[data-action="page"]').forEach((link) => {
		if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
		else link.removeAttribute('aria-current');
	});
	if (updateHistory) {
		const url = new URL(location.href);
		url.searchParams.set('page', page);
		history.pushState(null, '', url);
	}
	app.querySelector(`[data-page-panel="${page}"]`).scrollTop = scrollPositions[page === 'planning' ? 'planning-page' : `workspace-${state.view}`] || 0;
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
	let workspace;
	if (viewedInitiative !== 'harness') {
		const initiative = initiativeViews[viewedInitiative];
		workspace = `<section class="workspace" data-page-panel="workspace" ${state.page !== 'workspace' ? 'hidden' : ''}>${runHeader()}<section class="initiative-overview"><h2>${initiative.prd}</h2><p>${initiative.summary}</p><div class="overview-heading"><h3>Issues</h3><span class="muted">3 ready / no assignments</span></div>${initiative.issues.map((title, index) => `<button class="tracked-record" data-action="record" data-kind="issue" data-index="${index}"><span>${icon('circle-dot')}${title}</span><small>Ready</small></button>`).join('')}</section></section>`;
	} else {
		workspace = `<section class="workspace" data-page-panel="workspace" data-scroll-key="workspace-${state.view}" ${state.page !== 'workspace' ? 'hidden' : ''}>${runHeader()}<div class="workspace-body"><section class="workspace-views"><div class="workspace-tabs" role="tablist" aria-label="Workspace view">${[['agents', 'terminal', 'Agents'], ['review', 'file-diff', 'Review'], ['initiative', 'route', 'Initiative']].map(([view, symbol, label]) => `<button id="${view}-tab" role="tab" data-action="workspace-view" data-view="${view}" aria-controls="${view}-panel" aria-selected="${state.view === view}">${icon(symbol)}${label}</button>`).join('')}</div><section id="agents-panel" role="tabpanel" aria-labelledby="agents-tab" data-workspace-panel="agents" class="review-terminals" ${state.view !== 'agents' ? 'hidden' : ''}><div class="viewport-label"><span class="eyebrow">Agent viewport</span><span>${state.workers.filter((worker) => worker.visible).length} selected terminals</span></div>${terminalGrid()}</section><section id="review-panel" role="tabpanel" aria-labelledby="review-tab" data-workspace-panel="review" ${state.view !== 'review' ? 'hidden' : ''}>${reviewCheckpoint()}</section><section id="initiative-panel" role="tabpanel" aria-labelledby="initiative-tab" data-workspace-panel="initiative" ${state.view !== 'initiative' ? 'hidden' : ''}>${initiativeRoute()}</section></section><aside class="run-inbox" aria-label="Run inbox">${runInbox()}</aside></div></section>`;
	}
	return `<div class="review-layout">${applicationNavigation()}${rail(true)}${workspace}<section class="workspace planning-page" data-page-panel="planning" data-scroll-key="planning-page" ${state.page !== 'planning' ? 'hidden' : ''}><header class="page-heading"><h1>Planning</h1><button class="primary" data-action="new-planning-session">${icon('plus')}New session</button></header><div id="planning-workspace-content">${planningPageContent()}</div></section></div>`;
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
		const theme = variant === 'C' ? { background: '#f6f7f6', foreground: '#445149', cursor: '#245c48', selectionBackground: '#dce9e2' } : { background: '#17201c', foreground: '#cfddd2', cursor: '#c9ed6a', selectionBackground: '#42604c' };
		const terminal = new window.Terminal({ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, lineHeight: 1.45, cursorBlink: worker.manual, theme, scrollback: 300, convertEol: true });
		const fit = new window.FitAddon.FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host);
		if (host.offsetWidth && host.offsetHeight) fit.fit();
		const headingColor = variant === 'C' ? '82;103;90' : '201;237;106';
		const passColor = variant === 'C' ? '36;92;72' : '145;221;210';
		worker.lines.forEach((line, index) => terminal.writeln(index === 0 ? `\x1b[38;2;${headingColor}m${line}\x1b[0m` : line.startsWith('PASS') ? `\x1b[38;2;${passColor}m${line}\x1b[0m` : line));
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
	dialog.removeAttribute('aria-labelledby');
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
	if (action === 'page') { event.preventDefault(); switchPage(button.dataset.page); return; }
	if (action === 'new-planning-session') {
		const current = planningContext();
		if (current) current.saved = planningSnapshot();
		state.planningContext = '';
		refreshPlanningPage();
		app.querySelector('#planning-brief').focus();
		return;
	}
	if (action === 'planning-session') { switchPlanningContext(button.dataset.id); return; }
	if (action === 'open-review') { switchWorkspace('review'); return; }
	if (action === 'workspace-view') { switchWorkspace(button.dataset.view); return; }
	if (action === 'planning-mode') {
		state.planningMode = button.dataset.mode;
		app.querySelectorAll('[data-planning-panel]').forEach((panel) => { panel.hidden = panel.dataset.planningPanel !== state.planningMode; });
		app.querySelectorAll('[data-action="planning-mode"]').forEach((control) => control.setAttribute('aria-pressed', String(control.dataset.mode === state.planningMode)));
		app.querySelector('#planning-session-content').innerHTML = planningSession();
		window.lucide?.createIcons();
		return;
	}
	if (action === 'planning-pause') {
		const session = state.planningSessions[state.planningMode];
		session.paused = !session.paused;
		refreshPlanning();
		app.querySelector('[data-action="planning-pause"]').focus();
		return;
	}
	if (['graph-in', 'graph-out', 'graph-fit'].includes(action)) {
		const viewport = app.querySelector('.pioneer-viewport');
		state.graphZoom = action === 'graph-fit' ? Math.min(1, (viewport.clientWidth - 16) / 900, (viewport.clientHeight - 16) / 640) : Math.max(.3, Math.min(1.5, state.graphZoom + (action === 'graph-in' ? .1 : -.1)));
		refreshPlanning();
		if (action === 'graph-fit') app.querySelector('.pioneer-viewport').scrollTo(0, 0);
		app.querySelector(`[data-action="${action}"]`).focus();
		return;
	}
	if (action === 'pioneer-ticket') {
		const index = Number(button.dataset.index);
		const ticket = pioneerTickets()[index];
		dialog.setAttribute('aria-labelledby', 'planning-record-title');
		dialog.innerHTML = `<div class="eyebrow muted">Pioneer ticket / ${ticket.type} / ${pioneerStatus(index)}</div><h2 id="planning-record-title">${ticket.title}</h2><section class="record-section"><h3>Question</h3><p>${ticket.question}</p></section><section class="record-section"><h3>Dependencies</h3>${ticket.dependencies.length ? ticket.dependencies.map((dependency) => `<button class="record-link" data-action="pioneer-ticket" data-index="${dependency}">${icon('circle-dot')}${pioneerTickets()[dependency].title} / ${pioneerStatus(dependency)}</button>`).join('') : '<p>No prerequisites.</p>'}</section><section class="record-section"><h3>Agent-recorded resolution</h3><p>${escapeHtml(state.pioneerResolutions[index] || 'Not yet resolved.')}</p></section><div class="dialog-actions"><button data-action="close-dialog">Close</button></div>`;
		window.lucide?.createIcons();
		if (!dialog.open) dialog.showModal();
		else { dialog.scrollTop = 0; dialog.querySelector('button').focus(); }
		return;
	}
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
		const prds = viewedInitiative === 'harness' ? routePrds : [{ title: initiative.prd, story: initiative.story, issues: [0, 1, 2] }];
		const title = ({ prd: prds.map((prd) => prd.title), story: prds.map((prd) => prd.story), issue: initiative.issues, adr: initiative.adrs })[kind][index];
		const worker = viewedInitiative === 'harness' && kind === 'issue' ? state.workers[index] : null;
		const issue = viewedInitiative === 'harness' && kind === 'issue' ? routeIssues[index] : null;
		const status = issue ? routeState(index) : null;
		const linkedIssue = (issueIndex) => `<button class="record-link" data-action="record" data-kind="issue" data-index="${issueIndex}">${icon('circle-dot')}${routeReference(issueIndex)} / ${initiative.issues[issueIndex]}</button>`;
		const dependents = issue ? routeIssues.flatMap((candidate, candidateIndex) => candidate.dependencies.includes(index) ? [candidateIndex] : []) : [];
		dialog.setAttribute('aria-labelledby', 'record-title');
		dialog.innerHTML = `<div class="eyebrow muted">${kind === 'story' ? 'User story' : kind.toUpperCase()} / simulated record</div><h2 id="record-title">${title}</h2><p>${initiative.title}</p>${issue ? `<div class="record-state"><span class="mono">${routeReference(index)}</span><span class="status ${status.tone}">${status.label}</span><span>${status.detail}</span></div><section class="record-section"><h3>Outcome</h3><p>${issue.outcome}</p></section><section class="record-section"><h3>Acceptance criteria</h3><ul>${issue.criteria.map((criterion) => `<li>${criterion}</li>`).join('')}</ul></section><section class="record-section"><h3>Requirements</h3><button class="record-link" data-action="record" data-kind="prd" data-index="${index < 3 ? 0 : 1}">${icon('file-text')}${prds[index < 3 ? 0 : 1].title}</button><span class="muted">${prds[index < 3 ? 0 : 1].story}</span></section><section class="record-section"><h3>Dependencies / integration gates</h3>${issue.dependencies.length ? issue.dependencies.map(linkedIssue).join('') : '<p>No prerequisites. Independent work.</p>'}${dependents.length ? `<h3>Unblocks</h3>${dependents.map(linkedIssue).join('')}` : ''}</section><section class="record-section"><h3>Validation and review</h3><p>${issue.evidence}</p>${worker?.status === 'integrated' ? '<p>User approval recorded. Changes integrated.</p>' : ''}</section>${worker ? `<button data-action="show-worker" data-id="${worker.id}">${icon('terminal')}Show terminal</button>` : ''}` : `<p>${initiative.summary}</p>${['prd', 'story'].includes(kind) ? `<section class="record-section"><h3>Linked issues</h3>${prds[index].issues.map(linkedIssue).join('')}</section>` : ''}`}<div class="dialog-actions"><button data-action="close-dialog">Close</button></div>`;
		window.lucide?.createIcons();
		if (!dialog.open) dialog.showModal();
		else { dialog.scrollTop = 0; dialog.querySelector('button').focus(); }
		return;
	}
	if (action === 'active-run') viewedInitiative = 'harness';
	if (action === 'show-worker') {
		state.view = 'agents';
		state.workers.find((worker) => worker.id === button.dataset.id).visible = true;
		dialog.close();
		if (variant === 'C' && app.querySelector(`[data-terminal="${button.dataset.id}"]`)) switchWorkspace('agents');
		else render();
		app.querySelector(`[data-action="takeover"][data-id="${button.dataset.id}"]`)?.focus();
		return;
	}
	if (['terminate', 'limits'].includes(action)) { openDialog(action); return; }
	if (action === 'close-dialog') {
		dialog.close();
		return;
	}
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
	if (event.target.closest('[data-form="planning-start"]')) {
		state.planningLaunch[event.target.name] = event.target.value;
		event.target.setCustomValidity('');
	}
	if (event.target.matches('.answer-form [name="answer"]')) state.answerDraft = event.target.value;
	if (event.target.matches('[data-planning-question]')) {
		state.planningSessions[event.target.form.dataset.mode].drafts[event.target.dataset.planningQuestion] = event.target.value;
		event.target.setCustomValidity('');
	}
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
	app.querySelector(`[data-worker="${event.target.dataset.worker}"]`)?.focus();
});
document.addEventListener('submit', (event) => {
	const form = event.target;
	if (!form.dataset.form) return;
	event.preventDefault();
	const values = new FormData(form);
	if (form.dataset.form === 'planning-start') {
		const brief = String(values.get('brief') || '').trim();
		if (!brief) { form.querySelector('textarea').setCustomValidity('Enter a starting point.'); form.reportValidity(); return; }
		state.planningContexts[0].saved ??= planningSnapshot();
		const initiative = String(values.get('initiative') || '') || null;
		const opening = [{ role: 'user', kind: 'Starting point', paragraphs: [brief] }, { role: 'agent', kind: 'Planning approach', paragraphs: [initiative ? `This session is scoped to ${initiativeViews[initiative].title}.` : 'The initiative is not yet defined.', 'I will establish the purpose, users, scope, and acceptance criteria before implementation.'] }];
		const context = { id: `session-${state.nextPlanningContext++}`, title: brief.split('\n')[0].slice(0, 72), brief, initiative, saved: {
			planningMode: String(values.get('mode')), graphZoom: .8,
			planningSessions: { pioneer: { drafts: {}, paused: false, answers: [], messages: structuredClone(opening) }, plan: { drafts: {}, paused: false, answers: [], messages: structuredClone(opening) } },
			planEntries: [], pioneerResolutions: ['', '', '', '', '', ''],
		} };
		state.planningContexts.push(context);
		state.planningLaunch = { brief: '', initiative: '', mode: 'plan' };
		switchPlanningContext(context.id);
		notify('Simulated planning session started. No initiative or execution run was created.');
		return;
	}
	if (form.dataset.form === 'planning-answer') {
		if (form.dataset.mode !== state.planningMode) return;
		const session = state.planningSessions[state.planningMode];
		const questions = planningQuestions();
		if (session.paused || !questions.length) return;
		const answers = questions.map((question) => ({ ...question, answer: String(values.get(`answer-${question.index}`) || '').trim() }));
		const missing = answers.find((answer) => !answer.answer);
		if (missing) {
			const field = form.querySelector(`[data-planning-question="${missing.index}"]`);
			field.setCustomValidity('Enter an answer.');
			field.reportValidity();
			return;
		}
		answers.forEach((question) => {
			const result = state.planningMode === 'pioneer' ? `${question.title}: ${question.answer}` : `${planQuestions()[question.index].prefix}: ${question.answer}`;
			if (state.planningMode === 'pioneer') state.pioneerResolutions[question.index] = result;
			else state.planEntries.push({ role: planQuestions()[question.index].role, body: result });
			session.answers.push({ question: question.question, answer: question.answer, result });
			delete session.drafts[question.index];
		});
		session.messages.push({ role: 'user', kind: 'Answers', answers: answers.map((answer) => ({ question: answer.question, answer: answer.answer })) });
		const nextQuestions = planningQuestions();
		session.messages.push({
			role: 'agent', kind: nextQuestions.length ? 'Planning update' : 'Review summary',
			paragraphs: [`Recorded ${answers.length} planning answers.`, nextQuestions.length ? `The next unresolved topics are ${nextQuestions.map((question) => question.title).join(', ')}.` : 'The draft is ready for your review. No execution or integration was started.'],
			records: session.answers.slice(-answers.length).map((answer) => answer.result),
		});
		refreshPlanning();
		(app.querySelector('[data-planning-question]') || app.querySelector('[data-action="planning-mode"][aria-pressed="true"]')).focus();
		notify('Simulated planning agent recorded your answers.');
		return;
	}
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
window.addEventListener('popstate', () => { if (variant === 'C') switchPage(new URL(location.href).searchParams.get('page') === 'planning' ? 'planning' : 'workspace', false); });
document.querySelector('#reset-prototype').addEventListener('click', () => { state = initialState(); viewedInitiative = 'harness'; scrollPositions = {}; app.querySelectorAll('[data-scroll-key]').forEach((region) => { region.scrollTop = 0; }); app.querySelectorAll('.checkpoint-files [data-folder]').forEach((folder) => { folder.open = true; }); render(); notify('Simulation reset.'); });
document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape' && dialog.open) { event.preventDefault(); dialog.requestClose(); return; }
	if (event.target.matches('[data-action="workspace-view"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
		event.preventDefault();
		const views = ['agents', 'review', 'initiative'];
		const current = views.indexOf(event.target.dataset.view);
		const view = event.key === 'Home' ? views[0] : event.key === 'End' ? views.at(-1) : views[(current + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length];
		switchWorkspace(view);
		app.querySelector(`[data-action="workspace-view"][data-view="${view}"]`).focus();
		return;
	}
	if (event.target.closest('input, textarea, select, [contenteditable], .xterm, .pioneer-viewport, .application-navigation') || dialog.open) return;
	if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
		event.preventDefault();
		changeVariant(event.key === 'ArrowRight' ? 1 : -1);
	}
});
render();