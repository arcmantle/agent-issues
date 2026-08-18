import type { Core } from "cytoscape";

export type BodySource = "authored" | "generated";

export type Entity = {
	id: string;
	shortReference?: string;
	kind: string;
	title: string;
	status: string;
	category?: string | null;
	priority?: string | null;
	type?: string | null;
	body: string;
	bodySource?: BodySource;
	createdAt: string;
	updatedAt: string;
};

export type Relation = {
	fromId: string;
	type: string;
	toId: string;
	createdAt: string;
};

export type FixLink = {
	issue: Entity;
	userStory: Entity;
};

export type SubIssueLink = {
	parent: Entity;
	issue: Entity;
};

export type BlockerLink = {
	source: Entity;
	target: Entity;
};

export type ConstrainsLink = {
	adr: Entity;
	issue: Entity;
};

export type AdrRailEntry = {
	adr: Entity;
	scope: "project" | "initiative";
	scopeLabel: string;
};

export type InitiativeBundle = {
	initiative: Entity;
	entities: Entity[];
	prds: Entity[];
	userStories: Entity[];
	adrs: Entity[];
	issues: Entity[];
	fixLinks: FixLink[];
	subIssueLinks: SubIssueLink[];
	blockerLinks: BlockerLink[];
	constrainsLinks: ConstrainsLink[];
};

export type EpicInitiativeGroup = {
	epic: Entity;
	initiatives: InitiativeBundle[];
	completedInitiativeCount: number;
};

export type ContextRecord = {
	key: string;
	scopeKind: "default" | "project" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	title: string;
	summary: string;
	createdAt: string | null;
	updatedAt: string | null;
	exists: boolean;
};

export type ContextTermRecord = {
	term: string;
	definition: string;
	avoid: string[];
	createdAt: string;
	updatedAt: string;
};

export type ContextDetails = {
	context: ContextRecord;
	terms: ContextTermRecord[];
};

export type ProjectContextTermSource = {
	contextKey: string;
	contextTitle: string;
	scopeKind: "default" | "project" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	definition: string;
	avoid: string[];
	updatedAt: string;
};

export type ProjectContextTermEntry = {
	term: string;
	sources: ProjectContextTermSource[];
	hasSharedSource: boolean;
	hasDuplicates: boolean;
	hasConflictingDefinitions: boolean;
};

export type SnapshotContexts = {
	shared: ContextDetails;
	initiatives: ContextDetails[];
};

export type IssueComment = {
	id: string;
	reference: string;
	issueId: string;
	createdBy: string;
	updatedBy: string;
	body?: string;
	referencedIssueIds: string[];
	tombstone: boolean;
	revision: number;
	contentHash: string;
	createdAt: string;
	updatedAt: string;
};

export type IssueCommentPage = {
	comments: IssueComment[];
	total: number;
	nextBefore: string | null;
};

export type PlanEntry = {
	id: string;
	reference: string;
	planId: string;
	role: "question" | "decision" | "scope" | "constraint" | "preference" | "consideration";
	body?: string;
	scopeDirection: "included" | "excluded" | null;
	referencedEntityIds: string[];
	supersededEntryIds: string[];
	tombstone: boolean;
	createdAt: string;
	updatedAt: string;
};

export type UserDirectoryEntry = {
	id: string;
	authenticationSubject: string;
	displayName: string | null;
	updatedAt: string;
};

export type Snapshot = {
	generatedAt: string;
	users: UserDirectoryEntry[];
	issueComments: Record<string, IssueCommentPage>;
	planEntries?: PlanEntry[];
	entities: Entity[];
	relations: Relation[];
	initiatives: InitiativeBundle[];
	orphans: Entity[];
	projectAdrs: Entity[];
	contexts: SnapshotContexts;
};

export type SiteConfig = {
	availableTenants: Array<{
		displayName: string;
		id: string;
	}>;
	currentTenant: string;
	dbPath: string;
};

export type ProjectRollup = {
	project: Entity;
	epicCount: number;
	initiativeCount: number;
	completedInitiativeCount: number;
};

export type ProjectDiscovery =
	| {
			kind: "available";
			projects: ProjectRollup[];
	  }
	| {
			kind: "unavailable";
	  };

export type ViewMode = "overview" | "graph" | "raw";

export type PageMode = "list" | "initiative" | "entity";

export type RootTab = "initiatives" | "adrs";

export type ContextPageTab = "all" | "global" | "initiatives";

export type ConsoleSection = "initiatives" | "adrs" | "debt" | "graph" | "context";

export type DebtFilter = "lifecycle" | "category" | "priority";

export type InitiativeTab = "overview" | "graph" | "context";

export type GraphStatus = "idle" | "loading" | "ready" | "error";

export type CytoscapeFactory = (options: Record<string, unknown>) => Core;

export const PROJECT_GRAPH_KINDS = ["project", "epic", "initiative", "plan", "prd", "adr", "story", "issue", "debt"] as const;

export type ProjectGraphKind = (typeof PROJECT_GRAPH_KINDS)[number];

export type GraphNode = {
	key: string;
	id: string;
	label: string;
	fullLabel: string;
	kind: string;
	col: number;
	status?: string;
};

export type GraphEdge = {
	from: string;
	to: string;
	label?: string;
};

export type RelationshipGraph = {
	columns: string[];
	nodes: GraphNode[];
	edges: GraphEdge[];
};