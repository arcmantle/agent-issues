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
	{ fromKind: "issue", toKind: "userStory", type: "fixes" },
	{ fromKind: "adr", toKind: "issue", type: "constrains" },
	{ fromKind: "adr", toKind: "adr", type: "supersedes" },
	{ fromKind: "issue", toKind: "issue", type: "blocks" }
] as const;

export const STRUCTURAL_RELATION_TYPES = ["owns", "records", "tracks", "creates"] as const;

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

export function deriveEntityStatuses(entities: EntityRecord[], relations: RelationRecord[]): EntityRecord[] {
	const storedStatusById = new Map(entities.map((entity) => [entity.id, entity.status]));
	const kindById = new Map(entities.map((entity) => [entity.id, entity.kind]));

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

		if (relation.type === "fixes" && kindById.get(relation.fromId) === "issue" && kindById.get(relation.toId) === "userStory") {
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

	// Derive bottom-up: issues are leaves, then stories, then PRDs, then initiatives.
	const derivedStatusById = new Map(storedStatusById);
	const statusesOf = (ids: string[] | undefined) => (ids ?? []).map((id) => derivedStatusById.get(id) ?? "");

	for (const entity of entities) {
		if (entity.kind === "userStory") {
			derivedStatusById.set(entity.id, deriveUserStoryStatus(entity.status, statusesOf(fixingIssuesByStory.get(entity.id))));
		}
	}

	for (const entity of entities) {
		if (entity.kind === "prd") {
			derivedStatusById.set(entity.id, derivePrdStatus(entity.status, statusesOf(createdStoriesByPrd.get(entity.id))));
		}
	}

	for (const entity of entities) {
		if (entity.kind === "initiative") {
			derivedStatusById.set(
				entity.id,
				deriveInitiativeStatus(entity.status, statusesOf(trackedIssuesByInitiative.get(entity.id)), statusesOf(ownedPrdsByInitiative.get(entity.id)))
			);
		}
	}

	for (const entity of entities) {
		if (entity.kind === "adr") {
			derivedStatusById.set(
				entity.id,
				deriveAdrStatus(entity.status, statusesOf(constrainedIssuesByAdr.get(entity.id)), supersededAdrIds.has(entity.id))
			);
		}
	}

	return entities.map((entity) => {
		const derived = derivedStatusById.get(entity.id);
		return derived === undefined || derived === entity.status ? entity : { ...entity, status: derived };
	});
}