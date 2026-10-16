import type { PlanningWorkspaceModel } from './components/planning-workspace.js';

export type PlanningMode = 'plan' | 'pioneer';

interface PlanningQuestion {
	question: string;
	role: string;
	prefix: string;
}

export interface PlanningContext {
	id: string;
	repository: string;
	initiative: string;
	model: PlanningWorkspaceModel;
	resolutions: string[];
	answers: string[];
}

const questions: PlanningQuestion[] = [
	{ question: 'What problem should this work solve?', role: 'scope', prefix: 'Problem' },
	{
		question: 'Who needs the result, and what must they be able to do?',
		role: 'scope',
		prefix: 'Intended users',
	},
	{
		question: 'What would make the first version acceptable?',
		role: 'constraint',
		prefix: 'Acceptance',
	},
];

const tickets: PlanningWorkspaceModel['tickets'] = [
	{
		title: 'Purpose',
		type: 'grilling',
		question: 'What result should this work achieve?',
		dependencies: [],
		position: [24, 24],
		status: 'Active',
	},
	{
		title: 'Users',
		type: 'research',
		question: 'Who needs this result, and what must they be able to do?',
		dependencies: [0],
		position: [324, 24],
		status: 'Blocked',
	},
	{
		title: 'Scope',
		type: 'grilling',
		question: 'What belongs in the first version, and what is out of scope?',
		dependencies: [0],
		position: [624, 24],
		status: 'Blocked',
	},
	{
		title: 'Constraints',
		type: 'research',
		question: 'Which technical or operational constraints must the work satisfy?',
		dependencies: [1],
		position: [174, 244],
		status: 'Blocked',
	},
	{
		title: 'Acceptance',
		type: 'task',
		question: 'What evidence will show that the result is acceptable?',
		dependencies: [0, 2],
		position: [474, 244],
		status: 'Blocked',
	},
	{
		title: 'Delivery',
		type: 'grilling',
		question: 'What must be decided before implementation can start?',
		dependencies: [3, 4],
		position: [324, 464],
		status: 'Blocked',
	},
];

export class PlanningController {
	constructor() {
		this.contexts = [];
		this.selected = '';
		this.launch = { brief: '', initiative: '', mode: 'plan' };
	}

	contexts: PlanningContext[];
	selected: string;
	launch: { brief: string; initiative: string; mode: PlanningMode };
	protected nextContext = 1;

	get current() {
		return this.contexts.find((context) => context.id === this.selected);
	}

	start(repository: string, initiativeTitle = 'Initiative not yet defined') {
		const brief = this.launch.brief.trim();
		if (!brief) return undefined;
		const context: PlanningContext = {
			id: `planning-${this.nextContext++}`,
			repository,
			initiative: this.launch.initiative,
			resolutions: tickets.map(() => ''),
			answers: [],
			model: {
				title: brief.split('\n')[0]!.slice(0, 80),
				brief,
				initiativeTitle,
				mode: this.launch.mode,
				view: 'session',
				zoom: 0.8,
				resolved: 0,
				paused: false,
				messages: [
					{ role: 'user', kind: 'Starting point', paragraphs: [brief] },
					{
						role: 'agent',
						kind: 'Findings',
						paragraphs: [
							'I will check the purpose, scope, and acceptance before implementation starts.',
						],
					},
				],
				drafts: {},
				questions: [],
				questionCount: questions.length,
				entries: [],
				tickets: structuredClone(tickets),
			},
		};
		this.contexts.push(context);
		this.selected = context.id;
		this.launch = { brief: '', initiative: '', mode: 'plan' };
		this.refresh(context);
		return context;
	}

	select(id: string, repository: string) {
		if (!this.contexts.some((context) => context.id === id && context.repository === repository))
			return false;
		this.selected = id;
		return true;
	}

	saveDraft(index: number, answer: string) {
		const context = this.current;
		if (context?.model.questions.some((question) => question.index === index))
			context.model.drafts[index] = answer;
	}

	submit() {
		const context = this.current;
		if (!context || context.model.paused || !context.model.questions.length) return false;
		const group = context.model.questions;
		if (group.some((question) => !context.model.drafts[question.index]?.trim())) return false;
		const answers = group.map((question) => ({
			question: question.question,
			answer: context.model.drafts[question.index]!.trim(),
		}));
		const records = group.map((question, position) => {
			const answer = answers[position]!.answer;
			if (context.model.mode === 'pioneer') {
				context.resolutions[question.index] = answer;
				return `${question.title}: ${answer}`;
			}
			const specification = questions[question.index]!;
			context.answers.push(answer);
			context.model.entries.push({
				role: specification.role,
				body: `${specification.prefix}: ${answer}`,
			});
			return `${specification.prefix}: ${answer}`;
		});
		context.model.messages.push({ role: 'user', kind: 'Answers', answers });
		for (const question of group) delete context.model.drafts[question.index];
		this.refresh(context);
		context.model.messages.push({
			role: 'agent',
			kind: context.model.questions.length ? 'Recorded results' : 'Review summary',
			records,
			paragraphs: [
				context.model.questions.length
					? `Next topics: ${context.model.questions.map((question) => question.title).join(', ')}.`
					: 'The planning results are ready for review. No execution run or integration has started.',
			],
		});
		return true;
	}

	protected refresh(context: PlanningContext) {
		context.model.tickets = context.model.tickets.map((ticket, index) => ({
			...ticket,
			status: context.resolutions[index]
				? 'Resolved'
				: ticket.dependencies.every((dependency) => context.resolutions[dependency])
					? 'Active'
					: 'Blocked',
		}));
		context.model.resolved = context.resolutions.filter(Boolean).length;
		context.model.questions =
			context.model.mode === 'pioneer'
				? context.model.tickets.flatMap((ticket, index) =>
						ticket.status === 'Active'
							? [{ index, title: ticket.title, question: ticket.question }]
							: []
					)
				: questions.flatMap((question, index) =>
						index >= context.answers.length
							? [{ index, title: context.model.title, question: question.question }]
							: []
					);
		context.model = { ...context.model };
	}
}
