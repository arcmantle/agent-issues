import type { EntityRecord, RelationRecord, RelationType } from "./domain.js";
import type { ContextDetails } from "../context/context-types.js";

/**
 * The entity/handoff-store result contract (ADR13's dialect-agnostic
 * boundary): every `StorageDriver` implementation - SQLite
 * (`@agent-issues/api-local`) and Postgres (`@agent-issues/api-pg`) alike -
 * returns these same shapes, so they live in core rather than either
 * concrete store.
 */

export type LinkResult = {
	relation: RelationRecord;
	created: boolean;
};

export type EntityDetails = {
	entity: EntityRecord;
	incoming: Array<{ relationType: RelationType; entity: EntityRecord }>;
	outgoing: Array<{ relationType: RelationType; entity: EntityRecord }>;
};

export type QueryEntitiesInput = {
	kind: string;
	statuses?: string[];
	parentId?: string;
	limit?: number;
};

export type QueryEntitiesResult = {
	entities: EntityRecord[];
	total: number;
	/**
	 * Only populated when `kind` is `"issue"`: maps each returned issue's
	 * canonical reference to the references of its open (not-`done`)
	 * `blocks` sources, so a caller ranking workable candidates can read
	 * blocked-status straight off the list instead of issuing one
	 * `queryEntityRelations` call per candidate. Keyed and valued by
	 * reference, not internal id, so a caller never has to resolve a raw id
	 * back to something it can pass to another command.
	 */
	openBlockers?: Record<string, string[]>;
};

export type RelationDirection = "incoming" | "outgoing" | "both";

export type QueryEntityRelationsInput = {
	entityId: string;
	direction?: RelationDirection;
	types?: RelationType[];
};

export type InitiativeBundle = {
	initiative: EntityRecord;
	entities: EntityRecord[];
	prds: EntityRecord[];
	userStories: EntityRecord[];
	adrs: EntityRecord[];
	issues: EntityRecord[];
	fixLinks: Array<{ issue: EntityRecord; userStory: EntityRecord }>;
	subIssueLinks: Array<{ parent: EntityRecord; issue: EntityRecord }>;
	blockerLinks: Array<{ source: EntityRecord; target: EntityRecord }>;
	constrainsLinks: Array<{ adr: EntityRecord; issue: EntityRecord }>;
};

export type ProjectDiscovery =
	| {
			kind: "available";
			projects: ProjectRollup[];
	  }
	| {
			kind: "unavailable";
	  };

export type ProjectRollup = {
	project: EntityRecord;
	epicCount: number;
	initiativeCount: number;
	completedInitiativeCount: number;
};

export type DatabaseSnapshot = {
	generatedAt: string;
	entities: EntityRecord[];
	relations: RelationRecord[];
	orphans: EntityRecord[];
	projectAdrs: EntityRecord[];
	initiatives: InitiativeBundle[];
	contexts: {
		shared: ContextDetails;
		initiatives: ContextDetails[];
	};
};

export type ProjectSnapshot =
	| {
			kind: "available";
			snapshot: DatabaseSnapshot;
	  }
	| {
			kind: "unavailable";
	  };

export type StatusUpdateResult = {
	entity: EntityRecord;
	previousStatus: string;
};

export type UnlinkResult = {
	relation: RelationRecord;
	removed: boolean;
};

export type DeleteResult = {
	entity: EntityRecord;
	removed: boolean;
};

export type MoveResult = {
	entity: EntityRecord;
	previousParentId: string | null;
	newParentId: string;
	relationType: RelationType;
};
