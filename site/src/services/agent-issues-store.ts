import { computed, signal } from "@lit-labs/signals";
import type { AdrRailEntry, ConsoleSection, ContextDetails, ContextPageTab, Entity, FixLink, GraphEdge, GraphNode, InitiativeBundle, InitiativeTab, PageMode, ProjectContextTermEntry, ProjectContextTermSource, Relation, RelationshipGraph, RootTab, SiteConfig, Snapshot, ViewMode } from "../models.js";

export class AgentIssuesStore {
	public config = signal<SiteConfig | null>(null);
	public snapshot = signal<Snapshot | null>(null);
	public search = signal("");
	public contextSearch = signal("");
	public contextTab = signal<ContextPageTab>("all");
	public kindFilter = signal("all");
	public selectedTenant = signal<string | null>(null);
	public selectedInitiativeId = signal<string | null>(null);
	public selectedId = signal<string | null>(null);
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

	public entityById = computed(() => new Map((this.snapshot.get()?.entities ?? []).map((entity) => [entity.id, entity])));

	public selectedEntity = computed(() => {
		const selectedId = this.selectedId.get();
		return selectedId ? this.entityById.get().get(selectedId) ?? null : null;
	});

	public selectedBundle = computed(() => {
		const entity = this.selectedEntity.get();
		if (!entity) {
			return null;
		}

		return (
			(this.snapshot.get()?.initiatives ?? []).find((bundle) =>
				[bundle.initiative, ...bundle.prds, ...bundle.userStories, ...bundle.adrs, ...bundle.issues].some(
					(candidate) => candidate.id === entity.id
				)
			) ?? null
		);
	});

	public selectedInitiativeBundle = computed(() => {
		const selectedInitiativeId = this.selectedInitiativeId.get();
		if (!selectedInitiativeId) {
			return null;
		}

		return (this.snapshot.get()?.initiatives ?? []).find((bundle) => bundle.initiative.id === selectedInitiativeId) ?? null;
	});

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

	public selectedIncoming = computed(() => {
		const selectedId = this.selectedId.get();
		if (!selectedId) {
			return [];
		}

		return (this.snapshot.get()?.relations ?? []).filter((relation) => relation.toId === selectedId);
	});

	public selectedOutgoing = computed(() => {
		const selectedId = this.selectedId.get();
		if (!selectedId) {
			return [];
		}

		return (this.snapshot.get()?.relations ?? []).filter((relation) => relation.fromId === selectedId);
	});

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

	public projectInitiatives = computed(() => this.snapshot.get()?.initiatives ?? []);

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
		window.addEventListener("hashchange", this.onHashChange);
		void this.bootstrap();
	}

	public disconnect() {
		if (!this.connected) {
			return;
		}

		this.connected = false;
		window.removeEventListener("hashchange", this.onHashChange);
		this.events?.close();
		this.events = null;
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	public onHashChange = () => {
		const hashParams = new URLSearchParams(window.location.hash.slice(1));
		const nextSelectedId = hashParams.get("entity");
		const nextSelectedInitiativeId = hashParams.get("initiative");
		this.selectedId.set(nextSelectedId);
		this.selectedInitiativeId.set(nextSelectedInitiativeId);
		this.activePage.set(nextSelectedId ? "entity" : nextSelectedInitiativeId ? "initiative" : "list");
		this.activeView.set("overview");
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
		this.activePage.set("list");
		const nextUrl = new URL(window.location.href);
		nextUrl.hash = "";
		window.history.pushState({}, "", nextUrl);
	}

	public setContextTab(tab: ContextPageTab) {
		this.contextTab.set(tab);
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
		this.selectedInitiativeId.set(null);
		this.selectedId.set(entityId);
		this.activePage.set("entity");
		window.location.hash = `entity=${encodeURIComponent(entityId)}`;
	}

	public selectInitiativeFromEvent = (event: Event) => {
		const initiativeId = (event.currentTarget as HTMLElement).dataset.id;
		if (!initiativeId) {
			return;
		}

		this.selectInitiative(initiativeId);
	};

	public selectInitiative(initiativeId: string) {
		this.selectedId.set(null);
		this.selectedInitiativeId.set(initiativeId);
		this.activePage.set("initiative");
		this.activeSection.set("initiatives");
		this.activeView.set("overview");
		this.initTab.set("overview");
		window.location.hash = `initiative=${encodeURIComponent(initiativeId)}`;
	}

	public clearSelection() {
		this.selectedInitiativeId.set(null);
		this.selectedId.set(null);
		this.activePage.set("list");
		this.activeView.set("overview");
		const nextUrl = new URL(window.location.href);
		nextUrl.hash = "";
		window.history.pushState({}, "", nextUrl);
	}

	public async selectTenant(tenantId: string) {
		if (!tenantId || tenantId === this.selectedTenant.get()) {
			return;
		}

		this.selectedTenant.set(tenantId);
		this.selectedId.set(null);
		this.selectedInitiativeId.set(null);
		this.activeSection.set("initiatives");
		this.activePage.set("list");
		this.activeView.set("overview");
		this.initTab.set("overview");
		this.updateTenantInUrl(tenantId);
		this.stopLiveUpdates();
		this.syncLabel.set("connecting");
		await this.reloadSnapshot();
		this.connectEvents();
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

	public buildInitiativeGraph(bundle: InitiativeBundle): RelationshipGraph {
		const initiative = bundle.initiative;
		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];

		nodes.push({ col: 0, fullLabel: initiative.title, id: initiative.id, key: initiative.id, kind: "initiative", label: initiative.title });

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

		const seen = new Set<string>();
		for (const story of bundle.userStories) {
			for (const issue of this.issuesForStory(bundle, story.id)) {
				seen.add(issue.id);
				nodes.push({ col: 3, fullLabel: issue.title, id: issue.id, key: issue.id, kind: "issue", label: issue.title, status: issue.status });
				edges.push({ from: story.id, to: issue.id });
			}
		}

		for (const issue of bundle.issues) {
			if (seen.has(issue.id)) {
				continue;
			}

			nodes.push({ col: 3, fullLabel: issue.title, id: issue.id, key: issue.id, kind: "issue", label: issue.title, status: issue.status });
			edges.push({ from: initiative.id, to: issue.id });
		}

		return { columns: ["Initiative", "PRDs & ADRs", "User stories", "Issues"], edges, nodes };
	}

	public buildProjectGraph(): RelationshipGraph {
		const bundles = this.snapshot.get()?.initiatives ?? [];
		const projectKey = "__project";
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

		for (const bundle of bundles) {
			const initiative = bundle.initiative;
			nodes.push({
				col: 1,
				fullLabel: `${initiative.title} — ${bundle.userStories.length} stories, ${bundle.issues.length} issues`,
				id: initiative.id,
				key: initiative.id,
				kind: "initiative",
				label: initiative.title
			});
			edges.push({ from: projectKey, to: initiative.id });

			const records: { entity: Entity; kind: string }[] = [
				...bundle.prds.map((prd) => ({ entity: prd, kind: "prd" })),
				...bundle.adrs.map((adr) => ({ entity: adr, kind: "adr" }))
			];
			for (const { entity, kind } of records) {
				const key = `${initiative.id}:${entity.id}`;
				nodes.push({ col: 2, fullLabel: entity.title, id: entity.id, key, kind, label: entity.title });
				edges.push({ from: initiative.id, to: key });
			}
		}

		return { columns: ["Project", "Initiatives", "PRDs & ADRs"], edges, nodes };
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

		if (status === "archived" || status === "cancelled") {
			return "danger";
		}

		if (status === "done" || status === "complete" || status === "closed") {
			return "neutral";
		}

		return "success";
	}

	public badgeTone(status: string) {
		if (status === "done" || status === "complete" || status === "closed") {
			return "done";
		}

		if (status === "blocked" || status === "cancelled" || status === "archived") {
			return "danger";
		}

		if (status === "ready" || status === "in-progress") {
			return "info";
		}

		if (status === "proposed" || status === "paused") {
			return "warn";
		}

		if (status === "active" || status === "accepted" || status === "approved") {
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
			creates: "Created by",
			fixes: "Fixed by",
			owns: "Owned by",
			records: "Recorded by",
			tracks: "Tracked by"
		};
		const outgoingLabels: Record<string, string> = {
			blocks: "Blocks",
			constrains: "Constrains",
			creates: "Creates",
			fixes: "Fixes",
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
		const bundle = this.selectedBundle.get();
		return [
			["Initiative", bundle ? `${bundle.initiative.id} ${bundle.initiative.title}` : "—"],
			["Status", entity.status],
			["Updated", this.formatTimestamp(entity.updatedAt)]
		];
	}

	public linkedRecordSections(): Array<{ key: string; records: Entity[]; title: string }> {
		const grouped = new Map<string, Entity[]>();
		const add = (relatedId: string, label: string) => {
			const entity = this.entityById.get().get(relatedId);
			if (!entity) {
				return;
			}

			const records = grouped.get(label) ?? [];
			records.push(entity);
			grouped.set(label, records);
		};

		for (const relation of this.selectedOutgoing.get()) {
			add(relation.toId, this.relationLabel(relation.type, false));
		}
		for (const relation of this.selectedIncoming.get()) {
			add(relation.fromId, this.relationLabel(relation.type, true));
		}

		return [...grouped.entries()].map(([title, records]) => ({
			key: title,
			records: this.sortEntities(records),
			title
		}));
	}

	public closeEntity() {
		const bundle = this.selectedBundle.get();
		this.selectedId.set(null);

		if (this.activeSection.get() !== "adrs" && bundle) {
			this.selectedInitiativeId.set(bundle.initiative.id);
			this.activePage.set("initiative");
			window.location.hash = `initiative=${encodeURIComponent(bundle.initiative.id)}`;
			return;
		}

		this.activePage.set("list");
		const nextUrl = new URL(window.location.href);
		nextUrl.hash = "";
		window.history.pushState({}, "", nextUrl);
	}

	public getContextForInitiative(initiativeId: string): ContextDetails | null {
		return this.initiativeContextById.get().get(initiativeId) ?? null;
	}

	protected async bootstrap() {
		try {
			const config = await this.fetchJson<SiteConfig>("site-config.json");
			this.config.set(config);
			const requestedTenant = this.readTenantFromUrl();
			const selectedTenant = requestedTenant && config.availableTenants.some((tenant) => tenant.id === requestedTenant)
				? requestedTenant
				: config.currentTenant;

			this.selectedTenant.set(selectedTenant);
			if (selectedTenant !== requestedTenant) {
				this.updateTenantInUrl(selectedTenant);
			}
			this.syncLabel.set("connecting");
			await this.reloadSnapshot();
			this.connectEvents();
		} catch (error) {
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
			this.syncLabel.set("load failed");
		}
	}

	protected async reloadSnapshot() {
		this.snapshot.set(await this.fetchJson<Snapshot>(this.buildTenantScopedPath("/api/snapshot")));
		this.onHashChange();
		const selectedId = this.selectedId.get();
		if (selectedId && !this.entityById.get().has(selectedId)) {
			this.selectedId.set(null);
		}
		this.errorMessage.set(null);
		this.syncLabel.set("listening");
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

	protected formatTenantDisplayName(tenantId: string) {
		return tenantId
			.replace(/-[0-9a-f]{12}$/i, "")
			.split(/[-_]+/)
			.filter((segment) => segment.length > 0)
			.map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
			.join(" ");
	}

	protected readTenantFromUrl() {
		return new URL(window.location.href).searchParams.get("tenant");
	}

	protected updateTenantInUrl(tenantId: string) {
		const nextUrl = new URL(window.location.href);
		nextUrl.searchParams.set("tenant", tenantId);
		nextUrl.hash = "";
		window.history.pushState({}, "", nextUrl);
	}

	protected buildTenantScopedPath(resourcePath: string) {
		const tenantId = this.selectedTenant.get();
		if (!tenantId) {
			return resourcePath;
		}

		const separator = resourcePath.includes("?") ? "&" : "?";
		return `${resourcePath}${separator}tenant=${encodeURIComponent(tenantId)}`;
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

function compareProjectContextSources(left: ProjectContextTermSource, right: ProjectContextTermSource): number {
	if (left.scopeKind !== right.scopeKind) {
		return left.scopeKind === "default" ? -1 : 1;
	}

	if (left.scopeLabel !== right.scopeLabel) {
		return left.scopeLabel.localeCompare(right.scopeLabel);
	}

	return left.contextKey.localeCompare(right.contextKey);
}