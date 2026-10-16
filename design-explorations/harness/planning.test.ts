import { describe, expect, it } from 'vitest';
import { PlanningController } from './planning.js';
import { HarnessSimulation } from './simulation.js';
import { MergeController } from './merge.js';
import { SettingsController, providerIds, type NumericSetting } from './settings.js';

describe('Planning sessions', () => {
	it('validates a complete answer group before it records any result', () => {
		const planning = new PlanningController();
		planning.launch.brief = 'A <plain-text> brief';
		const context = planning.start('agent-issues')!;
		expect(context.initiative).toBe('');
		expect(context.model.brief).toBe('A <plain-text> brief');
		planning.saveDraft(0, 'One');
		planning.saveDraft(1, 'Two');
		planning.saveDraft(2, '  ');
		expect(planning.submit()).toBe(false);
		expect(context.model.entries).toHaveLength(0);
		expect(context.model.messages).toHaveLength(2);
		planning.saveDraft(2, '<script>plain text</script>');
		context.model.paused = true;
		expect(planning.submit()).toBe(false);
		context.model.paused = false;
		expect(planning.submit()).toBe(true);
		expect(context.model.entries).toHaveLength(3);
		expect(context.model.messages).toHaveLength(4);
		expect(context.model.questions).toHaveLength(0);
		expect(planning.submit()).toBe(false);
	});

	it('retains session drafts and resolves Pioneer prerequisites in groups', () => {
		const planning = new PlanningController();
		planning.launch = { brief: 'Pioneer work', initiative: '', mode: 'pioneer' };
		const pioneer = planning.start('agent-issues')!;
		expect(pioneer.model.tickets).toHaveLength(6);
		expect(
			pioneer.model.tickets.reduce((count, ticket) => count + ticket.dependencies.length, 0)
		).toBe(7);
		expect(pioneer.model.questions.map((question) => question.index)).toEqual([0]);
		planning.saveDraft(0, 'Retained draft');
		planning.launch.brief = 'Another session';
		const other = planning.start('studio-site')!;
		expect(planning.select(pioneer.id, 'studio-site')).toBe(false);
		expect(planning.select(pioneer.id, 'agent-issues')).toBe(true);
		expect(pioneer.model.drafts[0]).toBe('Retained draft');
		expect(other.model.entries).toHaveLength(0);
		expect(planning.submit()).toBe(true);
		expect(pioneer.model.questions.map((question) => question.index)).toEqual([1, 2]);
		while (pioneer.model.questions.length) {
			for (const question of pioneer.model.questions)
				planning.saveDraft(question.index, 'Recorded decision');
			expect(planning.submit()).toBe(true);
		}
		expect(pioneer.model.resolved).toBe(6);
		expect(pioneer.model.messages.at(-1)?.kind).toBe('Review summary');
	});
});

describe('Execution simulation', () => {
	it('retains each affected-work pause until its request resumes it', () => {
		const simulation = new HarnessSimulation();
		simulation.pause();
		const first = simulation.requestChange('First affected change')!;
		const second = simulation.requestChange('Second affected change')!;
		for (const request of [first, second]) {
			simulation.answerChange(request, 'Record focused evidence.');
			expect(simulation.approveChange(request, 'pause')).toBe(true);
		}
		simulation.pause();
		expect(simulation.workers[2]!.status).toBe('paused');
		expect(simulation.workers[0]!.status).toBe('running');
		simulation.pause();
		expect(simulation.resumeAffected(first)).toBe(false);
		simulation.pause();
		expect(simulation.resumeAffected(first)).toBe(true);
		expect(simulation.workers[2]!.status).toBe('paused');
		expect(simulation.resumeAffected(second)).toBe(true);
		expect(simulation.workers[2]!.status).toBe('review');
		expect(simulation.resumeAffected(second)).toBe(false);
	});

	it('retains the long route and explicit PRD membership', () => {
		const simulation = new HarnessSimulation();
		const route = simulation.routeModel;
		expect(route.issueCount).toBe(42);
		expect(route.stageCount).toBe(37);
		expect(route.parallelCount).toBe(4);
		expect(simulation.issues[0]!.outcome).toBe(
			'Restore recorded sessions without restarting interrupted agents automatically.'
		);
		expect(simulation.issues[2]!.criteria).toContain('A changed revision requires new approval.');
		expect(simulation.issueModel(1).prds).toEqual([]);
		expect(simulation.issueModel(2).prds).toEqual([0, 1]);
		const context = simulation.workContext('DEMO-04');
		expect(context.issue.title).toBe('Serial integration');
		expect(context.parents).toEqual([
			{ index: 1, title: 'Safe delivery and recovery', story: 'Integrate and recover approved work' },
		]);
		expect(simulation.issueModel(3).status.tone).toBe('blocked');
		simulation.integrated.add(2);
		expect(simulation.issueModel(3).status.tone).toBe('ready');
		simulation.pause();
		expect(simulation.issueModel(3).status.tone).toBe('blocked');
		expect(simulation.reviewReady.has('DEMO-03')).toBe(true);
		simulation.pause();
		simulation.setWorkerStatus(simulation.workers[2]!, 'running');
		expect(simulation.reviewReady.has('DEMO-03')).toBe(false);
		simulation.setWorkerStatus(simulation.workers[2]!, 'review');
		expect(simulation.reviewReady.has('DEMO-03')).toBe(true);
	});

	it('sends review feedback to the same worker without creating change-planning work', () => {
		const simulation = new HarnessSimulation();
		const worker = simulation.requestReview('DEMO-03', 'c7b90a2', '  Keep approval separate.  ')!;
		expect(worker).toBe(simulation.workers[2]);
		expect(worker.issue).toBe('DEMO-03');
		expect(worker.status).toBe('running');
		expect(worker.lines).toContain('Keep approval separate.');
		expect(simulation.reviewFeedbacks).toEqual([{ reference: 'DEMO-03', checkpoint: 'c7b90a2', note: 'Keep approval separate.' }]);
		expect(simulation.reviewReady.has('DEMO-03')).toBe(false);
		expect(simulation.requests).toHaveLength(0);
		expect(simulation.issues).toHaveLength(42);
		expect(simulation.integrated.size).toBe(0);
		expect(simulation.requestReview('DEMO-03', 'c7b90a2', 'Duplicate')).toBeUndefined();
		simulation.setWorkerStatus(worker, 'review');
		const checkpoint = simulation.reviewCheckpoint('DEMO-03', 'c7b90a2');
		expect(checkpoint).toBe('c7b90a2-r1');
		expect(simulation.requestReview('DEMO-03', 'c7b90a2', 'Stale feedback')).toBeUndefined();
		const merge = new MergeController();
		expect(merge.pending).toHaveLength(0);
		expect(merge.approveReview(0, true, checkpoint)).toBe(true);
		expect(merge.issue.checkpoint).toBe(checkpoint);
	});

	it.each(['paused', 'stopped', 'manual'] as const)('retains review ownership when feedback is blocked by %s', (mode) => {
		const simulation = new HarnessSimulation();
		if (mode === 'manual') simulation.workers[2]!.manual = true;
		else simulation.mode = mode;
		expect(simulation.requestReview('DEMO-03', 'c7b90a2', 'Feedback')).toBeUndefined();
		expect(simulation.reviewFeedbacks).toHaveLength(0);
		expect(simulation.reviewReady.has('DEMO-03')).toBe(true);
		expect(simulation.workers[2]!.status).toBe('review');
	});

	it('does not change work until a proposal receives explicit approval', () => {
		const simulation = new HarnessSimulation();
		const request = simulation.requestChange('New <plain-text> work')!;
		expect(simulation.issues).toHaveLength(42);
		expect(simulation.approveChange(request, 'followup')).toBe(false);
		expect(simulation.answerChange(request, '  ')).toBe(false);
		expect(simulation.answerChange(request, 'Record focused evidence')).toBe(true);
		expect(simulation.issues).toHaveLength(42);
		expect(simulation.workers[2]!.status).toBe('review');
		expect(simulation.approveChange(request, 'pause')).toBe(true);
		expect(simulation.issues).toHaveLength(43);
		expect(simulation.workers[2]!.status).toBe('paused');
		expect(simulation.issues[5]!.dependencies).toContain(42);
		expect(simulation.approveChange(request, 'followup')).toBe(false);
	});
});

describe('Merge approvals', () => {
	it('requires fresh approval for a resolution and its repaired revision', () => {
		const merge = new MergeController();
		expect(merge.pending).toEqual([]);
		expect(merge.runAgent(true)).toBe(false);
		expect(merge.approveReview(0, false)).toBe(false);
		expect(merge.approveReview(0, true)).toBe(true);
		expect(merge.approveReview(0, true)).toBe(false);
		expect(merge.pending).toEqual([0]);
		merge.current.scenario = 'failed';
		merge.current.manual = true;
		expect(merge.runAgent(true)).toBe(false);
		merge.current.manual = false;
		expect(merge.runAgent(false)).toBe(false);
		expect(merge.current.phase).toBe('review');
		expect(merge.runAgent(true)).toBe(true);
		expect(merge.current.phase).toBe('resolution-review');
		expect(merge.current.approved).toBe(false);
		expect(merge.targetHead).toBe('6f21bd8');
		merge.runAgent(true);
		expect(merge.current.phase).toBe('failed');
		expect(merge.targetHead).toBe('6f21bd8');
		const revision = merge.current.revision;
		merge.runAgent(true);
		expect(merge.current.phase).toBe('resolution-review');
		expect(merge.current.revision).toBeGreaterThan(revision);
		expect(merge.current.approved).toBe(false);
		merge.runAgent(true);
		expect(merge.current.phase).toBe('integrated');
		expect(merge.current.checks).toBe('passed');
		expect(merge.pending).toEqual([]);
	});

	it('serializes active sessions and invalidates approval when the target changes', () => {
		const merge = new MergeController();
		merge.approveReview(0, true);
		merge.approveReview(1, true);
		merge.runAgent(true);
		merge.selected = 1;
		expect(merge.runAgent(true)).toBe(false);
		merge.selected = 0;
		merge.stop();
		merge.selected = 1;
		merge.current.scenario = 'clean';
		merge.runAgent(true);
		expect(merge.current.phase).toBe('integrated');
		merge.selected = 0;
		merge.runAgent(true);
		expect(merge.current.phase).toBe('resolution-review');
		expect(merge.current.targetBase).toBe(merge.targetHead);
		expect(merge.current.approved).toBe(false);
		expect(merge.current.checks).toBe('pending');
	});
});

describe('Settings limits', () => {
	it('inherits defaults, isolates projects, and rejects weaker approval or invalid limits', () => {
		const settings = new SettingsController();
		expect(settings.effective('agent-issues')).toMatchObject({
			budget: 50,
			warning: 40,
			workers: 3,
			approval: true,
		});
		const project = new FormData();
		project.set('approval', 'false');
		project.set('override-budget', 'on');
		project.set('budget', '60');
		expect(settings.save('project', 'agent-issues', project)).toBe(
			'Project settings must not exceed global limits.'
		);
		expect(settings.projects['agent-issues']).toBeUndefined();
		project.set('approval', 'inherit');
		expect(settings.save('project', 'agent-issues', project)).toBe('');
		expect(settings.effective('agent-issues').budget).toBe(60);
		expect(settings.effective('studio-site').budget).toBe(50);
		project.set('override-workers', 'on');
		project.set('workers', '2.5');
		expect(settings.save('project', 'agent-issues', project)).toBe('Enter valid limit values.');
		expect(settings.projects['agent-issues']).toEqual({ budget: 60 });
	});

	it('bounds saved overrides when global limits or permitted models change', () => {
		const settings = new SettingsController();
		settings.projects['agent-issues'] = {
			budget: 100,
			warning: 80,
			workers: 6,
			providers: ['copilot', 'claude'],
			models: { copilot: ['Default', 'GPT-5'], claude: ['Sonnet'], ollama: [] },
		};
		const global = new FormData();
		for (const key of [
			'budget',
			'warning',
			'projectBudget',
			'workers',
			'projectWorkers',
			'copilotRequests',
			'interpreterCalls',
		] as NumericSetting[])
			global.set(key, String(settings.global[key]));
		global.set('approval', 'on');
		global.append('providers', 'copilot');
		for (const provider of providerIds)
			for (const model of settings.global.models[provider])
				global.append(`models-${provider}`, model);
		global.set('budget', '75');
		global.set('warning', '60');
		global.set('workers', '4');
		global.set('models-copilot', 'GPT-5');
		expect(settings.save('global', 'agent-issues', global)).toBe('');
		expect(settings.effective('agent-issues')).toMatchObject({
			budget: 75,
			warning: 60,
			workers: 4,
			providers: ['copilot'],
			models: { copilot: ['GPT-5'] },
		});
		global.set('warning', '76');
		expect(settings.save('global', 'agent-issues', global)).toBe(
			'The warning threshold must not exceed the stop limit.'
		);
		expect(settings.global.warning).toBe(60);
	});
});
