import type { ActivityEntry } from './components/activity-timeline.js';
import type { MergeChecksModel } from './components/merge-checks.js';
import type { MergeRequirementsModel } from './components/merge-requirements.js';

export type MergePhase =
	| 'review'
	| 'inspecting'
	| 'conflict'
	| 'resolving'
	| 'resolution-review'
	| 'checking'
	| 'failed'
	| 'repairing'
	| 'validated'
	| 'integrated'
	| 'stopped';
export type MergeScenario = 'conflict' | 'clean' | 'failed';

export interface MergeSession {
	reviewApproved: boolean;
	checkpoint: string;
	phase: MergePhase;
	scenario: MergeScenario;
	file: number;
	strategy: 'combine' | 'source' | 'target';
	paused: boolean;
	previousPhase: MergePhase | null;
	repaired: boolean;
	revised: boolean;
	approved: boolean;
	revision: number;
	draft: string;
	messages: { role: 'agent' | 'user'; text: string }[];
	checks: MergeChecksModel['result'];
	targetBase: string;
	targetChanged: boolean;
	integrationHead: string | null;
	events: ActivityEntry[];
	view: 'diffs' | 'agent';
	comparison: 'split' | 'unified';
	manual: boolean;
}

export const mergeIssues = [
	{
		reference: 'DEMO-03',
		title: 'Approval checkpoint',
		branch: 'worker/approval-checkpoint',
		checkpoint: 'c7b90a2',
	},
	{
		reference: 'DEMO-04',
		title: 'Serial integration',
		branch: 'worker/serial-integration',
		checkpoint: 'a21df06',
	},
	{
		reference: 'DEMO-05',
		title: 'Restart confirmation',
		branch: 'worker/restart-confirmation',
		checkpoint: 'b86f1c4',
	},
];

const examples = [
	{
		requirement: 'Verify the exact approved revision before integration.',
		retained: 'Require explicit integration approval.',
		name: 'verifyIntegration',
		stem: 'approval-checkpoint',
		operation: 'await verifyApprovedRevision(record);',
		retainedOperation: 'const approval = await readIntegrationApproval(record);',
		field: 'revisionVerified: true,',
		retainedField: 'approved: approval.accepted,',
		assertion: 'expect(session.revisionVerified).toBe(true);',
		retainedAssertion: 'expect(session.approved).toBe(true);',
		status: 'approvalState',
		good: 'approved',
		bad: 'outdated',
	},
	{
		requirement: 'Integrate one issue at a time.',
		retained: 'Require approval for each issue.',
		name: 'integrateNextIssue',
		stem: 'serial-integration',
		operation: 'await acquireIntegrationTurn(record);',
		retainedOperation: 'const approval = await readIntegrationApproval(record);',
		field: 'serialTurn: true,',
		retainedField: 'approved: approval.accepted,',
		assertion: 'expect(session.serialTurn).toBe(true);',
		retainedAssertion: 'expect(session.approved).toBe(true);',
		status: 'integrationState',
		good: 'serialized',
		bad: 'concurrent',
	},
	{
		requirement: 'Check restored tracker, Git, and session state before restart.',
		retained: 'Check shared provider usage before restart.',
		name: 'checkWorkerRestart',
		stem: 'restart-confirmation',
		operation: 'await verifyRestoredState(record);',
		retainedOperation: 'const usage = await checkSharedUsageLimit(record);',
		field: 'stateVerified: true,',
		retainedField: 'usageAllowed: usage.allowed,',
		assertion: 'expect(session.stateVerified).toBe(true);',
		retainedAssertion: 'expect(session.usageAllowed).toBe(true);',
		status: 'restartState',
		good: 'awaiting-confirmation',
		bad: 'running',
	},
];

export const phaseLabels: Record<MergePhase, string> = {
	review: 'Ready for approval',
	inspecting: 'Inspecting branches',
	conflict: 'Conflicts found',
	resolving: 'Preparing resolution',
	'resolution-review': 'Resolution needs approval',
	checking: 'Checking merge result',
	failed: 'Required check failed',
	repairing: 'Repairing merge result',
	validated: 'Checks passed',
	integrated: 'Integrated',
	stopped: 'Stopped / Changes preserved',
};

export const phaseActions: Record<MergePhase, string> = {
	review: 'Approve merge',
	inspecting: 'Inspect branches',
	conflict: 'Build resolution',
	resolving: 'Review resolution',
	'resolution-review': 'Approve resolution',
	checking: 'Run checks',
	failed: 'Ask agent to repair',
	repairing: 'Review repair',
	validated: 'Complete integration',
	integrated: '',
	stopped: 'Resume merge session',
};

export class MergeController {
	constructor() {
		this.sessions = mergeIssues.map(() => this.newSession());
	}

	sessions: MergeSession[];
	selected = 0;
	targetHead = '6f21bd8';
	protected integrationCount = 0;

	get current() {
		return this.sessions[this.selected]!;
	}
	get pending() {
		return this.sessions.flatMap((session, index) =>
			session.reviewApproved && session.phase !== 'integrated' ? [index] : []
		);
	}
	approveReview(index: number, allowed: boolean, checkpoint = mergeIssues[index]?.checkpoint) {
		const session = this.sessions[index];
		if (!allowed || !checkpoint || !session || session.reviewApproved || session.phase !== 'review') return false;
		session.reviewApproved = true;
		session.checkpoint = checkpoint;
		return true;
	}
	get fixture() {
		return examples[this.selected]!;
	}
	get issue() {
		const issue = mergeIssues[this.selected]!;
		return { ...issue, checkpoint: this.current.checkpoint || issue.checkpoint };
	}
	get paths() {
		return [
			`src/runner/${this.fixture.stem}.ts`,
			`tests/${this.fixture.stem}.test.ts`,
			`src/runner/${this.fixture.stem}-options.ts`,
			`docs/${this.fixture.stem}.md`,
		];
	}
	get active() {
		return this.sessions.findIndex(
			(session) => !['review', 'integrated', 'stopped'].includes(session.phase)
		);
	}
	get resolution() {
		return [
			'resolution-review',
			'checking',
			'failed',
			'repairing',
			'validated',
			'integrated',
		].includes(
			this.current.phase === 'stopped'
				? (this.current.previousPhase ?? 'review')
				: this.current.phase
		);
	}

	newSession(): MergeSession {
		return {
			reviewApproved: false,
			checkpoint: '',
			phase: 'review',
			scenario: 'conflict',
			file: 0,
			strategy: 'combine',
			paused: false,
			previousPhase: null,
			repaired: false,
			revised: false,
			approved: false,
			revision: 1,
			draft: '',
			messages: [],
			checks: 'pending',
			targetBase: this.targetHead,
			targetChanged: false,
			integrationHead: null,
			events: [],
			view: 'diffs',
			comparison: 'split',
			manual: false,
		};
	}

	get requirements(): MergeRequirementsModel {
		const current = this.current;
		return {
			reference: this.issue.reference,
			add: this.fixture.requirement,
			keep: this.fixture.retained,
			proposal:
				current.phase === 'review'
					? 'Inspect all four files against the current initiative branch.'
					: 'Combine both requirements and retain the regression assertions.',
			target: current.targetBase,
			integrated: current.phase === 'integrated',
		};
	}

	get checks(): MergeChecksModel {
		return {
			result: this.current.checks,
			revision: this.current.revision,
			target: this.current.targetBase,
			names: ['Type check', `${this.issue.title} tests`, 'Initiative regression tests'],
			failedIndex: this.current.strategy === 'source' ? 2 : 1,
			error: `File: ${this.paths[1]}\nExpected ${this.fixture.good}; received ${this.fixture.bad}.\nInitiative branch unchanged. Integration blocked.`,
		};
	}

	advance(allowed: boolean) {
		const current = this.current;
		if (
			!allowed ||
			!current.reviewApproved ||
			current.paused ||
			current.manual ||
			(this.active !== -1 && this.active !== this.selected)
		)
			return false;
		if (
			!['review', 'integrated'].includes(current.phase) &&
			current.targetBase !== this.targetHead
		) {
			current.targetBase = this.targetHead;
			current.targetChanged = true;
			current.approved = false;
			current.checks = 'pending';
			current.revision++;
			current.phase = 'inspecting';
			current.messages.push({
				role: 'agent',
				text: 'The initiative branch changed. Prior approval and checks are outdated. The new result requires inspection and approval.',
			});
			return true;
		}
		if (current.phase === 'validated' && (!current.approved || current.checks !== 'passed'))
			return false;
		const fails =
			(current.scenario === 'failed' || current.strategy !== 'combine') && !current.repaired;
		const transitions: Partial<Record<MergePhase, MergePhase>> = {
			review: 'inspecting',
			inspecting: current.targetChanged
				? 'resolving'
				: current.scenario === 'clean'
					? 'checking'
					: 'conflict',
			conflict: 'resolving',
			resolving: 'resolution-review',
			'resolution-review': 'checking',
			checking: fails ? 'failed' : 'validated',
			failed: 'repairing',
			repairing: 'resolution-review',
			validated: 'integrated',
			stopped: current.previousPhase ?? 'inspecting',
		};
		const next = transitions[current.phase];
		if (!next) return false;
		if (current.phase === 'review') {
			current.targetBase = this.targetHead;
			current.approved = true;
			current.messages.push({
				role: 'user',
				text: `Approved ${this.issue.checkpoint} for merge into harness/initiative.`,
			});
		}
		if (current.phase === 'resolving' || current.phase === 'repairing') {
			current.revision++;
			current.approved = false;
			if (current.phase === 'repairing') {
				current.repaired = true;
				current.strategy = 'combine';
			}
		}
		if (current.phase === 'resolution-review') {
			current.approved = true;
			current.messages.push({
				role: 'user',
				text: `Approved resolution-r${current.revision} and its resulting changes.`,
			});
		}
		if (current.phase === 'checking') current.checks = next === 'failed' ? 'failed' : 'passed';
		if (current.phase === 'failed') current.checks = 'pending';
		current.phase = next;
		if (next === 'integrated') {
			this.targetHead = `9d3c${String(++this.integrationCount).padStart(3, '0')}`;
			current.integrationHead = this.targetHead;
		}
		const detail =
			next === 'resolution-review'
				? `Recommendation for resolution-r${current.revision}: preserve both requirements.\nKeep: ${this.fixture.retained}\nAdd: ${this.fixture.requirement}\nRequired checks have not run. The initiative branch is unchanged.`
				: next === 'failed'
					? `Expected ${this.fixture.good}; received ${this.fixture.bad}. Integration is blocked.`
					: next === 'integrated'
						? `Integrated ${current.integrationHead}. Final merge to main requires separate approval. No push.`
						: next === 'validated'
							? 'All 3 required checks passed for the approved result and target checkpoint.'
							: `${phaseLabels[next]} against target ${current.targetBase}.`;
		current.events.push({ title: phaseLabels[next], detail });
		current.messages.push({ role: 'agent', text: detail });
		return true;
	}

	runAgent(allowed: boolean) {
		if (!this.advance(allowed)) return false;
		while (
			['inspecting', 'conflict', 'resolving', 'checking', 'repairing', 'validated'].includes(
				this.current.phase
			)
		) {
			if (!this.advance(allowed)) break;
		}
		return true;
	}

	requestRevision(note: string) {
		if (
			!note.trim() ||
			this.current.phase !== 'resolution-review' ||
			this.current.paused ||
			this.current.manual
		)
			return false;
		this.current.messages.push({ role: 'user', text: note.trim() });
		this.current.revised = true;
		this.current.approved = false;
		this.current.checks = 'pending';
		this.current.phase = 'resolving';
		return true;
	}

	stop() {
		if (this.current.phase === 'integrated' || this.current.phase === 'stopped') return;
		this.current.previousPhase = this.current.phase;
		this.current.phase = 'stopped';
	}

	branchCode(branch: 'target' | 'source' | 'result'): string {
		const fixture = this.fixture;
		if (this.current.scenario === 'clean' && branch === 'source') return this.branchCode('result');
		if (this.current.file >= 2)
			return branch === 'target'
				? '(File not present on the initiative branch)'
				: this.current.file === 2
					? 'export const options = {\n  requireApproval: true,\n  preserveExistingPolicy: true,\n};'
					: `# ${this.issue.title}\n\n${fixture.requirement}\n${fixture.retained}\n\nDependent work waits for checked integration.`;
		if (this.current.file === 1) {
			const assertions =
				branch === 'target'
					? [fixture.retainedAssertion]
					: branch === 'source'
						? [fixture.assertion]
						: [
								fixture.retainedAssertion,
								fixture.assertion,
								`expect(session.${fixture.status}).toBe('${fixture.good}');`,
							];
			if (branch === 'result' && this.current.revised)
				assertions.push(`expect(session.${fixture.status}).not.toBe('${fixture.bad}');`);
			return `it('preserves both requirements', async () => {\n  const session = await ${fixture.name}(record);\n${assertions.map((assertion) => `  ${assertion}`).join('\n')}\n});`;
		}
		const operations =
			branch === 'target'
				? [fixture.retainedOperation]
				: branch === 'source'
					? [fixture.operation]
					: [fixture.operation, fixture.retainedOperation];
		const fields =
			branch === 'target'
				? [fixture.retainedField, `${fixture.status}: '${fixture.bad}',`]
				: branch === 'source'
					? [fixture.field, `${fixture.status}: '${fixture.bad}',`]
					: [
							fixture.retainedField,
							fixture.field,
							`${fixture.status}: '${this.current.scenario === 'failed' && !this.current.repaired ? fixture.bad : fixture.good}',`,
						];
		return `async function ${fixture.name}(record) {\n${operations.map((operation) => `  ${operation}`).join('\n')}\n  return {\n    ...record,\n${fields.map((field) => `    ${field}`).join('\n')}\n  };\n}`;
	}
}
