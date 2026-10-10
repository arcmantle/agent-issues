const app = document.querySelector('#app');
const dialog = document.querySelector('#action-dialog');
const variants = ['A', 'B', 'C'];
const names = { A: 'Workbench', B: 'Signal room', C: 'Review desk' };
const applicationPages = ['workspace', 'planning', 'repositories', 'global-settings', 'project-settings'];
const settingsProviders = {
	copilot: { name: 'Copilot', models: ['Default', 'GPT-5'] },
	claude: { name: 'Claude', models: ['Sonnet', 'Opus'] },
	ollama: { name: 'Ollama', models: ['qwen3:8b', 'llama3.2'] },
};
const repositories = {
	'agent-issues': { name: 'agent-issues', projectIdentity: 'agent-issues', path: '/Users/roen/Developer/Personal/agent-issues', tenant: 'local-roen', initiatives: ['harness', 'navigation'] },
	'studio-site': { name: 'studio-site / example', projectIdentity: 'studio-site', path: '~/projects/studio-site', tenant: 'local-roen', initiatives: ['studio'] },
	'task-api': { name: 'task-api / example', projectIdentity: 'task-api', path: '~/projects/task-api', tenant: 'local-roen', initiatives: ['api'] },
};
let folderRequest = 0;
let folderBrowser = { path: '', parent: null, root: '', entries: [], loading: false, error: '' };
const initialState = () => ({
	repository: 'agent-issues',
	repositoryViews: Object.fromEntries(Object.entries(repositories).map(([id, repository]) => [id, { initiative: repository.initiatives[0], planningContext: '', planningLaunch: { brief: '', initiative: '', mode: 'plan' } }])),
	page: applicationPages.includes(new URL(location.href).searchParams.get('page')) ? new URL(location.href).searchParams.get('page') : 'workspace',
	repositoryQuery: '', nextRepository: 1,
	settings: {
		global: { budget: 200, warning: 150, projectBudget: 50, workers: 8, projectWorkers: 3, approval: true, providers: ['copilot'], models: Object.fromEntries(Object.entries(settingsProviders).map(([id, provider]) => [id, [...provider.models]])), connections: { copilot: true, claude: false, ollama: false } },
		projects: {}, usage: { 'agent-issues': 23.60, 'studio-site': 9.80, 'task-api': 19.00 },
	},
	planningContext: '', nextPlanningContext: 1, planningLaunch: { brief: '', initiative: '', mode: 'plan' },
	planningContexts: [{ id: 'harness', mode: 'pioneer', repository: 'agent-issues', projectIdentity: 'agent-issues', title: 'First-release harness', initiative: 'harness', brief: 'Complete the harness design.', saved: null }],
	mode: 'running', view: 'agents', tab: 'inbox', file: 0, reviewFile: 0, fileQuery: '', collapsedFolders: [], question: true, answerDraft: '', approved: false, integrated: false,
	planningMode: 'pioneer', pioneerView: 'session', graphZoom: .8,
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
	studio: { title: 'Studio portfolio', summary: 'Present selected work and project details.', prd: 'Portfolio navigation', story: 'Inspect selected work', issues: ['Project index', 'Project detail', 'Contact form'], adrs: ['Static content'], run: 'No active run' },
	api: { title: 'Task service', summary: 'Manage tasks through a project-scoped API.', prd: 'Task API', story: 'Manage project tasks', issues: ['Task list', 'Task updates', 'Access control'], adrs: ['Project-scoped access'], run: 'No active run' },
};
const repositoryInitiatives = () => Object.entries(initiativeViews).filter(([id]) => repositories[state.repository].initiatives.includes(id));
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
const planningSnapshot = () => ({ planningMode: state.planningMode, pioneerView: state.pioneerView, graphZoom: state.graphZoom, planningSessions: state.planningSessions, planEntries: state.planEntries, pioneerResolutions: state.pioneerResolutions });
function planningStartForm() {
	const draft = state.planningLaunch;
	return `<form class="planning-start-form" data-form="planning-start" data-repository="${state.repository}"><label for="planning-brief">Starting point</label><textarea id="planning-brief" name="brief" rows="5" required>${escapeHtml(draft.brief)}</textarea><label for="planning-initiative">Initiative</label><select id="planning-initiative" name="initiative"><option value="">Not yet defined</option>${repositoryInitiatives().map(([id, initiative]) => `<option value="${id}" ${draft.initiative === id ? 'selected' : ''}>${initiative.title}</option>`).join('')}</select><fieldset><legend>Mode</legend>${['plan', 'pioneer'].map((mode) => `<label><input type="radio" name="mode" value="${mode}" ${draft.mode === mode ? 'checked' : ''} />${mode === 'plan' ? 'Plan' : 'Pioneer'}</label>`).join('')}</fieldset><div class="dialog-actions"><button class="primary">${icon('play')}Start planning</button></div></form>`;
}
function planningSidebar() {
	const contexts = state.planningContexts.filter((context) => context.repository === state.repository);
	return `<div class="eyebrow muted">Sessions</div><div class="planning-session-list">${contexts.map((context) => `<button data-action="planning-session" data-id="${context.id}" ${state.planningContext === context.id ? 'aria-current="true"' : ''}><strong>${escapeHtml(context.title)}</strong><span>${context.initiative ? escapeHtml(initiativeViews[context.initiative].title) : 'Initiative not yet defined'}</span></button>`).join('')}</div>${contexts.length ? '' : '<p class="muted planning-empty">No planning work.</p>'}`;
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
	const context = state.planningContexts.find((candidate) => candidate.id === id && candidate.repository === state.repository);
	if (!context) return;
	const current = planningContext();
	if (current) current.saved = planningSnapshot();
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
	const modes = `<span class="planning-modes">${icon(context.mode === 'pioneer' ? 'git-branch' : 'notebook-pen')}${context.mode === 'pioneer' ? 'Pioneer' : 'Plan'}</span>`;
	const pioneer = context.mode === 'pioneer';
	const tabs = pioneer ? `<div class="workspace-tabs" role="tablist" aria-label="Pioneer view">${[['session', 'messages-square', 'Planning session'], ['map', 'git-branch', 'Pioneer map']].map(([view, symbol, title]) => `<button id="pioneer-${view}-tab" role="tab" data-action="pioneer-view" data-view="${view}" aria-controls="pioneer-${view}-panel" aria-selected="${state.pioneerView === view}" tabindex="${state.pioneerView === view ? 0 : -1}">${icon(symbol)}${title}</button>`).join('')}</div>` : '';
	return `<section class="planning-workspace"><div class="planning-heading"><div><div class="eyebrow muted">Planning / simulated / ${context.initiative ? escapeHtml(initiativeViews[context.initiative].title) : 'Initiative not yet defined'}</div><h2 tabindex="-1">${escapeHtml(context.title)}</h2></div>${modes}</div>${tabs}<section id="pioneer-session-panel" ${pioneer ? `role="tabpanel" aria-labelledby="pioneer-session-tab" data-pioneer-view="session" ${state.pioneerView !== 'session' ? 'hidden' : ''}` : ''}><div id="planning-session-content">${planningSession()}</div></section><section id="pioneer-map-panel" data-planning-panel="pioneer" ${pioneer ? 'role="tabpanel" aria-labelledby="pioneer-map-tab" data-pioneer-view="map"' : ''} ${!pioneer || state.pioneerView !== 'map' ? 'hidden' : ''}><div class="pioneer-map-summary"><div><div class="eyebrow muted">Pioneer map / destination</div><h3>${escapeHtml(context.title)}</h3><p>${escapeHtml(context.brief)}</p></div><span>${state.pioneerResolutions.filter(Boolean).length} / ${pioneerTickets().length} resolved</span></div><div id="pioneer-graph-content">${pioneerGraph()}</div></section><section data-planning-panel="plan" ${state.planningMode !== 'plan' ? 'hidden' : ''}><div id="single-plan-content">${singlePlan()}</div></section></section>`;
}
function switchPioneerView(view) {
	if (planningContext()?.mode !== 'pioneer' || !['session', 'map'].includes(view)) return;
	state.pioneerView = view;
	app.querySelectorAll('[data-pioneer-view]').forEach((panel) => { panel.hidden = panel.dataset.pioneerView !== view; });
	app.querySelectorAll('[data-action="pioneer-view"]').forEach((tab) => {
		tab.setAttribute('aria-selected', String(tab.dataset.view === view));
		tab.tabIndex = tab.dataset.view === view ? 0 : -1;
	});
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
function runHeader(showBrand = false, initiativeId = viewedInitiative) {
	const browsing = variant === 'C' && initiativeId !== 'harness';
	return `<header class="run-header"><div>${showBrand ? '<div class="brand">agent-issues / harness</div>' : ''}<h1>${browsing ? initiativeViews[initiativeId].title : initiativeViews.harness.title}</h1><div class="run-subtitle">${browsing ? '<span>No active run</span><span>Read-only view</span>' : `<span class="status ${state.mode}">${runLabel()}</span><span class="mono">harness/initiative</span><span>Run 004</span>`}</div></div>${browsing ? '<button data-action="active-run">' + icon('arrow-left') + 'agent-issues / ' + runLabel() + '</button>' : controls()}</header>`;
}
function trackedWork() {
	const initiative = initiativeViews[viewedInitiative];
	if (!initiative) return '<section><h3>No initiatives</h3><button data-action="page" data-page="planning">' + icon('notebook-pen') + 'Start planning</button></section>';
	const row = (title, kind, index, status) => `<button class="tracked-record" data-action="record" data-kind="${kind}" data-index="${index}"><span>${icon(kind === 'issue' ? 'circle-dot' : 'file-text')}<span>${title}</span></span><small>${status}</small></button>`;
	const prds = viewedInitiative === 'harness' ? routePrds : [{ title: initiative.prd, story: initiative.story, issues: [0, 1, 2] }];
	return `<section class="initiative-navigation"><label class="eyebrow muted" for="initiative-selector">Initiative</label><select id="initiative-selector" aria-label="Select initiative">${repositoryInitiatives().map(([key, value]) => `<option value="${key}" ${viewedInitiative === key ? 'selected' : ''}>${value.title}</option>`).join('')}</select><div class="scope-run">${viewedInitiative === 'harness' ? `Run 004 / ${runLabel()}` : initiative.run}</div>${viewedInitiative !== 'harness' ? '<button class="active-run-link" data-action="active-run">' + icon('activity') + 'agent-issues / ' + runLabel() + '</button>' : ''}<nav class="tracked-work" aria-label="Initiative work"><details open><summary>PRDs / ${prds.length}</summary>${prds.map((prd, prdIndex) => `${row(prd.title, 'prd', prdIndex, 'Draft')}<details open class="story-group"><summary>User story</summary>${row(prd.story, 'story', prdIndex, 'In progress')}<div class="issue-group">${prd.issues.map((index) => row(initiative.issues[index], 'issue', index, viewedInitiative === 'harness' ? routeState(index).label : 'Ready')).join('')}</div></details>`).join('')}</details><details><summary>ADRs / ${initiative.adrs.length}</summary>${initiative.adrs.map((title, index) => row(title, 'adr', index, 'Current')).join('')}</details></nav></section>`;
}
function workerList(title = 'Agents') {
	return `<div class="section-label eyebrow"><span>${title}</span><span>${state.workers.filter((worker) => worker.visible).length} visible</span></div><div class="worker-list">${state.workers.map((worker) => `<label class="worker-row ${worker.visible ? 'selected' : ''}"><span class="worker-number">${worker.id}</span><span><strong>Worker ${worker.id}</strong><small>${labels[worker.status]}</small></span><input type="checkbox" data-worker="${worker.id}" ${worker.visible ? 'checked' : ''} aria-label="Show Worker ${worker.id} terminal" /></label>`).join('')}</div>`;
}
function usage() {
	return `<section class="usage"><div class="usage-heading"><span class="eyebrow muted">Usage / simulated</span><button data-action="limits" title="Edit usage limits" aria-label="Edit usage limits">${icon('sliders-horizontal')}</button></div><div class="usage-label"><span>Copilot requests</span><span class="mono">18 / ${state.limits.copilot}</span></div><progress max="${state.limits.copilot}" value="18" aria-label="Simulated Copilot usage"></progress><div class="usage-label"><span>Interpreter calls</span><span class="mono">42 / ${state.limits.interpreter}</span></div><progress max="${state.limits.interpreter}" value="42" aria-label="Simulated interpreter usage"></progress></section>`;
}
function rail(review = false) {
	const browsing = review && viewedInitiative !== 'harness';
	return `<aside class="rail"><div class="rail-project">${repositoryHeader(review)}</div><div class="sidebar-scope" ${review ? `data-sidebar-panel="workspace" ${state.page !== 'workspace' ? 'hidden' : ''}` : ''}>${review ? trackedWork() : ''}${!review && !browsing ? `<section>${workerList()}</section>` : ''}${review && !browsing ? '<section class="review-queue"><div class="eyebrow muted">Integration queue</div><div class="queue-row"><strong>Approval checkpoint</strong><span class="status review">' + (state.integrated ? 'Integrated' : 'Awaiting approval') + '</span></div><div class="queue-row"><strong>Session recovery</strong><span class="muted">Independent review</span></div><div class="queue-row"><strong>Usage limits</strong><span class="muted">' + (state.question ? 'Needs a decision' : 'In progress') + '</span></div></section>' : ''}${!browsing ? usage() : ''}</div>${review ? `<section id="planning-sidebar-content" data-sidebar-panel="planning" ${state.page !== 'planning' ? 'hidden' : ''}>${planningSidebar()}</section>` : ''}</aside>`;
}
function repositoryHeader(review) {
	const brand = `<div class="brand"><span class="brand-mark">${icon('workflow')}</span>agent-issues</div>`;
	if (!review) return `${brand}<div class="eyebrow">Repository</div><h3>agent-issues</h3><p class="mono muted">local-roen / main</p>`;
	const repository = repositories[state.repository];
	return `<div role="region" aria-label="Current repository"><div class="repository-heading"><div class="brand current-project"><span>${icon('folder-git-2')}</span><span>${escapeHtml(repository.name)}</span></div><a class="project-settings-link" href="?variant=C&page=project-settings" data-action="page" data-page="project-settings" aria-label="Project Settings" title="Project Settings" ${state.page === 'project-settings' ? 'aria-current="page"' : ''}>${icon('settings-2')}</a></div><p class="repository-path mono muted">${escapeHtml(repository.path)}</p><p class="repository-project muted">Project / ${escapeHtml(repository.projectIdentity || 'Not connected')}</p><p class="muted">Tenant / ${escapeHtml(repository.tenant)}</p></div>`;
}
function selectRepository(id) {
	if (id === state.repository || !repositories[id]) return;
	rememberScroll();
	state.planningContexts[0].saved ??= planningSnapshot();
	const current = planningContext();
	if (current) current.saved = planningSnapshot();
	state.repositoryViews[state.repository] = { initiative: viewedInitiative, planningContext: state.planningContext, planningLaunch: state.planningLaunch };
	state.repository = id;
	const view = state.repositoryViews[id];
	viewedInitiative = view.initiative;
	state.planningContext = view.planningContext;
	state.planningLaunch = view.planningLaunch;
	const context = planningContext();
	if (context?.saved) Object.assign(state, context.saved);
	app.querySelector('.rail').outerHTML = rail(true);
	app.querySelector('.rail').dataset.scrollKey = `sidebar-${id}`;
	app.querySelector('.rail').scrollTop = scrollPositions[`sidebar-${id}`] || 0;
	app.querySelector('#repository-workspace-view').dataset.repositoryScope = id === 'agent-issues' ? 'other' : id;
	app.querySelector('#repository-workspace-view').dataset.scrollKey = `repository-workspace-${id}`;
	app.querySelector('#repository-workspace-view').innerHTML = id === 'agent-issues' ? '' : repositoryWorkspace();
	app.querySelector('.planning-page').dataset.scrollKey = `planning-page-${id}`;
	refreshPlanningPage();
	switchPage(state.page, false);
	app.dataset.repository = id;
	app.dataset.projectIdentity = repositories[id].projectIdentity || '';
	refreshSettings();
	refreshRepositories();
	window.lucide?.createIcons();
}
function repositoryWorkspace() {
	const initiative = initiativeViews[viewedInitiative];
	if (!initiative) return `<header class="run-header"><div><h1>${escapeHtml(repositories[state.repository].name)}</h1><div class="run-subtitle"><span>No active run</span></div></div><button data-action="active-run">${icon('arrow-left')}agent-issues / ${runLabel()}</button></header><section class="initiative-overview"><h2>No initiatives</h2><button data-action="page" data-page="planning">${icon('notebook-pen')}Start planning</button></section>`;
	return `${runHeader()}<section class="initiative-overview"><h2>${initiative.prd}</h2><p>${initiative.summary}</p><div class="overview-heading"><h3>Issues</h3><span class="muted">${initiative.issues.length} ready / no assignments</span></div>${initiative.issues.map((title, index) => `<button class="tracked-record" data-action="record" data-kind="issue" data-index="${index}"><span>${icon('circle-dot')}${title}</span><small>Ready</small></button>`).join('')}</section>`;
}
function applicationNavigation() {
	return `<div class="application-navigation"><nav class="repository-pages" aria-label="Repository pages">${[['workspace', 'activity', 'Workspace'], ['planning', 'notebook-pen', 'Planning']].map(([page, symbol, label]) => `<a href="?variant=C&page=${page}" data-action="page" data-page="${page}" aria-label="${label}" ${state.page === page ? 'aria-current="page"' : ''}>${icon(symbol)}<span class="page-tooltip" aria-hidden="true">${label}</span></a>`).join('')}</nav><nav class="repository-navigation" aria-label="Global navigation">${[['repositories', 'folders', 'Repositories'], ['global-settings', 'settings', 'Global Settings']].map(([page, symbol, label]) => `<a href="?variant=C&page=${page}" data-action="page" data-page="${page}" aria-label="${label}" ${state.page === page ? 'aria-current="page"' : ''}>${icon(symbol)}<span class="page-tooltip" aria-hidden="true">${label}</span></a>`).join('')}</nav></div>`;
}
function effectiveProjectSettings(id = state.repository) {
	const global = state.settings.global;
	const project = state.settings.projects[id] || {};
	const budget = Math.min(project.budget ?? global.projectBudget, global.budget);
	const providers = (project.providers ?? global.providers).filter((provider) => global.providers.includes(provider));
	return {
		budget,
		warning: Math.min(project.warning ?? budget * .8, budget, global.warning),
		workers: Math.min(project.workers ?? global.projectWorkers, global.workers),
		approval: global.approval || (project.approval ?? global.approval),
		providers,
		models: Object.fromEntries(Object.keys(settingsProviders).map((provider) => [provider, (project.models?.[provider] ?? global.models[provider]).filter((model) => global.models[provider].includes(model))])),
	};
}
function settingsMoney(value) {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}
function settingsUsage(scope) {
	const global = state.settings.global;
	const effective = effectiveProjectSettings();
	const total = Object.values(state.settings.usage).reduce((sum, value) => sum + value, 0);
	const used = scope === 'global' ? total : state.settings.usage[state.repository] || 0;
	const budget = scope === 'global' ? global.budget : effective.budget;
	const warning = scope === 'global' ? global.warning : effective.warning;
	const status = total >= global.budget ? 'Global stop limit reached' : used >= budget ? 'Project stop limit reached' : total >= global.warning || used >= warning ? 'Warning threshold reached' : 'Within limits';
	return `<section class="settings-usage" aria-label="${scope === 'global' ? 'Global' : 'Project'} usage"><div class="section-label"><h2>Usage</h2><span class="muted">Current month / Estimated / Example</span></div><dl><div><dt>Spend</dt><dd>${settingsMoney(used)}</dd></div><div><dt>Remaining budget</dt><dd>${settingsMoney(Math.max(0, budget - used))}</dd></div>${scope === 'project' ? `<div><dt>Global remaining</dt><dd>${settingsMoney(Math.max(0, global.budget - total))}</dd></div>` : `<div><dt>Stop limit</dt><dd>${settingsMoney(budget)}</dd></div>`}<div><dt>Limit state</dt><dd class="settings-limit-state">${status}</dd></div></dl></section>`;
}
function settingsNumber(scope, key, label, value, maximum, integer = false) {
	const override = scope === 'project' ? state.settings.projects[state.repository]?.[key] : undefined;
	const inherited = scope === 'project' && override == null;
	return `<div class="settings-field" data-setting-row="${key}"><label for="${scope}-${key}">${label}</label>${scope === 'project' ? `<label class="settings-toggle"><input type="checkbox" name="override-${key}" data-setting-override="${key}" aria-label="Override ${escapeHtml(label)}" ${inherited ? '' : 'checked'} />Project override</label>` : ''}<input id="${scope}-${key}" name="${key}" type="number" min="${integer ? 1 : 0}" ${maximum == null ? '' : `max="${maximum}"`} step="${integer ? 1 : '.01'}" value="${value}" ${inherited ? 'disabled' : 'required'} /><span class="muted" data-setting-source>${inherited ? 'Inherited' : scope === 'project' ? 'Project override' : 'Global'} / ${integer ? value : settingsMoney(value)}</span></div>`;
}
function settingsModelSelector(scope, id, provider, effective, inherited) {
	const blocked = (model) => scope === 'project' && !state.settings.global.models[id].includes(model);
	return `<div class="settings-model-selector"><button type="button" class="settings-model-trigger" popovertarget="${scope}-${id}-models" aria-label="${provider.name} permitted models"><span>Models</span><span data-model-count>${effective.models[id].length} selected</span>${icon('chevron-down')}</button><div id="${scope}-${id}-models" class="settings-model-menu" popover="auto" role="group" aria-label="${provider.name} permitted models"><input type="search" data-model-search aria-label="Search ${provider.name} models" placeholder="Search models" autofocus /><label class="settings-toggle"><input type="checkbox" data-model-selected-only />Selected only</label><div class="settings-models">${provider.models.map((model) => `<label class="settings-toggle" data-model-option><input type="checkbox" name="models-${id}" value="${escapeHtml(model)}" data-setting-control="models" ${effective.models[id].includes(model) ? 'checked' : ''} ${inherited || blocked(model) ? 'disabled' : ''} data-global-blocked="${blocked(model)}" />${escapeHtml(model)}${blocked(model) ? ' / Blocked globally' : ''}</label>`).join('')}</div><p class="muted" data-model-empty hidden>No models found</p></div></div>`;
}
function positionSettingsModels(menu) {
	const trigger = menu.closest('.settings-model-selector').querySelector('.settings-model-trigger');
	const bounds = trigger.getBoundingClientRect();
	const width = Math.min(360, window.innerWidth - 24);
	const below = window.innerHeight - bounds.bottom - 20;
	const above = bounds.top - 20;
	const useBelow = below >= Math.min(360, above);
	const height = Math.max(0, Math.min(360, useBelow ? below : above));
	menu.style.width = `${width}px`;
	menu.style.maxHeight = `${height}px`;
	menu.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
	menu.style.top = useBelow ? `${bounds.bottom + 8}px` : 'auto';
	menu.style.bottom = useBelow ? 'auto' : `${window.innerHeight - bounds.top + 8}px`;
}
function filterSettingsModels(selector) {
	const query = selector.querySelector('[data-model-search]').value.trim().toLowerCase();
	const selectedOnly = selector.querySelector('[data-model-selected-only]').checked;
	let visible = 0;
	let selected = 0;
	for (const option of selector.querySelectorAll('[data-model-option]')) {
		const input = option.querySelector('input');
		if (input.checked) selected++;
		option.hidden = !input.value.toLowerCase().includes(query) || selectedOnly && !input.checked;
		if (!option.hidden) visible++;
	}
	selector.querySelector('[data-model-count]').textContent = `${selected} selected`;
	selector.querySelector('[data-model-empty]').hidden = visible > 0;
}
function settingsProvidersForm(scope) {
	const global = state.settings.global;
	const project = state.settings.projects[state.repository] || {};
	const effective = scope === 'global' ? global : effectiveProjectSettings();
	const inheritedProviders = scope === 'project' && project.providers == null;
	const inheritedModels = scope === 'project' && project.models == null;
	return `<section class="settings-section"><h2>Providers And Models</h2>${scope === 'project' ? `<div class="settings-fields"><label>Permitted providers<select name="provider-mode" data-setting-group="providers"><option value="inherit" ${inheritedProviders ? 'selected' : ''}>Inherited</option><option value="custom" ${inheritedProviders ? '' : 'selected'}>Project override</option></select></label><label>Permitted models<select name="model-mode" data-setting-group="models"><option value="inherit" ${inheritedModels ? 'selected' : ''}>Inherited</option><option value="custom" ${inheritedModels ? '' : 'selected'}>Project override</option></select></label></div>` : ''}<div class="settings-provider-list">${Object.entries(settingsProviders).map(([id, provider]) => `<fieldset class="settings-provider"><legend>${provider.name}</legend><label class="settings-toggle"><input type="checkbox" name="providers" value="${id}" data-setting-control="providers" ${effective.providers.includes(id) ? 'checked' : ''} ${(inheritedProviders || scope === 'project' && !global.providers.includes(id)) ? 'disabled' : ''} data-global-blocked="${scope === 'project' && !global.providers.includes(id)}" />Permitted${scope === 'project' && !global.providers.includes(id) ? ' / Blocked globally' : ''}</label>${scope === 'global' ? `<div class="settings-connection"><span data-connection-status="${id}">${global.connections[id] ? 'Connected / Example' : 'Not connected'}</span><button type="button" data-action="settings-connect" data-provider="${id}">${icon(global.connections[id] ? 'unlink' : 'plug')}${global.connections[id] ? 'Disconnect' : 'Connect'}</button></div>` : ''}${settingsModelSelector(scope, id, provider, effective, inheritedModels)}</fieldset>`).join('')}</div></section>`;
}
function settingsContent(scope) {
	const global = state.settings.global;
	const effective = scope === 'global' ? global : effectiveProjectSettings();
	const project = state.settings.projects[state.repository] || {};
	return `<header class="page-heading"><h1>${scope === 'global' ? 'Global Settings' : 'Project Settings'}</h1>${scope === 'project' ? `<button data-action="page" data-page="global-settings">${icon('settings')}Global Settings</button>` : ''}</header><div class="settings-content">${settingsUsage(scope)}<form data-form="settings" data-scope="${scope}" data-repository="${state.repository}"><section class="settings-section"><h2>Cost Controls</h2><div class="settings-fields">${settingsNumber(scope, 'budget', scope === 'global' ? 'Global stop limit / USD' : 'Project stop limit / USD', effective.budget, scope === 'global' ? null : global.budget)}${settingsNumber(scope, 'warning', 'Warning threshold / USD', effective.warning, scope === 'global' ? null : Math.min(global.warning, effective.budget))}${scope === 'global' ? settingsNumber(scope, 'projectBudget', 'Default project budget / USD', global.projectBudget, global.budget) : ''}</div>${scope === 'project' ? `<p class="muted">Global stop limit / ${settingsMoney(global.budget)}. Global warning threshold / ${settingsMoney(global.warning)}.</p>` : `<div class="settings-fields">${settingsNumber(scope, 'copilotRequests', 'Copilot request limit', state.limits.copilot, null, true)}${settingsNumber(scope, 'interpreterCalls', 'Interpreter call limit', state.limits.interpreter, null, true)}</div>`}</section><section class="settings-section"><h2>Workers And Approvals</h2><div class="settings-fields">${settingsNumber(scope, 'workers', scope === 'global' ? 'Total worker limit' : 'Project worker limit', effective.workers, scope === 'global' ? null : global.workers, true)}${scope === 'global' ? settingsNumber(scope, 'projectWorkers', 'Default project worker limit', global.projectWorkers, global.workers, true) : ''}</div>${scope === 'project' ? `<p class="muted">Global worker limit / ${global.workers}</p><label>New-run approval<select name="approval"><option value="inherit" ${project.approval == null ? 'selected' : ''}>Inherited / ${global.approval ? 'Required' : 'Not required'}</option><option value="true" ${project.approval === true ? 'selected' : ''}>Required</option><option value="false" ${project.approval === false && !global.approval ? 'selected' : ''} ${global.approval ? 'disabled' : ''}>Not required${global.approval ? ' / Blocked globally' : ''}</option></select></label>` : `<label class="settings-toggle"><input type="checkbox" name="approval" ${global.approval ? 'checked' : ''} />Require approval for new runs</label>`}<div class="settings-approvals"><label class="settings-toggle"><input type="checkbox" checked disabled />Integration approval / Required</label><label class="settings-toggle"><input type="checkbox" checked disabled />Final merge approval / Required</label></div></section>${settingsProvidersForm(scope)}<p class="settings-error" role="alert"></p><div class="settings-actions"><span class="muted" role="status" data-settings-status>Saved / This session</span>${scope === 'project' ? `<button type="button" data-action="settings-inherit">${icon('rotate-ccw')}Use Global Defaults</button>` : ''}<button class="primary" type="submit">${icon('save')}Save Settings</button></div></form></div>`;
}
function settingsPage(scope) {
	return `<section class="workspace settings-page" data-page-panel="${scope}-settings" data-settings-scope="${scope}" data-scroll-key="${scope}-settings" ${state.page === `${scope}-settings` ? '' : 'hidden'}>${settingsContent(scope)}</section>`;
}
function refreshSettings() {
	for (const panel of app.querySelectorAll('[data-settings-scope]')) panel.innerHTML = settingsContent(panel.dataset.settingsScope);
	window.lucide?.createIcons();
}
function saveSettings(form, values) {
	const scope = form.dataset.scope;
	if (scope === 'project' && form.dataset.repository !== state.repository) return;
	const global = state.settings.global;
	const next = scope === 'global' ? { ...global } : {};
	for (const key of scope === 'global' ? ['budget', 'warning', 'projectBudget', 'workers', 'projectWorkers'] : ['budget', 'warning', 'workers']) {
		if (scope === 'global' || values.has(`override-${key}`)) next[key] = Number(values.get(key));
	}
	next.approval = scope === 'global' ? values.has('approval') : values.get('approval') === 'inherit' ? null : values.get('approval') === 'true';
	if (scope === 'global' || values.get('provider-mode') === 'custom') next.providers = values.getAll('providers');
	if (scope === 'global' || values.get('model-mode') === 'custom') next.models = Object.fromEntries(Object.keys(settingsProviders).map((id) => [id, values.getAll(`models-${id}`)]));
	const budget = next.budget ?? Math.min(global.projectBudget, global.budget);
	const warning = next.warning ?? Math.min(budget * .8, global.warning);
	let error = '';
	if (warning > budget) error = 'The warning threshold must not exceed the stop limit.';
	if (scope === 'global' && (next.projectBudget > budget || next.projectWorkers > next.workers)) error = 'Project defaults must not exceed global limits.';
	if (scope === 'project' && (budget > global.budget || warning > global.warning || (next.workers ?? global.projectWorkers) > global.workers || next.approval === false && global.approval)) error = 'Project settings must not exceed global limits.';
	const providers = next.providers ?? global.providers;
	const models = next.models ?? global.models;
	if (scope === 'project' && (providers.some((id) => !global.providers.includes(id)) || Object.keys(settingsProviders).some((id) => models[id].some((model) => !global.models[id].includes(model))))) error = 'Only globally permitted providers and models are available.';
	if (providers.some((id) => !models[id].length)) error = 'Select at least one model for each permitted provider.';
	if (error) { form.querySelector('.settings-error').textContent = error; return; }
	if (scope === 'global') {
		state.settings.global = next;
		state.limits = { copilot: Number(values.get('copilotRequests')), interpreter: Number(values.get('interpreterCalls')) };
		const usagePanel = app.querySelector('.rail .usage');
		if (usagePanel) usagePanel.outerHTML = usage();
	} else state.settings.projects[state.repository] = next;
	refreshSettings();
	app.querySelector(`[data-settings-scope="${scope}"] [type="submit"]`).focus({ preventScroll: true });
	notify('Simulated settings saved for this session.');
}
function repositoryList() {
	const query = state.repositoryQuery.trim().toLowerCase();
	const matches = Object.entries(repositories).filter(([, repository]) => [repository.name, repository.path, repository.projectIdentity || '', repository.tenant].some((value) => value.toLowerCase().includes(query)));
	return `<div class="repository-list-heading"><h2>Configured repositories</h2><span class="muted">${matches.length} / ${Object.keys(repositories).length}</span></div>${matches.length ? `<ul class="repository-list">${matches.map(([id, repository]) => `<li class="repository-row"><div class="repository-name">${icon('folder-git-2')}<div><h3>${escapeHtml(repository.name)}</h3><p class="mono muted">${escapeHtml(repository.path)}</p>${id === state.repository ? '<span class="repository-current">Selected</span>' : ''}</div></div><div class="repository-identity"><span class="eyebrow muted">Agent Issues project</span><strong>${escapeHtml(repository.projectIdentity || 'Not connected')}</strong><span class="muted">${escapeHtml(repository.tenant)}</span></div><div class="repository-run"><span class="status ${id === 'agent-issues' ? state.mode : ''}">${id === 'agent-issues' ? runLabel() : 'No active run'}</span><span class="muted">${repository.initiatives.length} ${repository.initiatives.length === 1 ? 'initiative' : 'initiatives'}</span></div><button data-action="repository-open" data-id="${id}" aria-label="Open ${escapeHtml(repository.name)}">${icon('arrow-up-right')}Open</button></li>`).join('')}</ul>` : '<div class="repository-empty"><h3>No repositories found</h3><p class="muted">No match for this search.</p></div>'}`;
}
function repositoriesPage() {
	return `<section class="workspace repositories-page" data-page-panel="repositories" data-scroll-key="repositories-page" ${state.page !== 'repositories' ? 'hidden' : ''}><header class="page-heading"><h1>Repositories</h1><button class="primary" data-action="open-folder">${icon('folder-open')}Open folder</button></header><div class="repositories-content"><div class="repository-search"><label for="repository-search">Search repositories</label><div>${icon('search')}<input id="repository-search" type="search" value="${escapeHtml(state.repositoryQuery)}" placeholder="Name, project, or path" /></div></div><div id="repository-list-content">${repositoryList()}</div></div></section>`;
}
function refreshRepositories() {
	const list = app.querySelector('#repository-list-content');
	if (!list) return;
	list.innerHTML = repositoryList();
	window.lucide?.createIcons();
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
	app.dataset.page = page;
	if (page === 'repositories') refreshRepositories();
	app.querySelectorAll('[data-page-panel], [data-sidebar-panel]').forEach((panel) => { panel.hidden = (panel.dataset.pagePanel || panel.dataset.sidebarPanel) !== page || Boolean(panel.dataset.repositoryScope && panel.dataset.repositoryScope !== state.repository); });
	app.querySelectorAll('[data-action="page"]').forEach((link) => {
		if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
		else link.removeAttribute('aria-current');
	});
	if (updateHistory) {
		const url = new URL(location.href);
		url.searchParams.set('page', page);
		history.pushState(null, '', url);
	}
	const panel = app.querySelector(`[data-page-panel="${page}"]:not([hidden])`);
	panel.scrollTop = scrollPositions[panel.dataset.scrollKey] || 0;
	if (document.activeElement === document.body || document.activeElement?.closest('[data-page-panel][hidden], [data-sidebar-panel][hidden]')) {
		const heading = panel.querySelector('h1');
		heading?.setAttribute('tabindex', '-1');
		heading?.focus({ preventScroll: true });
	}
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
	const workspaceInitiative = state.repository === 'agent-issues' ? viewedInitiative : state.repositoryViews['agent-issues'].initiative;
	let workspace;
	if (workspaceInitiative !== 'harness') {
		const initiative = initiativeViews[workspaceInitiative];
		workspace = `<section class="workspace" data-page-panel="workspace" data-repository-scope="agent-issues" ${state.page !== 'workspace' || state.repository !== 'agent-issues' ? 'hidden' : ''}>${runHeader(false, workspaceInitiative)}<section class="initiative-overview"><h2>${initiative.prd}</h2><p>${initiative.summary}</p><div class="overview-heading"><h3>Issues</h3><span class="muted">3 ready / no assignments</span></div>${initiative.issues.map((title, index) => `<button class="tracked-record" data-action="record" data-kind="issue" data-index="${index}"><span>${icon('circle-dot')}${title}</span><small>Ready</small></button>`).join('')}</section></section>`;
	} else {
		workspace = `<section class="workspace" data-page-panel="workspace" data-repository-scope="agent-issues" data-scroll-key="workspace-${state.view}" ${state.page !== 'workspace' || state.repository !== 'agent-issues' ? 'hidden' : ''}>${runHeader(false, workspaceInitiative)}<div class="workspace-body"><section class="workspace-views"><div class="workspace-tabs" role="tablist" aria-label="Workspace view">${[['agents', 'terminal', 'Agents'], ['review', 'file-diff', 'Review'], ['initiative', 'route', 'Initiative']].map(([view, symbol, label]) => `<button id="${view}-tab" role="tab" data-action="workspace-view" data-view="${view}" aria-controls="${view}-panel" aria-selected="${state.view === view}">${icon(symbol)}${label}</button>`).join('')}</div><section id="agents-panel" role="tabpanel" aria-labelledby="agents-tab" data-workspace-panel="agents" class="review-terminals" ${state.view !== 'agents' ? 'hidden' : ''}><div class="viewport-label"><span class="eyebrow">Agent viewport</span><span>${state.workers.filter((worker) => worker.visible).length} selected terminals</span></div>${terminalGrid()}</section><section id="review-panel" role="tabpanel" aria-labelledby="review-tab" data-workspace-panel="review" ${state.view !== 'review' ? 'hidden' : ''}>${reviewCheckpoint()}</section><section id="initiative-panel" role="tabpanel" aria-labelledby="initiative-tab" data-workspace-panel="initiative" ${state.view !== 'initiative' ? 'hidden' : ''}>${initiativeRoute()}</section></section><aside class="run-inbox" aria-label="Run inbox">${runInbox()}</aside></div></section>`;
	}
	return `<div class="review-layout">${applicationNavigation()}${rail(true)}${workspace}<section id="repository-workspace-view" class="workspace" data-page-panel="workspace" data-repository-scope="${state.repository === 'agent-issues' ? 'other' : state.repository}" data-scroll-key="repository-workspace-${state.repository}" ${state.page !== 'workspace' || state.repository === 'agent-issues' ? 'hidden' : ''}>${state.repository === 'agent-issues' ? '' : repositoryWorkspace()}</section><section class="workspace planning-page" data-page-panel="planning" data-scroll-key="planning-page-${state.repository}" ${state.page !== 'planning' ? 'hidden' : ''}><header class="page-heading"><h1>Planning</h1><button class="primary" data-action="new-planning-session">${icon('plus')}New session</button></header><div id="planning-workspace-content">${planningPageContent()}</div></section></div>`;
}
function render() {
	rememberScroll();
	rememberFolders();
	terminals.forEach(({ terminal, observer }) => { observer.disconnect(); terminal.dispose(); });
	terminals = [];
	app.innerHTML = ({ A: VariantA, B: VariantB, C: VariantC })[variant]();
	if (variant === 'C') app.querySelector('.review-layout').insertAdjacentHTML('beforeend', repositoriesPage() + settingsPage('global') + settingsPage('project'));
	document.querySelector('#variant-label').textContent = `${variant} / ${names[variant]}`;
	document.body.dataset.variant = variant;
	app.dataset.view = state.view;
	app.dataset.page = state.page;
	for (const tab of app.querySelectorAll('[data-action="workspace-view"]')) tab.tabIndex = tab.dataset.view === state.view ? 0 : -1;
	app.querySelector('.review-layout .rail')?.setAttribute('data-scroll-key', `sidebar-${state.repository}`);
	app.dataset.repository = state.repository;
	app.dataset.projectIdentity = repositories[state.repository].projectIdentity || '';
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
function renderFolderBrowser() {
	if (!dialog.open || !dialog.querySelector('#folder-browser-content')) return;
	dialog.querySelector('#folder-browser-content').innerHTML = `<div class="folder-navigation"><button class="icon-button" data-action="folder-browse" data-path="" title="Home folder" aria-label="Home folder">${icon('house')}</button><button class="icon-button" data-action="folder-browse" data-path="${escapeHtml(folderBrowser.root)}" title="File system root" aria-label="File system root" ${!folderBrowser.root ? 'disabled' : ''}>${icon('hard-drive')}</button><button class="icon-button" data-action="folder-browse" data-path="${escapeHtml(folderBrowser.parent || '')}" title="Parent folder" aria-label="Parent folder" ${!folderBrowser.parent ? 'disabled' : ''}>${icon('arrow-up')}</button></div><form data-form="browse-folder"><label for="folder-path">Folder path</label><div class="folder-path-control"><input id="folder-path" name="path" value="${escapeHtml(folderBrowser.path)}" required /><button class="icon-button" title="Go to folder" aria-label="Go to folder">${icon('arrow-right')}</button></div></form>${folderBrowser.error ? `<p role="alert">${escapeHtml(folderBrowser.error)}</p>` : ''}<div class="folder-browser-list" aria-busy="${folderBrowser.loading}">${folderBrowser.loading ? '<p role="status">Loading folders...</p>' : folderBrowser.entries.length ? folderBrowser.entries.map((entry) => `<button data-action="folder-browse" data-path="${escapeHtml(entry.path)}">${icon('folder')}<span>${escapeHtml(entry.name)}</span>${icon('chevron-right')}</button>`).join('') : '<p class="muted">No subfolders.</p>'}</div>`;
	dialog.querySelector('[data-action="folder-select"]').disabled = folderBrowser.loading || !folderBrowser.path || Boolean(folderBrowser.error);
	window.lucide?.createIcons();
}
async function browseFolders(path = '') {
	const request = ++folderRequest;
	folderBrowser.loading = true;
	folderBrowser.error = '';
	renderFolderBrowser();
	try {
		const response = await fetch(`/api/folders?path=${encodeURIComponent(path)}`);
		const result = await response.json();
		if (request !== folderRequest || !dialog.open || !dialog.querySelector('#folder-browser-content')) return;
		if (!response.ok) throw new Error(result.error);
		folderBrowser = { ...result, loading: false, error: '' };
	} catch (error) {
		if (request !== folderRequest) return;
		folderBrowser.loading = false;
		folderBrowser.error = error.message || 'Folders could not be loaded.';
	}
	renderFolderBrowser();
	dialog.querySelector('#folder-path')?.focus();
}
async function openSelectedFolder() {
	const request = ++folderRequest;
	const path = folderBrowser.path;
	folderBrowser.loading = true;
	renderFolderBrowser();
	try {
		const response = await fetch(`/api/repository?path=${encodeURIComponent(path)}`);
		const result = await response.json();
		if (request !== folderRequest || !dialog.open || !dialog.querySelector('#folder-browser-content')) return;
		if (!response.ok) throw new Error(result.error);
		let id = Object.keys(repositories).find((key) => repositories[key].path === result.path);
		if (!id) {
			const matches = await Promise.all(Object.entries(repositories).map(async ([key, repository]) => {
				try {
					const configured = await fetch(`/api/repository?path=${encodeURIComponent(repository.path)}`);
					const resolved = await configured.json();
					return configured.ok && resolved.path === result.path ? key : null;
				} catch { return null; }
			}));
			if (request !== folderRequest || !dialog.open || !dialog.querySelector('#folder-browser-content')) return;
			id = matches.find(Boolean);
		}
		if (!id) {
			id = `local-${state.nextRepository++}`;
			repositories[id] = { name: result.name, path: result.path, projectIdentity: null, tenant: 'Not connected', initiatives: [], added: true };
			state.repositoryViews[id] = { initiative: null, planningContext: '', planningLaunch: { brief: '', initiative: '', mode: 'plan' } };
		}
		state.repositoryQuery = '';
		app.querySelector('#repository-search').value = '';
		dialog.close();
		selectRepository(id);
		switchPage('workspace');
	} catch (error) {
		if (request !== folderRequest) return;
		folderBrowser.loading = false;
		folderBrowser.error = error.message || 'The repository could not be opened.';
		renderFolderBrowser();
	}
}
function openDialog(action) {
	dialog.removeAttribute('aria-labelledby');
	if (action === 'open-folder') {
		dialog.setAttribute('aria-labelledby', 'open-folder-heading');
		folderBrowser = { path: '', parent: null, root: '', entries: [], loading: false, error: '' };
		dialog.innerHTML = `<h2 id="open-folder-heading">Open folder</h2><div id="folder-browser-content"></div><div class="dialog-actions"><button data-action="close-dialog">Cancel</button><button class="primary" data-action="folder-select" disabled>${icon('folder-open')}Open repository</button></div>`;
	} else if (action === 'terminate') {
		dialog.innerHTML = `<form data-form="terminate"><h2>Terminate workers?</h2><p>Worker processes will end immediately. Recorded work remains available. Interrupted writes may be incomplete.</p><div class="dialog-actions"><button type="button" data-action="close-dialog">Cancel</button><button class="danger">${icon('octagon-x')}Terminate</button></div></form>`;
	} else {
		dialog.innerHTML = `<form data-form="limits"><h2>Usage limits / simulated</h2><label>Copilot requests<input type="number" name="copilot" min="18" value="${state.limits.copilot}" required /></label><label>Interpreter calls<input type="number" name="interpreter" min="42" value="${state.limits.interpreter}" required /></label><div class="dialog-actions"><button type="button" data-action="close-dialog">Cancel</button><button class="primary">Save limits</button></div></form>`;
	}
	window.lucide?.createIcons();
	dialog.showModal();
	if (action === 'open-folder') browseFolders();
}
document.addEventListener('click', (event) => {
	const button = event.target.closest('[data-action]');
	if (!button || button.disabled) return;
	const action = button.dataset.action;
	if (action === 'limits' && variant === 'C') { switchPage('global-settings'); return; }
	if (action === 'settings-inherit') { delete state.settings.projects[state.repository]; refreshSettings(); app.querySelector('[data-action="settings-inherit"]').focus(); notify('Project settings now inherit global defaults.'); return; }
	if (action === 'settings-connect') {
		const id = button.dataset.provider;
		state.settings.global.connections[id] = !state.settings.global.connections[id];
		const connected = state.settings.global.connections[id];
		app.querySelector(`[data-connection-status="${id}"]`).textContent = connected ? 'Connected / Example' : 'Not connected';
		button.innerHTML = `${icon(connected ? 'unlink' : 'plug')}${connected ? 'Disconnect' : 'Connect'}`;
		window.lucide?.createIcons();
		notify('Simulated provider connection updated.');
		return;
	}
	if (action === 'active-run' && state.repository !== 'agent-issues') {
		selectRepository('agent-issues');
		if (viewedInitiative === 'harness') return;
	}
	if (action === 'page') {
		event.preventDefault();
		switchPage(button.dataset.page);
		return;
	}
	if (action === 'open-folder') { openDialog(action); return; }
	if (action === 'folder-browse') { browseFolders(button.dataset.path); return; }
	if (action === 'folder-select') { openSelectedFolder(); return; }
	if (action === 'repository-open') { selectRepository(button.dataset.id); switchPage('workspace'); return; }
	if (action === 'new-planning-session') {
		const current = planningContext();
		if (current) current.saved = planningSnapshot();
		state.planningContext = '';
		refreshPlanningPage();
		app.querySelector('#planning-brief').focus();
		return;
	}
	if (action === 'planning-session') { switchPlanningContext(button.dataset.id); return; }
	if (action === 'pioneer-view') { switchPioneerView(button.dataset.view); return; }
	if (action === 'open-review') { switchWorkspace('review'); return; }
	if (action === 'workspace-view') { switchWorkspace(button.dataset.view); return; }
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
document.addEventListener('beforetoggle', (event) => {
	if (event.target.matches('.settings-model-menu') && event.newState === 'open') positionSettingsModels(event.target);
}, true);
for (const eventName of ['resize', 'scroll']) window.addEventListener(eventName, () => {
	for (const menu of app.querySelectorAll('.settings-model-menu:popover-open')) positionSettingsModels(menu);
}, true);
document.addEventListener('input', (event) => {
	if (event.target.id === 'repository-search') { state.repositoryQuery = event.target.value; refreshRepositories(); return; }
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
document.addEventListener('input', (event) => {
	if (event.target.matches('[data-model-search]')) {
		filterSettingsModels(event.target.closest('.settings-model-selector'));
		return;
	}
	const form = event.target.closest('[data-form="settings"]');
	if (form) form.querySelector('[data-settings-status]').textContent = 'Unsaved changes';
});
document.addEventListener('change', (event) => {
	if (event.target.matches('[data-model-search], [data-model-selected-only]')) {
		filterSettingsModels(event.target.closest('.settings-model-selector'));
		return;
	}
	const settingsForm = event.target.closest('[data-form="settings"]');
	if (settingsForm) {
		if (event.target.dataset.settingControl === 'models') filterSettingsModels(event.target.closest('.settings-model-selector'));
		settingsForm.querySelector('[data-settings-status]').textContent = 'Unsaved changes';
		if (event.target.dataset.settingOverride) {
			const row = event.target.closest('[data-setting-row]');
			const field = row.querySelector('input[type="number"]');
			field.disabled = !event.target.checked;
			field.required = event.target.checked;
			row.querySelector('[data-setting-source]').textContent = event.target.checked ? 'Project override' : 'Inherited';
		}
		if (event.target.dataset.settingGroup) for (const input of settingsForm.querySelectorAll(`[data-setting-control="${event.target.dataset.settingGroup}"]`)) input.disabled = event.target.value === 'inherit' || input.dataset.globalBlocked === 'true';
		return;
	}
	if (event.target.id === 'initiative-selector') {
		viewedInitiative = event.target.value;
		state.repositoryViews[state.repository].initiative = viewedInitiative;
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
	if (form.dataset.form === 'settings') { saveSettings(form, values); return; }
	if (form.dataset.form === 'browse-folder') { browseFolders(String(values.get('path')).trim()); return; }
	if (form.dataset.form === 'planning-start') {
		if (form.dataset.repository !== state.repository) return;
		const brief = String(values.get('brief') || '').trim();
		if (!brief) { form.querySelector('textarea').setCustomValidity('Enter a starting point.'); form.reportValidity(); return; }
		state.planningContexts[0].saved ??= planningSnapshot();
		const initiative = String(values.get('initiative') || '') || null;
		if (initiative && !repositories[state.repository].initiatives.includes(initiative)) return;
		const opening = [{ role: 'user', kind: 'Starting point', paragraphs: [brief] }, { role: 'agent', kind: 'Planning approach', paragraphs: [initiative ? `This session is scoped to ${initiativeViews[initiative].title}.` : 'The initiative is not yet defined.', 'I will establish the purpose, users, scope, and acceptance criteria before implementation.'] }];
		const context = { id: `session-${state.nextPlanningContext++}`, mode: String(values.get('mode')), repository: state.repository, projectIdentity: repositories[state.repository].projectIdentity, title: brief.split('\n')[0].slice(0, 72), brief, initiative, saved: {
			planningMode: String(values.get('mode')), pioneerView: 'session', graphZoom: .8,
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
		(app.querySelector('[data-planning-question]') || app.querySelector('.planning-heading h2')).focus();
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
window.addEventListener('popstate', () => {
	const params = new URL(location.href).searchParams;
	const nextVariant = variants.includes(params.get('variant')) ? params.get('variant') : 'A';
	const page = applicationPages.includes(params.get('page')) ? params.get('page') : 'workspace';
	if (nextVariant !== variant) {
		variant = nextVariant;
		state.page = page;
		render();
	} else if (variant === 'C') switchPage(page, false);
});
document.querySelector('#reset-prototype').addEventListener('click', () => { for (const [id, repository] of Object.entries(repositories)) { if (repository.added) delete repositories[id]; } state = initialState(); viewedInitiative = 'harness'; scrollPositions = {}; app.querySelectorAll('[data-scroll-key]').forEach((region) => { region.scrollTop = 0; }); app.querySelectorAll('.checkpoint-files [data-folder]').forEach((folder) => { folder.open = true; }); render(); notify('Simulation reset.'); });
document.addEventListener('keydown', (event) => {
	const modelMenu = app.querySelector('.settings-model-menu:popover-open');
	if (event.key === 'Escape' && modelMenu) {
		event.preventDefault();
		modelMenu.hidePopover();
		modelMenu.closest('.settings-model-selector').querySelector('.settings-model-trigger').focus();
		return;
	}
	if (event.key === 'Escape' && dialog.open) { event.preventDefault(); dialog.requestClose(); return; }
	if (event.target.matches('[data-action="pioneer-view"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
		event.preventDefault();
		const view = event.key === 'Home' ? 'session' : event.key === 'End' ? 'map' : event.target.dataset.view === 'session' ? 'map' : 'session';
		switchPioneerView(view);
		app.querySelector(`[data-action="pioneer-view"][data-view="${view}"]`).focus();
		return;
	}
	if (event.target.matches('[data-action="workspace-view"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
		event.preventDefault();
		const views = ['agents', 'review', 'initiative'];
		const current = views.indexOf(event.target.dataset.view);
		const view = event.key === 'Home' ? views[0] : event.key === 'End' ? views.at(-1) : views[(current + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length];
		switchWorkspace(view);
		app.querySelector(`[data-action="workspace-view"][data-view="${view}"]`).focus();
		return;
	}
	if (event.target.closest('input, textarea, select, [contenteditable], .xterm, .pioneer-viewport, .application-navigation, .settings-model-selector') || dialog.open) return;
	if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
		event.preventDefault();
		changeVariant(event.key === 'ArrowRight' ? 1 : -1);
	}
});
render();