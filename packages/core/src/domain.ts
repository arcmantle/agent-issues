export const ENTITY_KINDS = ["initiative", "prd", "userStory", "adr", "issue"] as const;

export const BODY_SOURCES = ["authored", "generated"] as const;

export const STATUS_FLOW = {
	initiative: ["draft", "active", "paused", "done"],
	prd: ["draft", "in-progress", "approved"],
	userStory: ["draft", "ready", "in-progress", "done"],
	adr: ["proposed", "accepted", "superseded"],
	issue: ["todo", "in-progress", "blocked", "done"]
} as const;

export const ID_PREFIX = {
	initiative: "INIT",
	prd: "PRD",
	userStory: "US",
	adr: "ADR",
	issue: "ISS"
} as const;

export const ALLOWED_RELATIONS = [
	{ fromKind: "initiative", toKind: "prd", type: "owns" },
	{ fromKind: "initiative", toKind: "adr", type: "records" },
	{ fromKind: "initiative", toKind: "issue", type: "tracks" },
	{ fromKind: "prd", toKind: "userStory", type: "creates" },
	{ fromKind: "issue", toKind: "issue", type: "decomposes" },
	{ fromKind: "issue", toKind: "userStory", type: "fixes" },
	{ fromKind: "adr", toKind: "issue", type: "constrains" },
	{ fromKind: "adr", toKind: "adr", type: "supersedes" },
	{ fromKind: "issue", toKind: "issue", type: "blocks" }
] as const;

export const STRUCTURAL_RELATION_TYPES = ["owns", "records", "tracks", "creates", "decomposes"] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];
export type BodySource = (typeof BODY_SOURCES)[number];
export type EntityStatus<K extends EntityKind = EntityKind> = (typeof STATUS_FLOW)[K][number];
export type RelationType = (typeof ALLOWED_RELATIONS)[number]["type"];
export type StructuralRelationType = (typeof STRUCTURAL_RELATION_TYPES)[number];

export type EntityRecord = {
	id: string;
	kind: EntityKind;
	title: string;
	status: string;
	body: string;
	bodySource: BodySource;
	createdAt: string;
	updatedAt: string;
};

export type RelationRecord = {
	fromId: string;
	toId: string;
	type: RelationType;
	createdAt: string;
};

export function isEntityKind(value: string): value is EntityKind {
	return ENTITY_KINDS.includes(value as EntityKind);
}

export function isBodySource(value: string): value is BodySource {
	return BODY_SOURCES.includes(value as BodySource);
}

export function getInitialStatus(kind: EntityKind): EntityStatus {
	return STATUS_FLOW[kind][0];
}

export function isValidStatus(kind: EntityKind, status: string): boolean {
	return (STATUS_FLOW[kind] as readonly string[]).includes(status);
}

export function getAllowedRelationType(fromKind: EntityKind, toKind: EntityKind): RelationType | null {
	const match = ALLOWED_RELATIONS.find((relation) => relation.fromKind === fromKind && relation.toKind === toKind);
	return match?.type ?? null;
}

export function isAllowedRelation(fromKind: EntityKind, toKind: EntityKind, relationType: string): relationType is RelationType {
	return ALLOWED_RELATIONS.some(
		(relation) =>
			relation.fromKind === fromKind && relation.toKind === toKind && relation.type === relationType
	);
}

export function isStructuralRelationType(relationType: string): relationType is StructuralRelationType {
	return STRUCTURAL_RELATION_TYPES.includes(relationType as StructuralRelationType);
}

export function getArchiveStatus(kind: EntityKind): EntityStatus {
	switch (kind) {
		case "initiative":
			return "done";
		case "prd":
			return "approved";
		case "userStory":
			return "done";
		case "adr":
			return "superseded";
		case "issue":
			return "done";
	}
}

export function deriveUserStoryStatus(storedStatus: string, fixingIssueStatuses: string[]): string {
	if (fixingIssueStatuses.length === 0) {
		return storedStatus;
	}

	if (fixingIssueStatuses.every((status) => status === "done")) {
		return "done";
	}

	if (fixingIssueStatuses.some((status) => status === "in-progress" || status === "blocked" || status === "done")) {
		return "in-progress";
	}

	return "ready";
}

export function isInitiativeComplete(trackedIssueStatuses: string[], ownedPrdStatuses: string[]): boolean {
	if (trackedIssueStatuses.length === 0) {
		return false;
	}

	return (
		trackedIssueStatuses.every((status) => status === "done") &&
		ownedPrdStatuses.every((status) => status === "approved")
	);
}

export function deriveInitiativeStatus(storedStatus: string, trackedIssueStatuses: string[], ownedPrdStatuses: string[]): string {
	return isInitiativeComplete(trackedIssueStatuses, ownedPrdStatuses) ? "done" : storedStatus;
}

export function isPrdComplete(createdStoryStatuses: string[]): boolean {
	return createdStoryStatuses.length > 0 && createdStoryStatuses.every((status) => status === "done");
}

export function derivePrdStatus(storedStatus: string, createdStoryStatuses: string[]): string {
	if (createdStoryStatuses.length === 0) {
		return storedStatus;
	}

	if (createdStoryStatuses.every((status) => status === "done")) {
		return "approved";
	}

	if (createdStoryStatuses.some((status) => status === "in-progress" || status === "done")) {
		return "in-progress";
	}

	return storedStatus;
}

export function deriveAdrStatus(storedStatus: string, constrainedIssueStatuses: string[], isSuperseded: boolean): string {
	if (isSuperseded) {
		return "superseded";
	}

	if (constrainedIssueStatuses.length === 0) {
		return storedStatus;
	}

	if (constrainedIssueStatuses.some((status) => status === "in-progress" || status === "blocked" || status === "done")) {
		return "accepted";
	}

	return storedStatus;
}

export function deriveIssueStatus(storedStatus: string, subIssueStatuses: string[]): string {
	if (subIssueStatuses.length === 0) {
		return storedStatus;
	}

	if (subIssueStatuses.some((status) => status !== "done")) {
		return "blocked";
	}

	return storedStatus === "blocked" ? "todo" : storedStatus;
}

export function deriveEntityStatuses(entities: EntityRecord[], relations: RelationRecord[]): EntityRecord[] {
	const storedStatusById = new Map(entities.map((entity) => [entity.id, entity.status]));
	const entityById = new Map(entities.map((entity) => [entity.id, entity]));
	const kindById = new Map(entities.map((entity) => [entity.id, entity.kind]));

	const decomposedSubIssuesByIssue = new Map<string, string[]>();
	const fixingIssuesByStory = new Map<string, string[]>();
	const createdStoriesByPrd = new Map<string, string[]>();
	const trackedIssuesByInitiative = new Map<string, string[]>();
	const ownedPrdsByInitiative = new Map<string, string[]>();
	const constrainedIssuesByAdr = new Map<string, string[]>();
	const supersededAdrIds = new Set<string>();

	const pushTo = (map: Map<string, string[]>, key: string, value: string) => {
		const list = map.get(key);
		if (list) {
			list.push(value);
		} else {
			map.set(key, [value]);
		}
	};

	for (const relation of relations) {
		if (!kindById.has(relation.fromId) || !kindById.has(relation.toId)) {
			continue;
		}

		if (relation.type === "decomposes" && kindById.get(relation.fromId) === "issue" && kindById.get(relation.toId) === "issue") {
			pushTo(decomposedSubIssuesByIssue, relation.fromId, relation.toId);
		} else if (relation.type === "fixes" && kindById.get(relation.fromId) === "issue" && kindById.get(relation.toId) === "userStory") {
			pushTo(fixingIssuesByStory, relation.toId, relation.fromId);
		} else if (relation.type === "creates" && kindById.get(relation.toId) === "userStory") {
			pushTo(createdStoriesByPrd, relation.fromId, relation.toId);
		} else if (relation.type === "tracks" && kindById.get(relation.toId) === "issue") {
			pushTo(trackedIssuesByInitiative, relation.fromId, relation.toId);
		} else if (relation.type === "owns" && kindById.get(relation.toId) === "prd") {
			pushTo(ownedPrdsByInitiative, relation.fromId, relation.toId);
		} else if (relation.type === "constrains" && kindById.get(relation.fromId) === "adr" && kindById.get(relation.toId) === "issue") {
			pushTo(constrainedIssuesByAdr, relation.fromId, relation.toId);
		} else if (relation.type === "supersedes" && kindById.get(relation.fromId) === "adr" && kindById.get(relation.toId) === "adr") {
			supersededAdrIds.add(relation.toId);
		}
	}

	const derivedStatusById = new Map<string, string>();
	const deriveStatusFor = (entityId: string): string => {
		const cached = derivedStatusById.get(entityId);
		if (cached !== undefined) {
			return cached;
		}

		const entity = entityById.get(entityId);
		if (!entity) {
			return storedStatusById.get(entityId) ?? "";
		}

		const statusesOf = (ids: string[] | undefined) => (ids ?? []).map((id) => deriveStatusFor(id));
		let derivedStatus = entity.status;

		if (entity.kind === "issue") {
			derivedStatus = deriveIssueStatus(entity.status, statusesOf(decomposedSubIssuesByIssue.get(entity.id)));
		} else if (entity.kind === "userStory") {
			derivedStatus = deriveUserStoryStatus(entity.status, statusesOf(fixingIssuesByStory.get(entity.id)));
		} else if (entity.kind === "prd") {
			derivedStatus = derivePrdStatus(entity.status, statusesOf(createdStoriesByPrd.get(entity.id)));
		} else if (entity.kind === "initiative") {
			derivedStatus = deriveInitiativeStatus(
				entity.status,
				statusesOf(trackedIssuesByInitiative.get(entity.id)),
				statusesOf(ownedPrdsByInitiative.get(entity.id))
			);
		} else if (entity.kind === "adr") {
			derivedStatus = deriveAdrStatus(
				entity.status,
				statusesOf(constrainedIssuesByAdr.get(entity.id)),
				supersededAdrIds.has(entity.id)
			);
		}

		derivedStatusById.set(entityId, derivedStatus);
		return derivedStatus;
	};

	for (const entity of entities) {
		deriveStatusFor(entity.id);
	}

	return entities.map((entity) => {
		const derived = derivedStatusById.get(entity.id);
		return derived === undefined || derived === entity.status ? entity : { ...entity, status: derived };
	});
}