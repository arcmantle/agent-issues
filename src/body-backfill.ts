import type { DatabaseHandle } from "./database.js";
import type { EntityRecord, RelationRecord } from "./domain.js";
import { getDatabaseSnapshot, setEntityBody } from "./store.js";

export const BACKFILLABLE_BODY_KINDS = ["initiative", "issue", "prd", "userStory", "adr"] as const;

export type BackfillableBodyKind = (typeof BACKFILLABLE_BODY_KINDS)[number];

export type BackfillBodiesKindResult = {
	kind: BackfillableBodyKind;
	considered: number;
	updated: number;
	skipped: number;
};

export type BackfillBodiesResult = {
	tenantId: string;
	dryRun: boolean;
	force: boolean;
	kinds: BackfillableBodyKind[];
	considered: number;
	updated: number;
	skipped: number;
	byKind: BackfillBodiesKindResult[];
};

type SnapshotIndexes = {
	entityById: Map<string, EntityRecord>;
	incomingRelations: Map<string, RelationRecord[]>;
	outgoingRelations: Map<string, RelationRecord[]>;
};

export function isBackfillableBodyKind(value: string): value is BackfillableBodyKind {
	return BACKFILLABLE_BODY_KINDS.includes(value as BackfillableBodyKind);
}

export function parseBackfillableBodyKinds(values: string[]): BackfillableBodyKind[] {
	if (values.length === 0) {
		return [...BACKFILLABLE_BODY_KINDS];
	}

	const kinds: BackfillableBodyKind[] = [];
	const invalid: string[] = [];

	for (const value of values) {
		if (!isBackfillableBodyKind(value)) {
			invalid.push(value);
			continue;
		}

		if (!kinds.includes(value)) {
			kinds.push(value);
		}
	}

	if (invalid.length > 0) {
		throw new Error(
			`Unsupported backfill kinds: ${invalid.join(", ")}. Supported kinds: ${BACKFILLABLE_BODY_KINDS.join(", ")}.`
		);
	}

	return kinds;
}

export function backfillBodies(
	db: DatabaseHandle,
	input: { dryRun?: boolean; force?: boolean; kinds?: BackfillableBodyKind[] } = {}
): BackfillBodiesResult {
	const snapshot = getDatabaseSnapshot(db);
	const indexes = buildSnapshotIndexes(snapshot.entities, snapshot.relations);
	const kinds = input.kinds ?? [...BACKFILLABLE_BODY_KINDS];
	const byKind: BackfillBodiesKindResult[] = [];

	for (const kind of kinds) {
		const entities = sortEntities(snapshot.entities.filter((entity) => entity.kind === kind));
		let updated = 0;
		let skipped = 0;

		for (const entity of entities) {
			const body = buildBody(kind, entity, indexes);
			if (body.trim().length === 0) {
				skipped += 1;
				continue;
			}

			const hasStoredBody = entity.body.trim().length > 0;
			const matchesGeneratedBody = hasStoredBody && entity.body === body;

			if (!input.force && hasStoredBody && !matchesGeneratedBody) {
				skipped += 1;
				continue;
			}

			if (!input.force && matchesGeneratedBody && entity.bodySource === "generated") {
				skipped += 1;
				continue;
			}

			if (!input.dryRun) {
				setEntityBody(db, { entityId: entity.id, body, bodySource: "generated" });
			}
			updated += 1;
		}

		byKind.push({
			kind,
			considered: entities.length,
			updated,
			skipped
		});
	}

	return {
		tenantId: db.tenantId,
		dryRun: input.dryRun ?? false,
		force: input.force ?? false,
		kinds,
		considered: byKind.reduce((sum, item) => sum + item.considered, 0),
		updated: byKind.reduce((sum, item) => sum + item.updated, 0),
		skipped: byKind.reduce((sum, item) => sum + item.skipped, 0),
		byKind
	};
}

function buildSnapshotIndexes(entities: EntityRecord[], relations: RelationRecord[]): SnapshotIndexes {
	const entityById = new Map(entities.map((entity) => [entity.id, entity]));
	const incomingRelations = new Map<string, RelationRecord[]>();
	const outgoingRelations = new Map<string, RelationRecord[]>();

	for (const relation of relations) {
		const incoming = incomingRelations.get(relation.toId) ?? [];
		incoming.push(relation);
		incomingRelations.set(relation.toId, incoming);

		const outgoing = outgoingRelations.get(relation.fromId) ?? [];
		outgoing.push(relation);
		outgoingRelations.set(relation.fromId, outgoing);
	}

	return { entityById, incomingRelations, outgoingRelations };
}

function buildBody(kind: BackfillableBodyKind, entity: EntityRecord, indexes: SnapshotIndexes): string {
	switch (kind) {
		case "initiative":
			return buildInitiativeBody(entity, indexes);
		case "issue":
			return buildIssueBody(entity, indexes);
		case "prd":
			return buildPrdBody(entity, indexes);
		case "userStory":
			return buildUserStoryBody(entity, indexes);
		case "adr":
			return buildAdrBody(entity, indexes);
	}
}

function buildInitiativeBody(initiative: EntityRecord, indexes: SnapshotIndexes): string {
	const prds = collectOutgoingEntities(indexes, initiative.id, "owns");
	const adrs = collectOutgoingEntities(indexes, initiative.id, "records");
	const trackedIssues = collectOutgoingEntities(indexes, initiative.id, "tracks");
	const stories = uniqueSortedEntities(prds.flatMap((prd) => collectOutgoingEntities(indexes, prd.id, "creates")));
	const doneStories = stories.filter((story) => story.status === "done").length;
	const doneIssues = trackedIssues.filter((issue) => issue.status === "done").length;

	return [
		withTerminalPunctuation(initiative.title),
		"",
		"## Scope",
		"",
		`- Initiative status: ${initiative.status}`,
		`- PRDs linked: ${prds.length}`,
		`- User stories linked through PRDs: ${stories.length}`,
		`- Tracked issues: ${trackedIssues.length}`,
		`- ADRs recorded: ${adrs.length}`,
		"",
		"## Delivery Status",
		"",
		`- Done user stories: ${doneStories}`,
		`- Done issues: ${doneIssues}`,
		stories.length > 0
			? `- Remaining user stories: ${stories.length - doneStories}`
			: "- Remaining user stories: no user stories are linked yet.",
		trackedIssues.length > 0
			? `- Remaining issues: ${trackedIssues.length - doneIssues}`
			: "- Remaining issues: no tracked issues are linked yet.",
		"",
		"## Product Commitments",
		"",
		...toBullets(prds, "No PRDs are linked yet."),
		"",
		"## User Stories",
		"",
		...toBullets(stories, "No user stories are linked yet through initiative PRDs."),
		"",
		"## Implementation Slices",
		"",
		...toBullets(trackedIssues, "No tracked issues are linked yet."),
		"",
		"## Decision Records",
		"",
		...toBullets(adrs, "No ADRs are recorded yet."),
		"",
		"## Further Notes",
		"",
		"- Backfilled from tracker metadata because no authored initiative body was present."
	].join("\n");
}

function buildIssueBody(issue: EntityRecord, indexes: SnapshotIndexes): string {
	const initiative = findParent(indexes, issue.id, "tracks", "initiative");
	const fixedStories = collectOutgoingEntities(indexes, issue.id, "fixes");
	const blockedBy = collectIncomingEntities(indexes, issue.id, "blocks");
	const blocks = collectOutgoingEntities(indexes, issue.id, "blocks");
	const constrainedBy = collectIncomingEntities(indexes, issue.id, "constrains");

	return [
		withTerminalPunctuation(issue.title),
		"",
		"## Context",
		"",
		initiative
			? `- Initiative: ${initiative.id} ${initiative.title}`
			: "- Initiative: none linked in the tracker.",
		`- Current status: ${issue.status}`,
		`- Fixes user stories: ${fixedStories.length}`,
		`- Blocked by issues: ${blockedBy.length}`,
		`- Blocks issues: ${blocks.length}`,
		`- Constraining ADRs: ${constrainedBy.length}`,
		"",
		"## User Stories",
		"",
		...toBullets(fixedStories, "No user stories are linked yet. Add issue slices that satisfy a story end to end."),
		"",
		"## Dependencies",
		"",
		...buildIssueDependencyBullets(blockedBy, blocks, constrainedBy),
		"",
		"## Further Notes",
		"",
		"- Backfilled from tracker metadata because no authored issue body was present."
	].join("\n");
}

function buildPrdBody(prd: EntityRecord, indexes: SnapshotIndexes): string {
	const initiative = findParent(indexes, prd.id, "owns", "initiative");
	const stories = collectOutgoingEntities(indexes, prd.id, "creates");
	const fixingIssues = uniqueSortedEntities(
		stories.flatMap((story) => collectIncomingEntities(indexes, story.id, "fixes"))
	);
	const normalizedTitle = prd.title.replace(/\s+PRD$/i, "");
	const doneStories = stories.filter((story) => story.status === "done").length;

	return [
		initiative
			? `This PRD captures the tracked product commitments for ${normalizedTitle} within ${initiative.title}.`
			: `This PRD captures the tracked product commitments for ${normalizedTitle}.`,
		"",
		"## Problem Statement",
		"",
		initiative
			? `Deliver the ${normalizedTitle} work for ${initiative.title} through the committed user stories and linked implementation slices already present in the tracker.`
			: `Deliver the ${normalizedTitle} work through the committed user stories and linked implementation slices already present in the tracker.`,
		"",
		"## User Stories",
		"",
		...buildPrdStoryLines(stories),
		"",
		"## Delivery Status",
		"",
		initiative
			? `- Initiative: ${initiative.id} ${initiative.title}`
			: "- Initiative: none linked in the tracker.",
		`- PRD status: ${prd.status}`,
		`- Child user stories: ${stories.length}`,
		`- Done user stories: ${doneStories}`,
		`- Linked issues across the PRD: ${fixingIssues.length}`,
		"",
		"## Implementation Slices",
		"",
		...toBullets(fixingIssues, "No issues are linked to this PRD yet through its child stories."),
		"",
		"## Further Notes",
		"",
		"- Backfilled from tracker metadata because no authored PRD body was present."
	].join("\n");
}

function buildUserStoryBody(story: EntityRecord, indexes: SnapshotIndexes): string {
	const prd = findParent(indexes, story.id, "creates", "prd");
	const initiative = prd ? findParent(indexes, prd.id, "owns", "initiative") : null;
	const fixingIssues = collectIncomingEntities(indexes, story.id, "fixes");

	return [
		withTerminalPunctuation(story.title),
		"",
		"## Context",
		"",
		initiative
			? `- Initiative: ${initiative.id} ${initiative.title}`
			: "- Initiative: none linked in the tracker.",
		prd ? `- PRD: ${prd.id} ${prd.title}` : "- PRD: none linked in the tracker.",
		`- Current status: ${story.status}`,
		`- Fixing issues linked: ${fixingIssues.length}`,
		"",
		"## Delivery Slices",
		"",
		...toBullets(fixingIssues, "No fixing issues are linked yet. Add issue slices that satisfy this story end to end."),
		"",
		"## Completion Notes",
		"",
		"- This story is satisfied when the linked issues deliver the behavior described above and the story status can derive from that connected work.",
		"- Backfilled from tracker metadata because no authored story body was present."
	].join("\n");
}

function buildAdrBody(adr: EntityRecord, indexes: SnapshotIndexes): string {
	const initiative = findParent(indexes, adr.id, "records", "initiative");
	const constrainedIssues = collectOutgoingEntities(indexes, adr.id, "constrains");
	const supersedes = collectOutgoingEntities(indexes, adr.id, "supersedes");
	const supersededBy = collectIncomingEntities(indexes, adr.id, "supersedes");

	return [
		initiative
			? `This ADR records the tracked architecture decision for ${adr.title} within ${initiative.title}.`
			: `This ADR records the tracked architecture decision for ${adr.title}.`,
		"",
		"## Context",
		"",
		initiative
			? `- Initiative: ${initiative.id} ${initiative.title}`
			: "- Initiative: none linked in the tracker.",
		`- ADR status: ${adr.status}`,
		`- Constrained issues: ${constrainedIssues.length}`,
		`- Supersedes ADRs: ${supersedes.length}`,
		`- Superseded by ADRs: ${supersededBy.length}`,
		"",
		"## Governed Work",
		"",
		...toBullets(constrainedIssues, "No constrained issues are linked yet."),
		"",
		"## Decision Lineage",
		"",
		...buildAdrLineageBullets(supersedes, supersededBy),
		"",
		"## Further Notes",
		"",
		"- Backfilled from tracker metadata because no authored ADR body was present."
	].join("\n");
}

function buildIssueDependencyBullets(
	blockedBy: EntityRecord[],
	blocks: EntityRecord[],
	constrainedBy: EntityRecord[]
): string[] {
	const lines: string[] = [];

	lines.push(...blockedBy.map((entity) => `- Blocked by ${entity.id} (${entity.status}): ${entity.title}`));
	lines.push(...blocks.map((entity) => `- Blocks ${entity.id} (${entity.status}): ${entity.title}`));
	lines.push(...constrainedBy.map((entity) => `- Governed by ${entity.id} (${entity.status}): ${entity.title}`));

	if (lines.length === 0) {
		return ["- No blocking or constraining records are linked yet."];
	}

	return lines;
}

function buildAdrLineageBullets(supersedes: EntityRecord[], supersededBy: EntityRecord[]): string[] {
	const lines: string[] = [];

	lines.push(...supersedes.map((entity) => `- Supersedes ${entity.id} (${entity.status}): ${entity.title}`));
	lines.push(...supersededBy.map((entity) => `- Superseded by ${entity.id} (${entity.status}): ${entity.title}`));

	if (lines.length === 0) {
		return ["- No supersession links are recorded yet."];
	}

	return lines;
}

function buildPrdStoryLines(stories: EntityRecord[]): string[] {
	if (stories.length === 0) {
		return ["1. No user stories are linked to this PRD yet."];
	}

	return stories.map((story, index) => `${index + 1}. ${story.id} (${story.status}) ${story.title}`);
}

function toBullets(entities: EntityRecord[], emptyLine: string): string[] {
	if (entities.length === 0) {
		return [`- ${emptyLine}`];
	}

	return entities.map((entity) => `- ${entity.id} (${entity.status}): ${entity.title}`);
}

function collectIncomingEntities(indexes: SnapshotIndexes, entityId: string, relationType: RelationRecord["type"]): EntityRecord[] {
	return uniqueSortedEntities(
		(indexes.incomingRelations.get(entityId) ?? [])
			.filter((relation) => relation.type === relationType)
			.map((relation) => indexes.entityById.get(relation.fromId))
	);
}

function collectOutgoingEntities(indexes: SnapshotIndexes, entityId: string, relationType: RelationRecord["type"]): EntityRecord[] {
	return uniqueSortedEntities(
		(indexes.outgoingRelations.get(entityId) ?? [])
			.filter((relation) => relation.type === relationType)
			.map((relation) => indexes.entityById.get(relation.toId))
	);
}

function findParent(indexes: SnapshotIndexes, entityId: string, relationType: RelationRecord["type"], kind: string): EntityRecord | null {
	for (const relation of indexes.incomingRelations.get(entityId) ?? []) {
		if (relation.type !== relationType) {
			continue;
		}

		const entity = indexes.entityById.get(relation.fromId);
		if (entity?.kind === kind) {
			return entity;
		}
	}

	return null;
}

function uniqueSortedEntities(entities: Array<EntityRecord | undefined>): EntityRecord[] {
	const map = new Map<string, EntityRecord>();
	for (const entity of entities) {
		if (!entity) {
			continue;
		}

		map.set(entity.id, entity);
	}

	return sortEntities([...map.values()]);
}

function sortEntities<T extends EntityRecord>(entities: T[]): T[] {
	return [...entities].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

function withTerminalPunctuation(text: string): string {
	return /[.!?]$/.test(text) ? text : `${text}.`;
}