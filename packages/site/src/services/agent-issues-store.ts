import { computed, signal } from "@lit-labs/signals";
import { PROJECT_GRAPH_KINDS, isConsoleSection, type AdrRailEntry, type ConsoleSection, type ContextDetails, type ContextPageTab, type DebtFilter, type Entity, type EpicInitiativeGroup, type FixLink, type GraphEdge, type GraphNode, type InitiativeBundle, type InitiativeTab, type PageMode, type PlanEntry, type ProjectContextTermEntry, type ProjectContextTermSource, type ProjectDiscovery, type ProjectGraphKind, type Relation, type RelationshipGraph, type RootTab, type SiteConfig, type Snapshot, type ViewMode } from "../models.js";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHORT_CODE_LENGTH = 6;
const PLAN_CURRENT_GROUPS = [
	{ key: "questions", title: "Questions" },
	{ key: "decisions", title: "Decisions" },
	{ key: "includedScope", title: "Included scope" },
	{ key: "excludedScope", title: "Excluded scope" },
	{ key: "constraints", title: "Constraints" },
	{ key: "preferences", title: "Preferences" },
	{ key: "considerations", title: "Considerations" }
] as const;

type PlanCurrentGroupKey = (typeof PLAN_CURRENT_GROUPS)[number]["key"];

const KIND_PREFIX: Record<string, string> = {
	project: "PROJ",
	epic: "EPIC",
	version: "VER",
	initiative: "INIT",
	prd: "PRD",
	userStory: "US",
	adr: "ADR",
	issue: "ISS",
	debt: "DEBT",
	handoff: "HO"
};

function shortEntityReference(entity: { id: string; kind: string; shortReference?: string }): string {
	if (entity.shortReference) {
		return entity.shortReference;
	}

	const prefix = KIND_PREFIX[entity.kind] ?? entity.kind.slice(0, 4).toUpperCase();
	let hash = 0x811c9dc5;
	for (let index = 0; index < entity.id.length; index += 1) {
		hash ^= entity.id.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	let value = BigInt(hash >>> 0);
	let code = "";
	for (let index = 0; index < SHORT_CODE_LENGTH; index += 1) {
		code = CROCKFORD_ALPHABET[Number(value & 31n)]! + code;
		value >>= 5n;
	}
	return `${prefix}_${code}`;
}

type IssueTreeNode = {
	issue: Entity;
	children: IssueTreeNode[];
};

type ProjectSnapshot = {
	kind: "available";
	snapshot: Snapshot;
} | {
	kind: "unavailable";
};
type ViewerRoute = {
	tenantId: string | null;
	projectId: string | null;
	section: ConsoleSection;
	entityId: string | null;
	initiativeId: string | null;
};

function filterGraphByKind(graph: RelationshipGraph, visibleKinds: ReadonlySet<ProjectGraphKind>): RelationshipGraph {
	const visibleNodes = graph.nodes.filter((node) => visibleKinds.has(node.kind as ProjectGraphKind));
	const visibleKeys = new Set(visibleNodes.map((node) => node.key));
	const visibleColumnIndexes = [...new Set(visibleNodes.map((node) => node.col))].sort((left, right) => left - right);
	const compactColumnByIndex = new Map(visibleColumnIndexes.map((column, index) => [column, index]));

	return {
		columns: visibleColumnIndexes.map((column) => graph.columns[column]!),
		edges: graph.edges.filter((edge) => visibleKeys.has(edge.from) && visibleKeys.has(edge.to)),
		nodes: visibleNodes.map((node) => ({ ...node, col: compactColumnByIndex.get(node.col)! }))
	};
}

export class AgentIssuesStore {
	public config = signal<SiteConfig | null>(null);
	public snapshot = signal<Snapshot | null>(null);
	public projectDiscovery = signal<ProjectDiscovery | null>(null);
	public search = signal("");
	public contextSearch = signal("");
	public contextTab = signal<ContextPageTab>("all");
	public selectedContextInitiativeId = signal<string | null>(null);
	public visibleProjectGraphKinds = signal<Set<ProjectGraphKind>>(new Set(PROJECT_GRAPH_KINDS));
	public initiativeStatusFilter = signal("all");
	public adrStatusFilter = signal("all");
	public debtLifecycleFilter = signal("open");
	public debtCategoryFilter = signal("all");
	public debtPriorityFilter = signal("all");
	public kindFilter = signal("all");
	public selectedTenant = signal<string | null>(null);
	public selectedProjectId = signal<string | null>(null);
	public selectedInitiativeId = signal<string | null>(null);
	public selectedId = signal<string | null>(null);
	public cascadePath = signal<string[]>([]);
	public cascadeAvailableWidth = signal<number>(0);
	public cascadeWindowStart = signal<number | null>(null);
	public reRootTrail = signal<string[][]>([]);
	public railCollapsed = signal<boolean>(false);
	public masterCollapsedOverride = signal<boolean | null>(null);
	public collapsedEpicIdsByProject = signal<Map<string, Set<string>>>(new Map());
	public syncLabel = signal("loading");
	public errorMessage = signal<string | null>(null);
	public activeView = signal<ViewMode>("overview");
	public activePage = signal<PageMode>("list");
	public activeRootTab = signal<RootTab>("initiatives");
	public activeSection = signal<ConsoleSection>("initiatives");
	public initTab = signal<InitiativeTab>("overview");

	public tenantById = computed(() => new Map((this.config.get()?.availableTenants ?? []).map((tenant) => [tenant.id, tenant])));

	public tenantOptions = computed(() => {
		const tenants = new Map(this.tenantById.get());
		const selectedTenant = this.selectedTenant.get();
		if (selectedTenant && !tenants.has(selectedTenant)) {
			tenants.set(selectedTenant, {
				displayName: this.formatTenantDisplayName(selectedTenant),
				id: selectedTenant
			});
		}

		return [...tenants.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
	});

	public selectedTenantDisplayName = computed(() => {
		const selectedTenant = this.selectedTenant.get();
		if (!selectedTenant) {
			return null;
		}

		return this.tenantById.get().get(selectedTenant)?.displayName ?? this.formatTenantDisplayName(selectedTenant);
	});

	public selectedProjectDisplayName = computed(() => {
		const selectedProjectId = this.selectedProjectId.get();
		if (!selectedProjectId) {
			return null;
		}
		const discovery = this.projectDiscovery.get();
		if (discovery?.kind !== "available") {
			return selectedProjectId;
		}

		return discovery.projects.find((entry) => entry.project.id === selectedProjectId)?.project.title ?? selectedProjectId;
	});

	public entityById = computed(() => {
		const snapshot = this.snapshot.get();
		if (!snapshot) {
			return new Map<string, Entity>();
		}

		const bundleEntities = snapshot.initiatives.flatMap((bundle) => [
			bundle.initiative,
			...bundle.prds,
			...bundle.userStories,
			...bundle.adrs,
			...bundle.issues
		]);
		return new Map([...snapshot.entities, ...snapshot.projectAdrs, ...bundleEntities].map((entity) => [entity.id, entity]));
	});

	public entityForId(entityId: string | null): Entity | null {
		return entityId ? this.entityById.get().get(entityId) ?? null : null;
	}

	public cascadeColumns = computed(() =>
		this.cascadePath.get()
			.map((entityId) => this.entityForId(entityId))
			.filter((entity): entity is Entity => Boolean(entity))
	);

	public masterCollapsed = computed((): boolean => {
		const override = this.masterCollapsedOverride.get();
		if (override !== null) {
			return override;
		}

		return false;
	});

	public readonly cascadeColumnWidth = 480;
	public readonly cascadeColumnGap = 16;

	public cascadeCapacityForWidth(availableWidth: number): number {
		if (availableWidth <= 0) {
			return Number.POSITIVE_INFINITY;
		}

		return Math.max(1, Math.floor(availableWidth / (this.cascadeColumnWidth + this.cascadeColumnGap)));
	}

	public cascadeHopRelation(parentId: string, childId: string): string | null {
		const relations = this.snapshot.get()?.relations ?? [];
		const structural = relations.find((relation) => relation.fromId === parentId && relation.toId === childId);
		if (structural) {
			return structural.type;
		}

		const reversed = relations.find((relation) => relation.fromId === childId && relation.toId === parentId);
		return reversed?.type ?? null;
	}

	public cascadeColumnWindow = computed((): { breadcrumb: Entity[]; columns: Entity[] } => {
		const path = this.cascadeColumns.get();
		const capacity = this.cascadeCapacityForWidth(this.cascadeAvailableWidth.get());
		if (path.length <= capacity) {
			return { breadcrumb: [], columns: path };
		}

		const rightAnchoredStart = path.length - capacity;
		const manualStart = this.cascadeWindowStart.get();
		const start = Math.min(Math.max(manualStart ?? rightAnchoredStart, 0), path.length - 1);

		return { breadcrumb: path.slice(0, start), columns: path.slice(start) };
	});

	public cascadePathForLeaf(leafId: string): string[] {
		const relations = this.snapshot.get()?.relations ?? [];

		const issueChain = [leafId];
		const seen = new Set<string>([leafId]);
		let currentId = leafId;

		while (true) {
			const parentRelation = relations.find((relation) => relation.type === "decomposes" && relation.toId === currentId);
			if (!parentRelation || seen.has(parentRelation.fromId)) {
				break;
			}

			issueChain.unshift(parentRelation.fromId);
			seen.add(parentRelation.fromId);
			currentId = parentRelation.fromId;
		}

		const rootIssueId = issueChain[0];
		const fixedStories = this.sortEntities(
			relations
				.filter((relation) => relation.type === "fixes" && relation.fromId === rootIssueId)
				.map((relation) => this.entityForId(relation.toId))
				.filter((entity): entity is Entity => Boolean(entity))
		);
		const storyId = fixedStories[0]?.id ?? null;
		const spine = this.spineForStory(storyId, rootIssueId);

		return [...spine, ...issueChain];
	}

	protected spineForStory(storyId: string | null, rootIssueId: string): string[] {
		const relations = this.snapshot.get()?.relations ?? [];
		const prdId = storyId
			? relations.find((relation) => relation.type === "creates" && relation.toId === storyId)?.fromId ?? null
			: null;
		const initiativeId = prdId
			? relations.find((relation) => relation.type === "owns" && relation.toId === prdId)?.fromId ?? null
			: relations.find((relation) => relation.type === "tracks" && relation.toId === rootIssueId)?.fromId ?? null;

		const spine: string[] = [];
		if (initiativeId) {
			spine.push(initiativeId);
		}

		if (prdId) {
			spine.push(prdId);
		}

		if (storyId) {
			spine.push(storyId);
		}

		return spine;
	}

	public cascadeSeamFor(
		parentId: string,
		childId: string
	): { relation: string | null; branch: { options: Entity[]; selectedIndex: number } | null } {
		const relation = this.cascadeHopRelation(parentId, childId);
		if (relation !== "fixes") {
			return { relation, branch: null };
		}

		const relations = this.snapshot.get()?.relations ?? [];
		const options = this.sortEntities(
			relations
				.filter((candidate) => candidate.type === "fixes" && candidate.fromId === childId)
				.map((candidate) => this.entityForId(candidate.toId))
				.filter((entity): entity is Entity => Boolean(entity))
		);
		if (options.length <= 1) {
			return { relation, branch: null };
		}

		return { relation, branch: { options, selectedIndex: options.findIndex((entity) => entity.id === parentId) } };
	}

	public selectCascadeBranch(rootIssueId: string, storyId: string) {
		const path = this.cascadePath.get();
		const chainStart = path.indexOf(rootIssueId);
		if (chainStart === -1) {
			return;
		}

		const issueChain = path.slice(chainStart);
		const spine = this.spineForStory(storyId, rootIssueId);

		this.cascadeWindowStart.set(null);
		this.cascadePath.set([...spine, ...issueChain]);
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	public selectedEntity = computed(() => this.entityForId(this.selectedId.get()));

	public bundleForEntityId(entityId: string | null): InitiativeBundle | null {
		if (!entityId) {
			return null;
		}

		return (
			(this.snapshot.get()?.initiatives ?? []).find((bundle) =>
				[bundle.initiative, ...bundle.prds, ...bundle.userStories, ...bundle.adrs, ...bundle.issues].some(
					(candidate) => candidate.id === entityId
				)
			) ?? null
		);
	}

	public selectedBundle = computed(() => this.bundleForEntityId(this.selectedId.get()));

	public bundleForInitiativeId(initiativeId: string | null): InitiativeBundle | null {
		if (!initiativeId) {
			return null;
		}

		return (this.snapshot.get()?.initiatives ?? []).find((bundle) => bundle.initiative.id === initiativeId) ?? null;
	}

	public selectedInitiativeBundle = computed(() => this.bundleForInitiativeId(this.selectedInitiativeId.get()));

	public activeInitiativeId = computed(() => this.selectedInitiativeId.get() ?? this.selectedBundle.get()?.initiative.id ?? null);

	public sharedContext = computed(() => this.snapshot.get()?.contexts.shared ?? null);

	public initiativeContextById = computed(() =>
		new Map(
			(this.snapshot.get()?.contexts.initiatives ?? [])
				.filter((details) => Boolean(details.context.scopeEntityId))
				.map((details) => [details.context.scopeEntityId ?? details.context.key, details])
		)
	);

	public selectedContext = computed(() => {
		const bundle = this.selectedBundle.get();
		if (bundle) {
			return this.initiativeContextById.get().get(bundle.initiative.id) ?? null;
		}

		return this.sharedContext.get();
	});

	public projectContextTerms = computed(() => {
		const termsByKey = new Map<string, ProjectContextTermEntry>();
		for (const details of [this.sharedContext.get(), ...(this.snapshot.get()?.contexts.initiatives ?? [])]) {
			if (!details) {
				continue;
			}

			for (const term of details.terms) {
				const key = term.term.toLowerCase();
				const source: ProjectContextTermSource = {
					avoid: [...term.avoid],
					contextKey: details.context.key,
					contextTitle: details.context.title,
					definition: term.definition,
					scopeEntityId: details.context.scopeEntityId,
					scopeKind: details.context.scopeKind,
					scopeLabel: details.context.scopeLabel,
					updatedAt: term.updatedAt
				};
				const existing = termsByKey.get(key);

				if (!existing) {
					termsByKey.set(key, {
						term: term.term,
						sources: [source],
						hasSharedSource: details.context.scopeKind === "default",
						hasDuplicates: false,
						hasConflictingDefinitions: false
					});
					continue;
				}

				existing.sources.push(source);
				existing.hasDuplicates = existing.sources.length > 1;
				existing.hasSharedSource = existing.hasSharedSource || details.context.scopeKind === "default";
				existing.hasConflictingDefinitions = hasConflictingDefinitions(existing.sources);
				if (term.term.localeCompare(existing.term) < 0) {
					existing.term = term.term;
				}
			}
		}

		return [...termsByKey.values()]
			.map((entry) => ({
				...entry,
				sources: entry.sources.sort(compareProjectContextSources)
			}))
			.sort((left, right) => left.term.localeCompare(right.term));
	});

	public filteredProjectContextTerms = computed(() => {
		const query = this.contextSearch.get().trim().toLowerCase();
		if (!query) {
			return this.projectContextTerms.get();
		}

		return this.projectContextTerms.get().filter((entry) => {
			if (entry.term.toLowerCase().includes(query)) {
				return true;
			}

			return entry.sources.some((source) =>
				[
					source.scopeLabel,
					source.contextTitle,
					source.definition,
					...source.avoid
				]
					.join(" ")
					.toLowerCase()
					.includes(query)
			);
		});
	});

	public filteredInitiativeContextTerms = computed(() => {
		const selectedInitiativeId = this.selectedContextInitiativeId.get();
		const query = this.contextSearch.get().trim().toLowerCase();

		return this.projectContextTerms.get()
			.map((entry) => {
				const sources = entry.sources.filter(
					(source) =>
						source.scopeKind === "initiative" &&
						(!selectedInitiativeId || source.scopeEntityId === selectedInitiativeId)
				);

				if (sources.length === 0) {
					return null;
				}

				const matchesQuery = !query || entry.term.toLowerCase().includes(query) || sources.some((source) =>
					[source.scopeLabel, source.contextTitle, source.definition, ...source.avoid]
						.join(" ")
						.toLowerCase()
						.includes(query)
				);

				if (!matchesQuery) {
					return null;
				}

				return {
					...entry,
					sources,
					hasSharedSource: false,
					hasDuplicates: sources.length > 1,
					hasConflictingDefinitions: hasConflictingDefinitions(sources)
				};
			})
			.filter((entry): entry is ProjectContextTermEntry => entry !== null);
	});

	public filteredSharedContext = computed(() => {
		const details = this.sharedContext.get();
		if (!details) {
			return null;
		}

		const query = this.contextSearch.get().trim().toLowerCase();
		if (!query) {
			return details;
		}

		const contextMatches = [details.context.key, details.context.scopeLabel, details.context.summary, details.context.title]
			.join(" ")
			.toLowerCase()
			.includes(query);
		const filteredTerms = details.terms.filter((term) =>
			[term.term, term.definition, ...term.avoid]
				.join(" ")
				.toLowerCase()
				.includes(query)
		);

		if (!contextMatches && filteredTerms.length === 0) {
			return null;
		}

		return {
			context: {
				...details.context,
				summary: contextMatches ? details.context.summary : ""
			},
			terms: filteredTerms
		};
	});

	public projectContextDuplicateCount = computed(() => this.projectContextTerms.get().filter((entry) => entry.hasDuplicates).length);

	public incomingRelationsFor(entityId: string | null): Relation[] {
		if (!entityId) {
			return [];
		}

		return (this.snapshot.get()?.relations ?? []).filter((relation) => relation.toId === entityId);
	}

	public outgoingRelationsFor(entityId: string | null): Relation[] {
		if (!entityId) {
			return [];
		}

		return (this.snapshot.get()?.relations ?? []).filter((relation) => relation.fromId === entityId);
	}

	public selectedIncoming = computed(() => this.incomingRelationsFor(this.selectedId.get()));

	public selectedOutgoing = computed(() => this.outgoingRelationsFor(this.selectedId.get()));

	public relatedEntities = computed(() => {
		const relatedIds = new Set<string>();
		for (const relation of [...this.selectedIncoming.get(), ...this.selectedOutgoing.get()]) {
			relatedIds.add(relation.fromId);
			relatedIds.add(relation.toId);
		}
		relatedIds.delete(this.selectedId.get() ?? "");

		return this.sortEntities(
			[...relatedIds]
				.map((entityId) => this.entityById.get().get(entityId))
				.filter((entity): entity is Entity => Boolean(entity))
		);
	});

	public localGraphEntities = computed(() => {
		const selectedEntity = this.selectedEntity.get();
		return selectedEntity ? [selectedEntity, ...this.relatedEntities.get()] : [];
	});

	public localGraphRelations = computed(() => {
		const localIds = new Set(this.localGraphEntities.get().map((entity) => entity.id));
		return (this.snapshot.get()?.relations ?? []).filter((relation) => localIds.has(relation.fromId) && localIds.has(relation.toId));
	});

	public filteredEntities = computed(() => {
		const query = this.search.get().trim().toLowerCase();
		const kindFilter = this.kindFilter.get();

		return this.sortEntities(
			(this.snapshot.get()?.entities ?? []).filter((entity) => {
				if (kindFilter !== "all" && entity.kind !== kindFilter) {
					return false;
				}

				if (!query) {
					return true;
				}

				return [entity.id, entity.kind, entity.status, entity.title].join(" ").toLowerCase().includes(query);
			})
		);
	});

	public kindOptions = computed(() => [
		"issue",
		"all",
		...new Set((this.snapshot.get()?.entities ?? []).map((entity) => entity.kind).filter((kind) => kind !== "issue"))
	]);

	public rootTabCounts = computed(() => ({
		adrs: (this.snapshot.get()?.entities ?? []).filter((entity) => entity.kind === "adr").length,
		initiatives: this.snapshot.get()?.initiatives.length ?? 0
	}));

	public allDebtRecords = computed(() =>
		this.sortEntities((this.snapshot.get()?.entities ?? []).filter((entity) => entity.kind === "debt"))
	);

	public debtRecords = computed(() => {
		const lifecycle = this.debtLifecycleFilter.get();
		const category = this.debtCategoryFilter.get();
		const priority = this.debtPriorityFilter.get();
		return this.sortEntities(
			this.allDebtRecords.get().filter(
				(entity) =>
					(lifecycle === "all" || entity.status === lifecycle) &&
					(category === "all" || entity.category === category) &&
					(priority === "all" || entity.priority === priority)
			)
		);
	});

	public projectInitiatives = computed(() => this.snapshot.get()?.initiatives ?? []);

	public epicInitiativeGroups = computed<EpicInitiativeGroup[]>(() => {
		const snapshot = this.snapshot.get();
		if (!snapshot) {
			return [];
		}

		const bundlesByInitiativeId = new Map(snapshot.initiatives.map((bundle) => [bundle.initiative.id, bundle]));
		const initiativeIdsByEpicId = new Map<string, string[]>();
		for (const relation of snapshot.relations) {
			if (relation.type !== "contains" || !bundlesByInitiativeId.has(relation.toId)) {
				continue;
			}

			const initiativeIds = initiativeIdsByEpicId.get(relation.fromId) ?? [];
			initiativeIds.push(relation.toId);
			initiativeIdsByEpicId.set(relation.fromId, initiativeIds);
		}

		return this.sortEntities(snapshot.entities.filter((entity) => entity.kind === "epic"))
			.map((epic) => {
				const initiatives = (initiativeIdsByEpicId.get(epic.id) ?? [])
					.map((initiativeId) => bundlesByInitiativeId.get(initiativeId))
					.filter((bundle): bundle is InitiativeBundle => Boolean(bundle));
				return {
					epic,
					initiatives,
					completedInitiativeCount: initiatives.filter((bundle) => this.isDoneStatus(bundle.initiative.status)).length
				};
			})
			.filter((group) => group.initiatives.length > 0);
	});

	public projectAdrs = computed(() => this.sortEntities((this.snapshot.get()?.entities ?? []).filter((entity) => entity.kind === "adr")));

	public adrRailEntries = computed<AdrRailEntry[]>(() => {
		const snapshot = this.snapshot.get();
		if (!snapshot) {
			return [];
		}

		const projectEntries = this.sortEntities(snapshot.projectAdrs).map((adr) => ({
			adr,
			scope: "project" as const,
			scopeLabel: "project decision"
		}));

		const initiativeEntries = snapshot.initiatives.flatMap((bundle) =>
			this.sortEntities(bundle.adrs).map((adr) => ({
				adr,
				scope: "initiative" as const,
				scopeLabel: `initiative ${bundle.initiative.title}`
			}))
		);

		return [...projectEntries, ...initiativeEntries];
	});

	public projectStoryCount = computed(() => this.projectInitiatives.get().reduce((total, bundle) => total + bundle.userStories.length, 0));

	public projectIssueCount = computed(() => this.projectInitiatives.get().reduce((total, bundle) => total + bundle.issues.length, 0));

	public projectDescription = computed(() => this.sharedContext.get()?.context.summary ?? this.selectedTenantDisplayName.get() ?? "");

	public orphanIds = computed(() => new Set((this.snapshot.get()?.orphans ?? []).map((entity) => entity.id)));

	public connected = false;
	public events: EventSource | null = null;
	public pollTimer: number | null = null;

	public connect() {
		if (this.connected) {
			return;
		}

		this.connected = true;
		window.addEventListener("hashchange", this.onBrowserNavigation);
		window.addEventListener("popstate", this.onPopState);
		void this.bootstrap();
	}

	public disconnect() {
		if (!this.connected) {
			return;
		}

		this.connected = false;
		window.removeEventListener("hashchange", this.onBrowserNavigation);
		window.removeEventListener("popstate", this.onPopState);
		this.events?.close();
		this.events = null;
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	public onHashChange = () => {
		const route = this.applyRoute(this.readRoute());
		this.writeRoute(route, true);
	};

	public onPopState = async () => {
		const route = this.readRoute();
		if (route.tenantId !== this.selectedTenant.get() || route.projectId !== this.selectedProjectId.get()) {
			await this.navigateToRoute(route);
			return;
		}

		this.applyRoute(route);
	};

	public onBrowserNavigation = async () => {
		await this.navigateToRoute(this.readRoute());
		const params = new URLSearchParams(new URL(window.location.href).hash.slice(1));
		if (params.has("cascade")) {
			this.writeRoute(this.currentRoute(), true);
		}
	};

	public setSearchFromEvent = (event: Event) => {
		this.search.set((event.target as HTMLInputElement).value);
	};

	public setKindFilterFromEvent = (event: Event) => {
		this.kindFilter.set((event.target as HTMLSelectElement).value);
	};

	public openRootTab(tab: RootTab) {
		this.activeRootTab.set(tab);
	}

	public selectSection(section: ConsoleSection) {
		this.activeSection.set(section);
		this.selectedInitiativeId.set(null);
		this.selectedId.set(null);
		this.initTab.set("overview");
		this.contextSearch.set("");
		this.contextTab.set("all");
		this.selectedContextInitiativeId.set(null);
		this.activePage.set("list");
		this.writeRoute(this.currentRoute());
	}

	public setContextTab(tab: ContextPageTab) {
		this.contextTab.set(tab);
	}

	public setContextInitiativeFilter(initiativeId: string | null) {
		this.selectedContextInitiativeId.set(initiativeId);
	}

	public setMasterStatusFilter(section: "initiatives" | "adrs", status: string) {
		if (section === "initiatives") {
			this.initiativeStatusFilter.set(status);
			return;
		}

		this.adrStatusFilter.set(status);
	}

	public setDebtFilter(filter: DebtFilter, value: string) {
		if (filter === "lifecycle") {
			this.debtLifecycleFilter.set(value);
			return;
		}

		if (filter === "category") {
			this.debtCategoryFilter.set(value);
			return;
		}

		this.debtPriorityFilter.set(value);
	}

	public setInitTab(tab: InitiativeTab) {
		this.initTab.set(tab);
	}

	public setTenantFromEvent = (event: Event) => {
		const tenantId = (event.target as HTMLSelectElement).value;
		void this.selectTenant(tenantId);
	};

	public selectEntityFromEvent = (event: Event) => {
		const entityId = (event.currentTarget as HTMLElement).dataset.id;
		if (!entityId) {
			return;
		}

		this.selectEntity(entityId);
	};

	public openViewFromEvent = (event: Event) => {
		const nextView = (event.currentTarget as HTMLElement).dataset.view as ViewMode | undefined;
		if (!nextView) {
			return;
		}

		this.activeView.set(nextView);
	};

	public selectEntity(entityId: string) {
		if (this.entityForId(entityId)?.kind === "initiative") {
			this.selectInitiative(entityId);
			return;
		}

		this.cascadePath.set([]);
		this.selectedInitiativeId.set(null);
		this.selectedId.set(entityId);
		this.activePage.set("entity");
		this.writeRoute(this.currentRoute());
	}

	public selectProjectGraphEntity(entityId: string, kind: string) {
		this.activeSection.set(kind === "adr" ? "adrs" : "initiatives");
		this.selectEntity(entityId);
	}

	public selectInitiativeFromEvent = (event: Event) => {
		const initiativeId = (event.currentTarget as HTMLElement).dataset.id;
		if (!initiativeId) {
			return;
		}

		this.selectInitiative(initiativeId);
	};

	public openCascade(rootId: string) {
		this.cascadeWindowStart.set(null);
		this.cascadePath.set([rootId]);
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	public toggleRail() {
		this.railCollapsed.set(!this.railCollapsed.get());
	}

	public toggleMaster() {
		this.masterCollapsedOverride.set(!this.masterCollapsed.get());
	}

	public isEpicExpanded(epicId: string): boolean {
		const projectId = this.selectedProjectId.get();
		return !projectId || !this.collapsedEpicIdsByProject.get().get(projectId)?.has(epicId);
	}

	public toggleEpicExpanded(epicId: string) {
		const projectId = this.selectedProjectId.get();
		if (!projectId) {
			return;
		}

		const collapsedEpicIdsByProject = new Map(this.collapsedEpicIdsByProject.get());
		const collapsedEpicIds = new Set(collapsedEpicIdsByProject.get(projectId));
		if (collapsedEpicIds.has(epicId)) {
			collapsedEpicIds.delete(epicId);
		} else {
			collapsedEpicIds.add(epicId);
		}

		collapsedEpicIdsByProject.set(projectId, collapsedEpicIds);
		this.collapsedEpicIdsByProject.set(collapsedEpicIdsByProject);
	}

	protected clearMasterOverrideIfShallow() {
		if (this.cascadePath.get().length < 2) {
			this.masterCollapsedOverride.set(null);
		}
	}

	public reRootCascade(targetId: string) {
		const currentPath = this.cascadePath.get();
		if (currentPath.length > 0) {
			this.reRootTrail.set([...this.reRootTrail.get(), currentPath]);
		}

		this.cascadeWindowStart.set(null);
		this.cascadePath.set(this.cascadePathForLeaf(targetId));
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	public restoreReRoot(index: number) {
		const trail = this.reRootTrail.get();
		const restored = trail[index];
		if (!restored) {
			return;
		}

		this.reRootTrail.set(trail.slice(0, index));
		this.cascadeWindowStart.set(null);
		this.cascadePath.set(restored);
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	public popReRoot() {
		const trail = this.reRootTrail.get();
		if (trail.length === 0) {
			return;
		}

		this.restoreReRoot(trail.length - 1);
	}

	public drillCascade(parentId: string, childId: string) {
		const parentIndex = this.cascadePath.get().indexOf(parentId);
		if (parentIndex === -1) {
			return;
		}

		this.cascadeWindowStart.set(null);
		this.cascadePath.set([...this.cascadePath.get().slice(0, parentIndex + 1), childId]);
		this.writeCascadeHash();
	}

	public restoreAncestor(entityId: string) {
		const index = this.cascadePath.get().indexOf(entityId);
		if (index === -1) {
			return;
		}

		this.cascadeWindowStart.set(index);
	}

	public truncateCascadeTo(entityId: string) {
		const path = this.cascadePath.get();
		const index = path.indexOf(entityId);
		if (index === -1 || index === path.length - 1) {
			return;
		}

		this.cascadeWindowStart.set(null);
		this.cascadePath.set(path.slice(0, index + 1));
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	protected writeCascadeHash() {
		this.writeRoute(this.currentRoute());
	}

	public selectInitiative(initiativeId: string) {
		this.selectedId.set(null);
		this.selectedInitiativeId.set(initiativeId);
		this.activePage.set("initiative");
		this.activeSection.set("initiatives");
		this.activeView.set("overview");
		this.initTab.set("overview");
		this.cascadePath.set([]);
		this.clearMasterOverrideIfShallow();
		this.writeRoute(this.currentRoute());
	}

	public clearSelection() {
		this.cascadePath.set([]);
		this.clearMasterOverrideIfShallow();
		this.selectedInitiativeId.set(null);
		this.selectedId.set(null);
		this.activePage.set("list");
		this.activeView.set("overview");
		this.writeRoute(this.currentRoute());
	}

	public async selectTenant(tenantId: string) {
		if (!tenantId || tenantId === this.selectedTenant.get()) {
			return;
		}

		this.selectedTenant.set(tenantId);
		this.selectedProjectId.set(null);
		this.resetScopeDetail();
		this.writeRoute(this.currentRoute());
		this.stopLiveUpdates();
		this.syncLabel.set("choose a project");
		await this.reloadProjectDiscovery();
	}

	public async returnToProjectChooser() {
		if (!this.selectedTenant.get() || !this.selectedProjectId.get()) {
			return;
		}

		this.selectedProjectId.set(null);
		this.snapshot.set(null);
		this.resetScopeDetail();
		this.writeRoute(this.currentRoute());
		this.stopLiveUpdates();
		this.syncLabel.set("choose a project");
		await this.reloadProjectDiscovery();
	}

	public async selectProject(projectId: string) {
		const tenantId = this.selectedTenant.get();
		if (!tenantId || !projectId || projectId === this.selectedProjectId.get()) {
			return;
		}

		this.selectedProjectId.set(projectId);
		this.resetScopeDetail();
		this.writeRoute(this.currentRoute());
		this.stopLiveUpdates();
		this.syncLabel.set("connecting");

		try {
			await this.reloadSnapshot();
			this.connectEvents();
		} catch (error) {
			this.selectedProjectId.set(null);
			this.snapshot.set(null);
			this.writeRoute(this.currentRoute(), true);
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
			this.syncLabel.set("project unavailable");
		}
	}

	public initiativeStats(bundle: InitiativeBundle) {
		const total = bundle.issues.length;
		const done = bundle.issues.filter((issue) => this.isDoneStatus(issue.status)).length;
		const pct = total > 0 ? Math.round((done / total) * 100) : 0;
		return { adrs: bundle.adrs.length, done, issues: total, pct, stories: bundle.userStories.length };
	}

	public issuesForStory(bundle: InitiativeBundle, storyId: string) {
		const issueIds = new Set(bundle.fixLinks.filter((link) => link.userStory.id === storyId).map((link) => link.issue.id));
		return this.sortEntities(bundle.issues.filter((issue) => issueIds.has(issue.id)));
	}

	public subIssuesForIssue(bundle: InitiativeBundle, issueId: string) {
		return this.sortEntities(bundle.subIssueLinks.filter((link) => link.parent.id === issueId).map((link) => link.issue));
	}

	public parentIssueForIssue(bundle: InitiativeBundle, issueId: string) {
		return bundle.subIssueLinks.find((link) => link.issue.id === issueId)?.parent ?? null;
	}

	public issueTreeForStory(bundle: InitiativeBundle, storyId: string): IssueTreeNode[] {
		const parentIssueIdByChildId = new Map(bundle.subIssueLinks.map((link) => [link.issue.id, link.parent.id]));
		const childIssueIdsByParentId = new Map<string, string[]>();

		for (const link of bundle.subIssueLinks) {
			const childIssueIds = childIssueIdsByParentId.get(link.parent.id) ?? [];
			childIssueIds.push(link.issue.id);
			childIssueIdsByParentId.set(link.parent.id, childIssueIds);
		}

		const relevantIds = new Set<string>();
		const fixingIssues = this.issuesForStory(bundle, storyId);

		for (const issue of fixingIssues) {
			const descendantQueue = [issue.id];

			while (descendantQueue.length > 0) {
				const currentIssueId = descendantQueue.shift();
				if (!currentIssueId || relevantIds.has(currentIssueId)) {
					continue;
				}

				relevantIds.add(currentIssueId);
				for (const childIssueId of childIssueIdsByParentId.get(currentIssueId) ?? []) {
					descendantQueue.push(childIssueId);
				}
			}

			let currentIssueId: string | null = issue.id;

			while (currentIssueId) {
				if (relevantIds.has(currentIssueId)) {
					currentIssueId = parentIssueIdByChildId.get(currentIssueId) ?? null;
					continue;
				}

				relevantIds.add(currentIssueId);
				currentIssueId = parentIssueIdByChildId.get(currentIssueId) ?? null;
			}
		}

		const rootIds = [...relevantIds].filter((issueId) => {
			const parentIssueId = parentIssueIdByChildId.get(issueId);
			return !parentIssueId || !relevantIds.has(parentIssueId);
		});

		return this.buildIssueTree(bundle, rootIds, relevantIds);
	}

	public issueTreeForDirectIssues(bundle: InitiativeBundle): IssueTreeNode[] {
		const storyIssueIds = new Set(
			bundle.userStories.flatMap((story) => this.issueTreeForStory(bundle, story.id).flatMap((node) => this.issueTreeNodeIds(node)))
		);
		const directIssueIds = new Set(bundle.issues.map((issue) => issue.id).filter((issueId) => !storyIssueIds.has(issueId)));
		const parentIssueIdByChildId = new Map(bundle.subIssueLinks.map((link) => [link.issue.id, link.parent.id]));
		const rootIds = [...directIssueIds].filter((issueId) => {
			const parentIssueId = parentIssueIdByChildId.get(issueId);
			return !parentIssueId || !directIssueIds.has(parentIssueId);
		});

		return this.buildIssueTree(bundle, rootIds, directIssueIds);
	}

	public subIssueTreeForIssue(bundle: InitiativeBundle, issueId: string): IssueTreeNode[] {
		const relevantIds = new Set<string>();
		const queue = this.subIssuesForIssue(bundle, issueId).map((issue) => issue.id);

		while (queue.length > 0) {
			const currentIssueId = queue.shift();
			if (!currentIssueId || relevantIds.has(currentIssueId)) {
				continue;
			}

			relevantIds.add(currentIssueId);
			for (const childIssue of this.subIssuesForIssue(bundle, currentIssueId)) {
				queue.push(childIssue.id);
			}
		}

		return this.buildIssueTree(
			bundle,
			this.subIssuesForIssue(bundle, issueId).map((issue) => issue.id),
			relevantIds
		);
	}

	public buildInitiativeGraph(bundle: InitiativeBundle, visibleKinds?: ReadonlySet<ProjectGraphKind>): RelationshipGraph {
		const initiative = bundle.initiative;
		const snapshot = this.snapshot.get();
		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];
		const issueById = new Map(bundle.issues.map((issue) => [issue.id, issue]));
		const childIssuesByParentId = new Map<string, Entity[]>();
		const childIssueIds = new Set(bundle.subIssueLinks.map((link) => link.issue.id));
		const fixingStoryIdsByIssueId = new Map<string, string[]>();
		const plans = this.sortEntities(bundle.entities.filter((entity) => entity.kind === "plan"));

		nodes.push({ col: 0, fullLabel: initiative.title, id: initiative.id, key: initiative.id, kind: "initiative", label: initiative.title });

		for (const plan of plans) {
			nodes.push({ col: 1, fullLabel: plan.title, id: plan.id, key: plan.id, kind: "plan", label: plan.title, status: plan.status });
			edges.push({ from: initiative.id, to: plan.id });
		}

		for (const prd of bundle.prds) {
			nodes.push({ col: 1, fullLabel: prd.title, id: prd.id, key: prd.id, kind: "prd", label: prd.title });
			edges.push({ from: initiative.id, to: prd.id });
		}

		for (const adr of bundle.adrs) {
			nodes.push({ col: 1, fullLabel: adr.title, id: adr.id, key: adr.id, kind: "adr", label: adr.title });
			edges.push({ from: initiative.id, to: adr.id });
		}

		for (const story of bundle.userStories) {
			nodes.push({ col: 2, fullLabel: story.title, id: story.id, key: story.id, kind: "story", label: story.title });
			edges.push({ from: initiative.id, to: story.id });
		}

		for (const link of bundle.subIssueLinks) {
			const children = childIssuesByParentId.get(link.parent.id) ?? [];
			children.push(link.issue);
			childIssuesByParentId.set(link.parent.id, children);
		}

		for (const [parentId, children] of childIssuesByParentId) {
			childIssuesByParentId.set(parentId, this.sortEntities(children));
		}

		for (const link of bundle.fixLinks) {
			const storyIds = fixingStoryIdsByIssueId.get(link.issue.id) ?? [];
			storyIds.push(link.userStory.id);
			fixingStoryIdsByIssueId.set(link.issue.id, storyIds);
		}

		const rootIssues = this.sortEntities(bundle.issues.filter((issue) => !childIssueIds.has(issue.id)));
		let maxIssueDepth = 0;
		const seen = new Set<string>();

		const visitIssue = (issue: Entity, depth: number) => {
			if (seen.has(issue.id)) {
				maxIssueDepth = Math.max(maxIssueDepth, depth);
				return;
			}

			seen.add(issue.id);
			maxIssueDepth = Math.max(maxIssueDepth, depth);
			nodes.push({
				col: 3 + depth,
				fullLabel: issue.title,
				id: issue.id,
				key: issue.id,
				kind: "issue",
				label: issue.title,
				status: issue.status
			});

			const storyIds = fixingStoryIdsByIssueId.get(issue.id) ?? [];
			if (storyIds.length > 0) {
				for (const storyId of storyIds) {
					edges.push({ from: storyId, to: issue.id });
				}
			} else if (depth === 0) {
				edges.push({ from: initiative.id, to: issue.id });
			}

			for (const child of childIssuesByParentId.get(issue.id) ?? []) {
				visitIssue(child, depth + 1);
				edges.push({ from: issue.id, to: child.id });
			}
		};

		for (const issue of rootIssues) {
			visitIssue(issue, 0);
		}

		for (const issue of this.sortEntities(bundle.issues)) {
			if (!seen.has(issue.id)) {
				visitIssue(issue, 0);
			}
		}

		const issueColumns = ["Issues"];
		for (let depth = 1; depth <= maxIssueDepth; depth += 1) {
			issueColumns.push(depth === 1 ? "Sub-issues" : "Nested sub-issues");
		}
		const debtColumn = 3 + issueColumns.length;
		const ownedDebt = this.sortEntities(
			(snapshot?.entities ?? []).filter(
				(entity) =>
					entity.kind === "debt" &&
					(snapshot?.relations ?? []).some(
						(relation) => relation.fromId === initiative.id && relation.toId === entity.id && relation.type === "records"
					)
			)
		);

		for (const debt of ownedDebt) {
			nodes.push({
				col: debtColumn,
				fullLabel: debt.title,
				id: debt.id,
				key: debt.id,
				kind: "debt",
				label: debt.title,
				status: debt.status
			});
			edges.push({ from: initiative.id, label: "records", to: debt.id });
		}

		const visibleNodeIds = new Set(nodes.map((node) => node.id));
		const debtIds = new Set(ownedDebt.map((debt) => debt.id));
		const planIds = new Set(plans.map((plan) => plan.id));
		for (const relation of snapshot?.relations ?? []) {
			if (relation.type === "informs" && planIds.has(relation.fromId) && visibleNodeIds.has(relation.toId)) {
				edges.push({ from: relation.fromId, label: "informs", to: relation.toId });
			}

			if (relation.type === "resolves" && visibleNodeIds.has(relation.fromId) && debtIds.has(relation.toId)) {
				edges.push({ from: relation.fromId, label: "resolves", to: relation.toId });
			}

			if (relation.type === "relatesTo" && debtIds.has(relation.fromId) && visibleNodeIds.has(relation.toId)) {
				edges.push({ from: relation.fromId, label: "relatesTo", to: relation.toId });
			}
		}

		const graph = { columns: ["Initiative", "Plans, PRDs & ADRs", "User stories", ...issueColumns, "Debt records"], edges, nodes };
		return visibleKinds ? filterGraphByKind(graph, visibleKinds) : graph;
	}

	public buildProjectGraph(): RelationshipGraph {
		const snapshot = this.snapshot.get();
		const epicGroups = this.epicInitiativeGroups.get();
		const projectKey = "__project";
		const nodeKeyByEntityId = new Map<string, string>();
		const selectedProjectId = this.selectedProjectId.get();
		const nodes: GraphNode[] = [
			{
				col: 0,
				fullLabel: this.projectDescription.get(),
				id: "",
				key: projectKey,
				kind: "project",
				label: this.selectedTenantDisplayName.get() ?? ""
			}
		];
		const edges: GraphEdge[] = [];
		if (selectedProjectId) {
			nodeKeyByEntityId.set(selectedProjectId, projectKey);
		}

		for (const adr of snapshot?.projectAdrs ?? []) {
			nodes.push({ col: 1, fullLabel: adr.title, id: adr.id, key: adr.id, kind: "adr", label: adr.title, status: adr.status });
			nodeKeyByEntityId.set(adr.id, adr.id);
			edges.push({ from: projectKey, to: adr.id });
		}

		for (const group of epicGroups) {
			const { epic } = group;
			nodes.push({
				col: 1,
				fullLabel: epic.title,
				id: epic.id,
				key: epic.id,
				kind: "epic",
				label: epic.title,
				status: epic.status
			});
			nodeKeyByEntityId.set(epic.id, epic.id);
			edges.push({ from: projectKey, to: epic.id });

			for (const bundle of group.initiatives) {
				const initiative = bundle.initiative;
				const storyKeyById = new Map<string, string>();
				const fixingStoryIdsByIssueId = new Map<string, string[]>();
				nodes.push({
					col: 2,
					fullLabel: `${initiative.title} — ${bundle.userStories.length} stories, ${bundle.issues.length} issues`,
					id: initiative.id,
					key: initiative.id,
					kind: "initiative",
					label: initiative.title,
					status: initiative.status
				});
				nodeKeyByEntityId.set(initiative.id, initiative.id);
				edges.push({ from: epic.id, to: initiative.id });

				const records: { entity: Entity; kind: string }[] = [
					...this.sortEntities(bundle.entities.filter((entity) => entity.kind === "plan")).map((plan) => ({ entity: plan, kind: "plan" })),
					...bundle.prds.map((prd) => ({ entity: prd, kind: "prd" })),
					...bundle.adrs.map((adr) => ({ entity: adr, kind: "adr" }))
				];
				for (const { entity, kind } of records) {
					const key = `${initiative.id}:${entity.id}`;
					nodes.push({ col: 3, fullLabel: entity.title, id: entity.id, key, kind, label: entity.title, status: entity.status });
					nodeKeyByEntityId.set(entity.id, key);
					edges.push({ from: initiative.id, to: key });
				}

				for (const story of this.sortEntities(bundle.userStories)) {
					const key = `${initiative.id}:${story.id}`;
					storyKeyById.set(story.id, key);
					nodeKeyByEntityId.set(story.id, key);
					nodes.push({ col: 4, fullLabel: story.title, id: story.id, key, kind: "story", label: story.title, status: story.status });
					edges.push({ from: initiative.id, to: key });
				}

				for (const link of bundle.fixLinks) {
					const storyIds = fixingStoryIdsByIssueId.get(link.issue.id) ?? [];
					storyIds.push(link.userStory.id);
					fixingStoryIdsByIssueId.set(link.issue.id, storyIds);
				}

				for (const issue of this.sortEntities(bundle.issues)) {
					const key = `${initiative.id}:${issue.id}`;
					nodeKeyByEntityId.set(issue.id, key);
					nodes.push({ col: 5, fullLabel: issue.title, id: issue.id, key, kind: "issue", label: issue.title, status: issue.status });
					const storyKeys = (fixingStoryIdsByIssueId.get(issue.id) ?? [])
						.map((storyId) => storyKeyById.get(storyId))
						.filter((storyKey): storyKey is string => Boolean(storyKey));
					if (storyKeys.length > 0) {
						for (const storyKey of storyKeys) {
							edges.push({ from: storyKey, to: key });
						}
					} else {
						edges.push({ from: initiative.id, to: key });
					}
				}
			}
		}

		const debtKeyById = new Map<string, string>();
		const debtRecords = this.sortEntities((snapshot?.entities ?? []).filter((entity) => entity.kind === "debt"));
		for (const debt of debtRecords) {
			const owner = (snapshot?.relations ?? []).find(
				(relation) => relation.fromId !== debt.id && relation.toId === debt.id && relation.type === "records"
			);
			const ownerKey = owner ? nodeKeyByEntityId.get(owner.fromId) : undefined;
			if (!ownerKey) {
				continue;
			}

			debtKeyById.set(debt.id, debt.id);
			nodes.push({ col: 6, fullLabel: debt.title, id: debt.id, key: debt.id, kind: "debt", label: debt.title, status: debt.status });
			edges.push({ from: ownerKey, label: "records", to: debt.id });
		}

		for (const relation of snapshot?.relations ?? []) {
			if (relation.type === "informs") {
				const sourceKey = nodeKeyByEntityId.get(relation.fromId);
				const targetKey = nodeKeyByEntityId.get(relation.toId);
				if (sourceKey && targetKey) {
					edges.push({ from: sourceKey, label: "informs", to: targetKey });
				}
			}

			if (relation.type === "resolves") {
				const resolverKey = nodeKeyByEntityId.get(relation.fromId);
				const debtKey = debtKeyById.get(relation.toId);
				if (resolverKey && debtKey) {
					edges.push({ from: resolverKey, label: "resolves", to: debtKey });
				}
			}

			if (relation.type === "relatesTo") {
				const debtKey = debtKeyById.get(relation.fromId);
				const relatedKey = nodeKeyByEntityId.get(relation.toId) ?? debtKeyById.get(relation.toId);
				if (debtKey && relatedKey) {
					edges.push({ from: debtKey, label: "relatesTo", to: relatedKey });
				}
			}
		}

		return filterGraphByKind(
			{ columns: ["Project", "Epics", "Initiatives", "Plans, PRDs & ADRs", "User stories", "Issues", "Debt records"], edges, nodes },
			this.visibleProjectGraphKinds.get()
		);
	}

	public toggleProjectGraphKind(kind: ProjectGraphKind) {
		const visibleKinds = new Set(this.visibleProjectGraphKinds.get());
		if (visibleKinds.has(kind)) {
			visibleKinds.delete(kind);
		} else {
			visibleKinds.add(kind);
		}
		this.visibleProjectGraphKinds.set(visibleKinds);
	}

	public isDoneStatus(status: string) {
		return status === "done" || status === "complete" || status === "closed";
	}

	public issueStatusTone(status: string) {
		if (this.isDoneStatus(status)) {
			return "done";
		}

		if (status === "blocked" || status === "paused") {
			return "blocked";
		}

		return "open";
	}

	public formatKindLabel(kind: string) {
		if (kind === "all") {
			return "All work items";
		}

		if (kind === "userStory") {
			return "User story";
		}

		if (kind === "prd") {
			return "PRD";
		}

		if (kind === "adr") {
			return "ADR";
		}

		return kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : "Unknown";
	}

	public statusTone(status: string) {
		if (status === "blocked" || status === "paused") {
			return "warn";
		}

		if (status === "cancelled") {
			return "danger";
		}

		if (status === "archived" || status === "done" || status === "complete" || status === "closed") {
			return "neutral";
		}

		return "success";
	}

	public badgeTone(status: string) {
		if (status === "done" || status === "complete" || status === "closed") {
			return "done";
		}

		if (status === "blocked" || status === "cancelled") {
			return "danger";
		}

		if (status === "ready" || status === "in-progress") {
			return "info";
		}

		if (status === "paused") {
			return "warn";
		}

		if (status === "active" || status === "current" || status === "approved") {
			return "success";
		}

		return "neutral";
	}

	public compactPath(value: string) {
		const segments = value.split("/").filter(Boolean);
		if (segments.length <= 3) {
			return value;
		}

		return `.../${segments.slice(-3).join("/")}`;
	}

	public formatTimestamp(value: string) {
		const timestamp = new Date(value);
		return Number.isNaN(timestamp.getTime())
			? value
			: new Intl.DateTimeFormat(undefined, {
					year: "numeric",
					month: "short",
					day: "numeric",
					hour: "numeric",
					minute: "2-digit"
				}).format(timestamp);
	}

	public truncate(value: string, maxLength: number) {
		return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
	}

	public shortRef(entity: { id: string; kind: string; shortReference?: string }) {
		return shortEntityReference(entity);
	}

	public buildOpenedText(entity: Entity) {
		const bundle = this.selectedBundle.get();
		const bundleText = bundle ? `inside ${bundle.initiative.id}` : "outside a visible initiative bundle";
		return `Opened ${this.formatTimestamp(entity.createdAt)} and currently ${bundleText}. Last updated ${this.formatTimestamp(entity.updatedAt)}.`;
	}

	public buildSummaryBody(entity: Entity) {
		const bundle = this.selectedBundle.get();
		const context = this.selectedContext.get();
		const selectedIncoming = this.selectedIncoming.get();
		const selectedOutgoing = this.selectedOutgoing.get();
		const orphanIds = this.orphanIds.get();

		const bundleSentence = bundle
			? `It currently sits in ${bundle.initiative.id}, which includes ${bundle.prds.length} PRDs, ${bundle.userStories.length} stories, ${bundle.adrs.length} ADRs, and ${bundle.issues.length} issues.`
			: "It is not currently connected to a visible initiative bundle in this snapshot.";

		const orphanSentence = orphanIds.has(entity.id)
			? "This record is marked as orphaned from the initiative structure."
			: "This record remains connected to the main initiative structure.";

		const contextSentence = context
			? `${context.context.title} is currently ${context.context.exists ? "stored" : "using its default shell"} with ${context.terms.length} defined terms.`
			: "No context is currently available for this record.";

		return `${entity.id} is a ${this.formatKindLabel(entity.kind).toLowerCase()} with ${selectedIncoming.length} incoming links and ${selectedOutgoing.length} outgoing links. ${bundleSentence} ${contextSentence} ${orphanSentence}`;
	}

	public buildRelationSentence(relation: Relation) {
		return `${relation.fromId} ${relation.type} ${relation.toId}`;
	}

	public relationLabel(type: string, incoming: boolean) {
		const incomingLabels: Record<string, string> = {
			blocks: "Blocked by",
			constrains: "Constrained by",
			decomposes: "Parent issue",
			creates: "Created by",
			fixes: "Fixed by",
			handsOff: "Incoming handoffs",
			owns: "Owned by",
			records: "Recorded by",
			resolves: "Resolved by",
			tracks: "Tracked by"
		};
		const outgoingLabels: Record<string, string> = {
			blocks: "Blocks",
			constrains: "Constrains",
			decomposes: "Sub-issues",
			creates: "Creates",
			fixes: "Fixes",
			relatesTo: "Related records",
			resolves: "Resolves debt",
			owns: "Owns",
			records: "Records",
			tracks: "Tracks"
		};

		if (incoming) {
			return incomingLabels[type] ?? `${type} (incoming)`;
		}

		return outgoingLabels[type] ?? type;
	}

	public detailMeta(entity: Entity): Array<[string, string]> {
		return this.detailMetaFor(entity.id);
	}

	public detailMetaFor(entityId: string | null): Array<[string, string]> {
		const entity = entityId ? this.entityById.get().get(entityId) ?? null : null;
		const bundle = this.bundleForEntityId(entityId);
		const owner = entity
			? this.incomingRelationsFor(entity.id)
				.find((relation) => relation.type === "records")
				?.fromId
			: null;
		const ownerEntity = owner ? this.entityById.get().get(owner) ?? null : null;
		const debtMeta: Array<[string, string]> = entity?.kind === "debt"
			? [
				["Category", entity.category ?? "—"],
				["Priority", entity.priority ?? "—"],
				["Lifecycle", entity.status],
				["Owner", ownerEntity ? `${this.shortRef(ownerEntity)} ${ownerEntity.title}` : "—"]
			]
			: [];
		const statusMeta: Array<[string, string]> = entity?.kind === "debt" ? [] : [["Status", entity?.status ?? "—"]];
		const typeMeta: Array<[string, string]> = entity?.type ? [["Type", entity.type]] : [];
		return [
			["Initiative", bundle ? `${this.shortRef(bundle.initiative)} ${bundle.initiative.title}` : "—"],
			...debtMeta,
			...statusMeta,
			...typeMeta,
			["Created", entity ? this.formatTimestamp(entity.createdAt) : "—"],
			["Updated", entity ? this.formatTimestamp(entity.updatedAt) : "—"]
		];
	}

	public linkedRecordSections(options?: { excludeRelationTypes?: string[]; excludeRelatedIds?: string[] }): Array<{ key: string; records: Entity[]; title: string }> {
		return this.linkedRecordSectionsFor(this.selectedId.get(), options);
	}

	public linkedRecordSectionsFor(
		entityId: string | null,
		options?: { excludeRelationTypes?: string[]; excludeRelatedIds?: string[] }
	): Array<{ key: string; records: Entity[]; title: string; crossLink: boolean }> {
		const spineRelationTypes = new Set(["owns", "creates", "fixes", "decomposes", "tracks", "constrains"]);
		const grouped = new Map<string, { records: Entity[]; crossLink: boolean }>();
		const excludedRelationTypes = new Set(options?.excludeRelationTypes ?? []);
		const excludedRelatedIds = new Set(options?.excludeRelatedIds ?? []);
		const add = (relatedId: string, label: string, relationType: string) => {
			if (excludedRelatedIds.has(relatedId)) {
				return;
			}

			const entity = this.entityById.get().get(relatedId);
			if (!entity) {
				return;
			}

			const group = grouped.get(label) ?? { crossLink: !spineRelationTypes.has(relationType), records: [] };
			group.records.push(entity);
			grouped.set(label, group);
		};

		for (const relation of this.outgoingRelationsFor(entityId)) {
			if (excludedRelationTypes.has(relation.type)) {
				continue;
			}

			add(relation.toId, this.relationLabel(relation.type, false), relation.type);
		}
		for (const relation of this.incomingRelationsFor(entityId)) {
			if (excludedRelationTypes.has(relation.type)) {
				continue;
			}

			add(relation.fromId, this.relationLabel(relation.type, true), relation.type);
		}

		return [...grouped.entries()].map(([title, group]) => ({
			crossLink: group.crossLink,
			key: title,
			records: this.sortEntities(group.records),
			title
		}));
	}

	public debtRecordSectionsFor(entityId: string | null): Array<{ key: string; records: Entity[]; title: string }> {
		const entity = entityId ? this.entityById.get().get(entityId) ?? null : null;
		if (!entity || !["project", "epic", "initiative", "issue"].includes(entity.kind)) {
			return [];
		}

		const ownedDebt = this.outgoingRelationsFor(entity.id)
			.filter((relation) => relation.type === "records")
			.map((relation) => this.entityById.get().get(relation.toId))
			.filter((record): record is Entity => record?.kind === "debt");
		const resolvedDebt = ["epic", "initiative", "issue"].includes(entity.kind)
			? this.outgoingRelationsFor(entity.id)
				.filter((relation) => relation.type === "resolves")
				.map((relation) => this.entityById.get().get(relation.toId))
				.filter((record): record is Entity => record?.kind === "debt")
			: [];

		return [
			...(ownedDebt.length > 0 ? [{ key: "owned-debt", records: this.sortEntities(ownedDebt), title: "Owned debt" }] : []),
			...(resolvedDebt.length > 0 ? [{ key: "resolved-debt", records: this.sortEntities(resolvedDebt), title: "Resolves debt" }] : [])
		];
	}

	public planProjectionFor(planId: string): { current: Array<{ key: PlanCurrentGroupKey; title: string; entries: PlanEntry[] }>; history: PlanEntry[] } {
		const history = [...(this.snapshot.get()?.planEntries ?? [])]
			.filter((entry) => entry.planId === planId)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.reference.localeCompare(right.reference));
		const supersededEntryIds = new Set(history.flatMap((entry) => entry.supersededEntryIds));
		const activeEntries = history.filter((entry) => !entry.tombstone && !supersededEntryIds.has(entry.id));

		return {
			current: PLAN_CURRENT_GROUPS.map((group) => ({
				key: group.key,
				title: group.title,
				entries: activeEntries.filter((entry) => belongsToPlanCurrentGroup(entry, group.key))
			})),
			history
		};
	}

	public closeEntity() {
		const bundle = this.selectedBundle.get();
		this.selectedId.set(null);

		if (this.activeSection.get() !== "adrs" && bundle) {
			this.selectedInitiativeId.set(bundle.initiative.id);
			this.activePage.set("initiative");
			this.writeRoute(this.currentRoute());
			return;
		}

		this.activePage.set("list");
		this.writeRoute(this.currentRoute());
	}

	public getContextForInitiative(initiativeId: string): ContextDetails | null {
		return this.initiativeContextById.get().get(initiativeId) ?? null;
	}

	protected async bootstrap() {
		try {
			const config = await this.fetchJson<SiteConfig>("site-config.json");
			this.config.set(config);
			const route = this.readRoute();
			const initialRoute = { ...route, tenantId: route.tenantId ?? config.currentTenant };
			this.selectedTenant.set(initialRoute.tenantId);
			await this.reloadProjectDiscovery();
			await this.navigateToRoute(initialRoute);
			this.writeRoute(this.currentRoute(), true);
		} catch (error) {
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
			this.syncLabel.set("load failed");
		}
	}

	protected async reloadSnapshot() {
		const result = await this.fetchJson<ProjectSnapshot>(this.buildTenantScopedPath("/api/snapshot"));
		if (result.kind === "unavailable") {
			throw new Error("Selected project is unavailable.");
		}

		this.snapshot.set(result.snapshot);
		this.onHashChange();
		const selectedId = this.selectedId.get();
		if (selectedId && !this.entityById.get().has(selectedId)) {
			this.selectedId.set(null);
		}
		this.errorMessage.set(null);
		this.syncLabel.set("listening");
	}

	protected async reloadProjectDiscovery() {
		try {
			this.projectDiscovery.set(await this.fetchJson<ProjectDiscovery>(this.buildTenantScopedPath("/api/projects")));
			this.errorMessage.set(null);
		} catch (error) {
			this.projectDiscovery.set({ kind: "unavailable" });
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
		}
	}

	protected async navigateToRoute(route: ViewerRoute) {
		const scopeChanged = route.tenantId !== this.selectedTenant.get() || route.projectId !== this.selectedProjectId.get();
		this.selectedTenant.set(route.tenantId);
		this.selectedProjectId.set(route.projectId);
		if (scopeChanged) {
			this.resetScopeDetail();
		}
		if (!route.projectId) {
			this.snapshot.set(null);
			this.syncLabel.set("choose a project");
			await this.reloadProjectDiscovery();
			this.applyRoute(route);
			return;
		}

		this.stopLiveUpdates();
		this.syncLabel.set("connecting");
		try {
			await this.reloadSnapshot();
			this.connectEvents();
			this.applyRoute(route);
		} catch (error) {
			this.selectedProjectId.set(null);
			this.snapshot.set(null);
			this.writeRoute(this.currentRoute(), true);
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
			this.syncLabel.set("project unavailable");
		}
	}

	protected resetScopeDetail() {
		this.selectedId.set(null);
		this.selectedInitiativeId.set(null);
		this.cascadePath.set([]);
		this.reRootTrail.set([]);
		this.activeSection.set("initiatives");
		this.activePage.set("list");
		this.activeView.set("overview");
		this.initTab.set("overview");
		this.initiativeStatusFilter.set("all");
		this.adrStatusFilter.set("all");
		this.clearMasterOverrideIfShallow();
	}

	protected connectEvents() {
		if (typeof EventSource !== "function") {
			this.startPolling();
			return;
		}

		this.events = new EventSource(this.buildTenantScopedPath("/events"));
		this.events.onmessage = () => {
			void this.reloadSnapshot();
		};
		this.events.onerror = () => {
			this.syncLabel.set("reconnecting");
			this.startPolling();
		};
	}

	protected startPolling() {
		if (this.pollTimer !== null) {
			return;
		}

		this.pollTimer = window.setInterval(() => {
			void this.reloadSnapshot();
		}, 3000);
	}

	protected async fetchJson<T>(resourcePath: string): Promise<T> {
		const separator = resourcePath.includes("?") ? "&" : "?";
		const response = await fetch(`${resourcePath}${separator}ts=${Date.now()}`, { cache: "no-store" });
		if (!response.ok) {
			throw new Error(`Request failed for ${resourcePath}`);
		}

		return (await response.json()) as T;
	}

	protected sortEntities(entities: Entity[]) {
		return [...entities].sort((left, right) => {
			const leftTime = new Date(left.updatedAt).getTime();
			const rightTime = new Date(right.updatedAt).getTime();
			if (leftTime !== rightTime) {
				return rightTime - leftTime;
			}

			return left.id.localeCompare(right.id);
		});
	}

	protected buildIssueTree(bundle: InitiativeBundle, rootIds: string[], relevantIds: Set<string>): IssueTreeNode[] {
		const issueById = new Map(bundle.issues.map((issue) => [issue.id, issue]));
		const childIssueIdsByParentId = new Map<string, string[]>();

		for (const link of bundle.subIssueLinks) {
			if (!relevantIds.has(link.parent.id) || !relevantIds.has(link.issue.id)) {
				continue;
			}

			const childIssueIds = childIssueIdsByParentId.get(link.parent.id) ?? [];
			childIssueIds.push(link.issue.id);
			childIssueIdsByParentId.set(link.parent.id, childIssueIds);
		}

		const buildNode = (issueId: string): IssueTreeNode | null => {
			const issue = issueById.get(issueId);
			if (!issue) {
				return null;
			}

			const childIssues = this.sortEntities(
				(childIssueIdsByParentId.get(issueId) ?? [])
					.map((childIssueId) => issueById.get(childIssueId))
					.filter((childIssue): childIssue is Entity => Boolean(childIssue))
			);

			return {
				issue,
				children: childIssues
					.map((childIssue) => buildNode(childIssue.id))
					.filter((node): node is IssueTreeNode => node !== null)
			};
		};

		const rootIssues = this.sortEntities(
			rootIds
				.map((issueId) => issueById.get(issueId))
				.filter((issue): issue is Entity => Boolean(issue))
		);

		return rootIssues
			.map((issue) => buildNode(issue.id))
			.filter((node): node is IssueTreeNode => node !== null);
	}

	protected issueTreeNodeIds(node: IssueTreeNode): string[] {
		return [node.issue.id, ...node.children.flatMap((child) => this.issueTreeNodeIds(child))];
	}

	protected formatTenantDisplayName(tenantId: string) {
		return tenantId
			.replace(/-[0-9a-f]{12}$/i, "")
			.split(/[-_]+/)
			.filter((segment) => segment.length > 0)
			.map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
			.join(" ");
	}

	protected readTenantFromUrl() {
		return this.readRoute().tenantId;
	}

	protected readProjectFromUrl() {
		return this.readRoute().projectId;
	}

	protected currentRoute(): ViewerRoute {
		return {
			tenantId: this.selectedTenant.get(),
			projectId: this.selectedProjectId.get(),
			section: this.activeSection.get(),
			entityId: this.selectedId.get(),
			initiativeId: this.selectedInitiativeId.get()
		};
	}

	protected readRoute(): ViewerRoute {
		const url = new URL(window.location.href);
		const params = new URLSearchParams(url.hash.slice(1));
		const legacyParams = url.searchParams;
		const tenantId = params.get("tenant") ?? legacyParams.get("tenant");
		const projectId = params.get("project") ?? legacyParams.get("project");
		const section = params.get("section");
		return {
			tenantId,
			projectId,
			section: isConsoleSection(section) ? section : "initiatives",
			entityId: params.get("entity"),
			initiativeId: params.get("initiative")
		};
	}

	protected normalizeRoute(route: ViewerRoute): ViewerRoute {
		const entityById = this.entityById.get();
		if (entityById.size === 0) {
			return route;
		}

		const validEntityId = route.entityId && entityById.has(route.entityId) ? route.entityId : null;
		const validInitiativeId = route.initiativeId && this.bundleForInitiativeId(route.initiativeId) ? route.initiativeId : null;
		return {
			...route,
			entityId: validEntityId,
			initiativeId: validInitiativeId
		};
	}

	protected applyRoute(route: ViewerRoute): ViewerRoute {
		const normalizedRoute = this.normalizeRoute(route);
		this.selectedTenant.set(normalizedRoute.tenantId);
		this.selectedProjectId.set(normalizedRoute.projectId);
		this.activeSection.set(normalizedRoute.section);
		this.selectedId.set(normalizedRoute.entityId);
		this.selectedInitiativeId.set(normalizedRoute.initiativeId);
		this.cascadePath.set([]);
		this.reRootTrail.set([]);
		this.clearMasterOverrideIfShallow();
		this.activePage.set(normalizedRoute.entityId ? "entity" : normalizedRoute.initiativeId ? "initiative" : "list");
		this.activeView.set("overview");
		return normalizedRoute;
	}

	protected writeRoute(route: ViewerRoute, replace = false) {
		const nextUrl = new URL(window.location.href);
		const entries: string[] = [];
		const add = (key: string, value: string | null) => {
			if (value) {
				entries.push(`${key}=${encodeURIComponent(value)}`);
			}
		};
		add("tenant", route.tenantId);
		add("project", route.projectId);
		add("section", route.section === "initiatives" ? null : route.section);
		add("entity", route.entityId);
		add("initiative", route.initiativeId);
		nextUrl.searchParams.delete("tenant");
		nextUrl.searchParams.delete("project");
		nextUrl.hash = entries.join("&");
		window.history[replace ? "replaceState" : "pushState"]({}, "", nextUrl);
	}

	protected buildTenantScopedPath(resourcePath: string) {
		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		if (!tenantId && !projectId) {
			return resourcePath;
		}

		const separator = resourcePath.includes("?") ? "&" : "?";
		const query = new URLSearchParams();
		if (tenantId) {
			query.set("tenant", tenantId);
		}
		if (projectId && resourcePath === "/api/snapshot") {
			query.set("project", projectId);
		}
		return query.size > 0 ? `${resourcePath}${separator}${query}` : resourcePath;
	}

	protected stopLiveUpdates() {
		this.events?.close();
		this.events = null;
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}
}

function hasConflictingDefinitions(sources: ProjectContextTermSource[]): boolean {
	const definitions = new Set(
		sources
			.map((source) => source.definition.trim().toLowerCase())
			.filter((definition) => definition.length > 0)
	);

	return definitions.size > 1;
}

function belongsToPlanCurrentGroup(entry: PlanEntry, groupKey: PlanCurrentGroupKey): boolean {
	switch (groupKey) {
		case "questions":
			return entry.role === "question";
		case "decisions":
			return entry.role === "decision";
		case "includedScope":
			return entry.role === "scope" && entry.scopeDirection === "included";
		case "excludedScope":
			return entry.role === "scope" && entry.scopeDirection === "excluded";
		case "constraints":
			return entry.role === "constraint";
		case "preferences":
			return entry.role === "preference";
		case "considerations":
			return entry.role === "consideration";
	}
}

function compareProjectContextSources(left: ProjectContextTermSource, right: ProjectContextTermSource): number {
	if (left.scopeKind !== right.scopeKind) {
		return left.scopeKind === "default" ? -1 : 1;
	}

	if (left.scopeLabel !== right.scopeLabel) {
		return left.scopeLabel.localeCompare(right.scopeLabel);
	}

	return left.contextKey.localeCompare(right.contextKey);
}