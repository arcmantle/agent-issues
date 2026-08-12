import type {
	DeleteResult,
	DefineContextTermResult,
	EntityDetails,
	EntityKind,
	EntityRecord,
	InitiativeBundle,
	LinkResult,
	MaterializedContextRevision,
	MaterializedContextTermRevision,
	MaterializedEntityRevision,
	MoveResult,
	QueryEntityParentGroup,
	RelationType,
	StatusUpdateResult,
	ContextDetails,
	ForgetContextTermResult,
	UnlinkResult
} from "@agent-issues/core";

export type CompactEntity = {
	id: string;
	reference: string;
	kind: EntityKind;
	status: string;
	title: string;
};

export type CompactRelation = {
	type: RelationType;
	entity: CompactEntity;
};

export type CompactEntityDetails = {
	entity: CompactEntity;
	incoming: CompactRelation[];
	outgoing: CompactRelation[];
};

export type CompactEntityList = {
	items: CompactEntity[];
	total: number;
	parentGroups?: Array<{ parent: CompactEntity; items: CompactEntity[] }>;
	/** Only present for issue lists; see `QueryEntitiesResult.openBlockers`. */
	openBlockers?: Record<string, string[]>;
};

export type CompactInitiativeBundle = {
	initiative: CompactEntity;
	entities: CompactEntity[];
	prds: CompactEntity[];
	userStories: CompactEntity[];
	adrs: CompactEntity[];
	issues: CompactEntity[];
	fixLinks: Array<{ issue: CompactEntity; userStory: CompactEntity }>;
	subIssueLinks: Array<{ parent: CompactEntity; issue: CompactEntity }>;
	blockerLinks: Array<{ source: CompactEntity; target: CompactEntity }>;
	constrainsLinks: Array<{ adr: CompactEntity; issue: CompactEntity }>;
};

export type CompactCreateAcknowledgement = {
	operation: "create";
	reference: string;
	status: string;
	revision: number;
};

export type CompactEditAcknowledgement = {
	operation: "edit";
	reference: string;
	revision: number;
};

export function toCompactEntity(entity: EntityRecord): CompactEntity {
	return {
		id: entity.id,
		reference: entity.reference,
		kind: entity.kind,
		status: entity.status,
		title: entity.title
	};
}

export function toCompactCreateAcknowledgement(entity: EntityRecord): CompactCreateAcknowledgement {
	return {
		operation: "create",
		reference: entity.reference,
		status: entity.status,
		revision: entity.revision
	};
}

export function toCompactEditAcknowledgement(entity: EntityRecord): CompactEditAcknowledgement {
	return {
		operation: "edit",
		reference: entity.reference,
		revision: entity.revision
	};
}

export function toCompactStatusAcknowledgement(operation: "archive" | "status", result: StatusUpdateResult) {
	return {
		operation,
		reference: result.entity.reference,
		previousStatus: result.previousStatus,
		status: result.entity.status,
		revision: result.entity.revision
	};
}

export function toCompactDeleteAcknowledgement(result: DeleteResult) {
	return {
		operation: "delete" as const,
		reference: result.entity.reference,
		removed: result.removed
	};
}

export function toCompactMoveAcknowledgement(result: MoveResult) {
	return {
		operation: "move" as const,
		reference: result.entity.reference,
		previousParentId: result.previousParentId,
		newParentId: result.newParentId,
		type: result.relationType,
		revision: result.entity.revision
	};
}

export function toCompactLinkAcknowledgement(operation: "link" | "unlink", result: LinkResult | UnlinkResult) {
	return {
		operation,
		fromId: result.relation.fromId,
		toId: result.relation.toId,
		type: result.relation.type,
		...(operation === "link" ? { created: (result as LinkResult).created } : { removed: (result as UnlinkResult).removed })
	};
}

export function toCompactEntityRestoreAcknowledgement(result: MaterializedEntityRevision) {
	return {
		operation: "restore" as const,
		id: result.entityId,
		revision: result.headRevision,
		restoredFromRevision: result.restoredFromRevision
	};
}

export function toCompactContextSetAcknowledgement(result: ContextDetails) {
	return {
		operation: "context-set" as const,
		reference: result.context.reference ?? result.context.key,
		revision: result.context.revision
	};
}

export function toCompactContextDefineAcknowledgement(result: DefineContextTermResult) {
	return {
		operation: "context-define" as const,
		reference: result.term.reference,
		contextReference: result.context.reference ?? result.context.key,
		term: result.term.term,
		created: result.created,
		revision: result.term.revision
	};
}

export function toCompactContextForgetAcknowledgement(result: ForgetContextTermResult) {
	return {
		operation: "context-forget" as const,
		reference: result.context.reference ?? result.context.key,
		term: result.term,
		removed: result.removed,
		...(result.currentRevision === undefined ? {} : { revision: result.currentRevision })
	};
}

export function toCompactContextRestoreAcknowledgement(result: MaterializedContextRevision) {
	return {
		operation: "context-restore" as const,
		contextKey: result.contextKey,
		revision: result.headRevision,
		restoredFromRevision: result.restoredFromRevision
	};
}

export function toCompactContextTermRestoreAcknowledgement(result: MaterializedContextTermRevision) {
	return {
		operation: "context-term-restore" as const,
		id: result.id,
		contextKey: result.contextKey,
		term: result.term,
		revision: result.headRevision,
		restoredFromRevision: result.restoredFromRevision
	};
}

export function toCompactEntityDetails(details: EntityDetails): CompactEntityDetails {
	return {
		entity: toCompactEntity(details.entity),
		incoming: details.incoming.map(({ relationType, entity }) => ({
			type: relationType,
			entity: toCompactEntity(entity)
		})),
		outgoing: details.outgoing.map(({ relationType, entity }) => ({
			type: relationType,
			entity: toCompactEntity(entity)
		}))
	};
}

export function toCompactEntityList(
	entities: EntityRecord[],
	total = entities.length,
	openBlockers?: Record<string, string[]>,
	parentGroups?: QueryEntityParentGroup[]
): CompactEntityList {
	return {
		items: entities.map(toCompactEntity),
		total,
		...(parentGroups ? { parentGroups: parentGroups.map((group) => ({ parent: toCompactEntity(group.parent), items: group.entities.map(toCompactEntity) })) } : {}),
		...(openBlockers ? { openBlockers } : {})
	};
}

export function toCompactInitiativeBundle(bundle: InitiativeBundle): CompactInitiativeBundle {
	return {
		initiative: toCompactEntity(bundle.initiative),
		entities: bundle.entities.map(toCompactEntity),
		prds: bundle.prds.map(toCompactEntity),
		userStories: bundle.userStories.map(toCompactEntity),
		adrs: bundle.adrs.map(toCompactEntity),
		issues: bundle.issues.map(toCompactEntity),
		fixLinks: bundle.fixLinks.map(({ issue, userStory }) => ({ issue: toCompactEntity(issue), userStory: toCompactEntity(userStory) })),
		subIssueLinks: bundle.subIssueLinks.map(({ parent, issue }) => ({ parent: toCompactEntity(parent), issue: toCompactEntity(issue) })),
		blockerLinks: bundle.blockerLinks.map(({ source, target }) => ({ source: toCompactEntity(source), target: toCompactEntity(target) })),
		constrainsLinks: bundle.constrainsLinks.map(({ adr, issue }) => ({ adr: toCompactEntity(adr), issue: toCompactEntity(issue) }))
	};
}