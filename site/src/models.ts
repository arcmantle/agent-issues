import type { Core } from "cytoscape";

export type BodySource = "authored" | "generated";

export type Entity = {
	id: string;
	kind: string;
	title: string;
	status: string;
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

export type BlockerLink = {
	source: Entity;
	target: Entity;
};

export type ConstrainsLink = {
	adr: Entity;
	issue: Entity;
};

export type HandoffRecord = {
	id: string;
	entityId: string;
	initiativeId: string | null;
	summary: string;
	body: string;
	createdAt: string;
};

export type AdrRailEntry = {
	adr: Entity;
	scope: "project" | "initiative";
	scopeLabel: string;
};

export type InitiativeBundle = {
	initiative: Entity;
	prds: Entity[];
	userStories: Entity[];
	adrs: Entity[];
	issues: Entity[];
	fixLinks: FixLink[];
	blockerLinks: BlockerLink[];
	constrainsLinks: ConstrainsLink[];
	handoffs: HandoffRecord[];
};

export type ContextRecord = {
	key: string;
	scopeKind: "default" | "initiative";
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
	scopeKind: "default" | "initiative";
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

export type Snapshot = {
	generatedAt: string;
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

export type ViewMode = "overview" | "graph" | "raw";

export type PageMode = "list" | "initiative" | "entity";

export type RootTab = "initiatives" | "adrs";

export type ContextPageTab = "all" | "global" | "initiatives";

export type ConsoleSection = "initiatives" | "adrs" | "graph" | "context";

export type InitiativeTab = "overview" | "graph" | "context" | "handoffs";

export type GraphStatus = "idle" | "loading" | "ready" | "error";

export type CytoscapeFactory = (options: Record<string, unknown>) => Core;

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
};

export type RelationshipGraph = {
	columns: string[];
	nodes: GraphNode[];
	edges: GraphEdge[];
};