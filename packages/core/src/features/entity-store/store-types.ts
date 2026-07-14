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

export type InitiativeBundle = {
	initiative: EntityRecord;
	prds: EntityRecord[];
	userStories: EntityRecord[];
	adrs: EntityRecord[];
	issues: EntityRecord[];
	fixLinks: Array<{ issue: EntityRecord; userStory: EntityRecord }>;
	subIssueLinks: Array<{ parent: EntityRecord; issue: EntityRecord }>;
	blockerLinks: Array<{ source: EntityRecord; target: EntityRecord }>;
	constrainsLinks: Array<{ adr: EntityRecord; issue: EntityRecord }>;
	handoffs: HandoffRecord[];
};

export type HandoffRecord = {
	id: string;
	entityId: string;
	initiativeId: string | null;
	summary: string;
	body: string;
	createdAt: string;
};

export type HandoffDetails = {
	focus: EntityDetails;
	structuralPath: Array<{ relationType: RelationType; entity: EntityRecord }>;
	initiative: InitiativeBundle | null;
	orphaned: boolean;
	activeBlockers: EntityRecord[];
	handoffs: HandoffRecord[];
};

export type HandoffDeleteResult = {
	handoff: HandoffRecord;
	removed: boolean;
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
