export const providers = {
	copilot: { name: 'Copilot', models: ['Default', 'GPT-5'] },
	claude: { name: 'Claude', models: ['Sonnet', 'Opus'] },
	ollama: { name: 'Ollama', models: ['qwen3:8b', 'llama3.2'] },
};

export type ProviderId = keyof typeof providers;
export const providerIds = Object.keys(providers) as ProviderId[];
export type NumericSetting =
	| 'budget'
	| 'warning'
	| 'projectBudget'
	| 'workers'
	| 'projectWorkers'
	| 'copilotRequests'
	| 'interpreterCalls';
export interface SettingsValues extends Record<NumericSetting, number> {
	approval: boolean;
	providers: ProviderId[];
	models: Record<ProviderId, string[]>;
	connections: Record<ProviderId, boolean>;
}
export type ProjectSettings = Partial<
	Pick<SettingsValues, 'budget' | 'warning' | 'workers' | 'approval' | 'providers' | 'models'>
>;

export const money = (value: number) =>
	new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

export class SettingsController {
	global: SettingsValues = {
		budget: 200,
		warning: 150,
		projectBudget: 50,
		workers: 8,
		projectWorkers: 3,
		copilotRequests: 40,
		interpreterCalls: 250,
		approval: true,
		providers: ['copilot'],
		models: {
			copilot: ['Default', 'GPT-5'],
			claude: ['Sonnet', 'Opus'],
			ollama: ['qwen3:8b', 'llama3.2'],
		},
		connections: { copilot: true, claude: false, ollama: false },
	};
	projects: Record<string, ProjectSettings> = {};
	usage: Record<string, number> = { 'agent-issues': 23.6, 'studio-site': 9.8, 'task-api': 19 };

	effective(repository: string): SettingsValues {
		const global = this.global;
		const project = this.projects[repository] ?? {};
		const budget = Math.min(project.budget ?? global.projectBudget, global.budget);
		const models = Object.fromEntries(
			providerIds.map((provider) => [
				provider,
				(project.models?.[provider] ?? global.models[provider]).filter((model) =>
					global.models[provider].includes(model)
				),
			])
		) as Record<ProviderId, string[]>;
		return {
			...global,
			budget,
			warning: Math.min(project.warning ?? budget * 0.8, budget, global.warning),
			workers: Math.min(project.workers ?? global.projectWorkers, global.workers),
			approval: global.approval || (project.approval ?? global.approval),
			providers: (project.providers ?? global.providers).filter((provider) =>
				global.providers.includes(provider)
			),
			models,
		};
	}

	save(scope: 'global' | 'project', repository: string, values: FormData) {
		const global = this.global;
		const next: ProjectSettings = {};
		for (const key of ['budget', 'warning', 'workers'] as const) {
			if (scope === 'global' || values.has(`override-${key}`)) {
				const raw = values.get(key);
				const value = Number(raw);
				if (
					typeof raw !== 'string' ||
					!raw.trim() ||
					!Number.isFinite(value) ||
					value < (key === 'workers' ? 1 : 0) ||
					(key === 'workers' && !Number.isInteger(value))
				)
					return 'Enter valid limit values.';
				next[key] = value;
			}
		}
		if (scope === 'global') next.approval = values.has('approval');
		else if (values.get('approval') !== 'inherit')
			next.approval = values.get('approval') === 'true';
		if (scope === 'global' || values.get('provider-mode') === 'custom')
			next.providers = providerIds.filter((provider) =>
				values.getAll('providers').includes(provider)
			);
		if (scope === 'global' || values.get('model-mode') === 'custom')
			next.models = Object.fromEntries(
				providerIds.map((provider) => [
					provider,
					values
						.getAll(`models-${provider}`)
						.filter((model): model is string => typeof model === 'string'),
				])
			) as Record<ProviderId, string[]>;
		const budget = next.budget ?? Math.min(global.projectBudget, global.budget);
		const warning = next.warning ?? Math.min(budget * 0.8, global.warning);
		if (warning > budget) return 'The warning threshold must not exceed the stop limit.';
		if (
			scope === 'project' &&
			(budget > global.budget ||
				warning > global.warning ||
				(next.workers ?? global.projectWorkers) > global.workers ||
				(next.approval === false && global.approval))
		)
			return 'Project settings must not exceed global limits.';
		const selectedProviders = next.providers ?? global.providers;
		const selectedModels = next.models ?? global.models;
		if (
			providerIds.some((provider) =>
				selectedModels[provider].some((model) => !providers[provider].models.includes(model))
			)
		)
			return 'Select models from the provider catalog.';
		if (
			scope === 'project' &&
			(selectedProviders.some((provider) => !global.providers.includes(provider)) ||
				providerIds.some((provider) =>
					selectedModels[provider].some((model) => !global.models[provider].includes(model))
				))
		)
			return 'Only globally permitted providers and models are available.';
		if (selectedProviders.some((provider) => !selectedModels[provider].length))
			return 'Select at least one model for each permitted provider.';
		if (scope === 'global') {
			const projectBudget = Number(values.get('projectBudget'));
			const projectWorkers = Number(values.get('projectWorkers'));
			const copilotRequests = Number(values.get('copilotRequests'));
			const interpreterCalls = Number(values.get('interpreterCalls'));
			if (
				![projectBudget, projectWorkers, copilotRequests, interpreterCalls].every(
					Number.isFinite
				) ||
				projectBudget < 0 ||
				!Number.isInteger(projectWorkers) ||
				projectWorkers < 1 ||
				!Number.isInteger(copilotRequests) ||
				copilotRequests < 18 ||
				!Number.isInteger(interpreterCalls) ||
				interpreterCalls < 42
			)
				return 'Enter valid default and request limits.';
			if (projectBudget > budget || projectWorkers > next.workers!)
				return 'Project defaults must not exceed global limits.';
			this.global = {
				...global,
				...next,
				projectBudget,
				projectWorkers,
				copilotRequests,
				interpreterCalls,
			};
		} else this.projects[repository] = next;
		return '';
	}
}
