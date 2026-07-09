import type { BodySource, HistoryEntryRecord } from "./domain.js";

// Facts derived from an entity's history that live on the entity's
// live-cache row (ADR8) - deliberately excludes `id`/`kind`/timestamps,
// which are stable identity/audit fields rather than merge-relevant
// content.
export type EntityFacts = {
	title: string;
	body: string;
	bodySource: BodySource;
	status: string;
	parentId: string | null;
};

export type MergeHistoryLogsResult = {
	/** Every history entry from both sides, deduplicated by `id` (ADR16 idempotent set union). No entry is ever dropped or mutated. */
	union: HistoryEntryRecord[];
	/** The winning "resolve latest" entry per entity, after last-writer-wins tie-break (ADR16). */
	latestByEntity: Map<string, HistoryEntryRecord>;
};

// The pure merge core of synchronize (ISS41/ADR16): combines two append-only
// history logs into one idempotent union keyed by the entry's own
// globally-unique `id`, then resolves each entity's current facts as the
// entry with the highest `version`, breaking a tie (the concurrent-edit
// case, where both sides independently produced their own next version)
// by newest `createdAt`. The losing entry in a tie is a normal union member,
// never discarded - only "resolve latest" ignores it.
export function mergeHistoryLogs(local: HistoryEntryRecord[], cloud: HistoryEntryRecord[]): MergeHistoryLogsResult {
	const unionById = new Map<string, HistoryEntryRecord>();
	for (const entry of [...local, ...cloud]) {
		unionById.set(entry.id, entry);
	}
	const union = [...unionById.values()];

	const latestByEntity = new Map<string, HistoryEntryRecord>();
	for (const entry of union) {
		const current = latestByEntity.get(entry.entityId);
		if (!current || isNewer(entry, current)) {
			latestByEntity.set(entry.entityId, entry);
		}
	}

	return { union, latestByEntity };
}

function isNewer(candidate: HistoryEntryRecord, current: HistoryEntryRecord): boolean {
	if (candidate.version !== current.version) {
		return candidate.version > current.version;
	}
	return candidate.createdAt > current.createdAt;
}

// Which entities' live-cache facts (title/body/bodySource/status/parentId)
// differ from the merge's resolved-latest entry - i.e. which entities this
// side must actually write after synchronize. An entity absent from
// `currentFactsByEntity` (new to this side) always needs an update. Diffing
// against a caller-supplied "current facts" snapshot (rather than comparing
// logs directly) is what makes a repeated synchronize with no intervening
// writes report zero updates: both sides' current facts already match the
// resolved latest.
export function entitiesNeedingLiveCacheUpdate(
	latestByEntity: Map<string, HistoryEntryRecord>,
	currentFactsByEntity: Map<string, EntityFacts>
): string[] {
	const needingUpdate: string[] = [];

	for (const [entityId, latest] of latestByEntity) {
		const current = currentFactsByEntity.get(entityId);
		if (!current || !factsMatch(latest, current)) {
			needingUpdate.push(entityId);
		}
	}

	return needingUpdate;
}

function factsMatch(entry: HistoryEntryRecord, facts: EntityFacts): boolean {
	return (
		entry.title === facts.title &&
		entry.body === facts.body &&
		entry.bodySource === facts.bodySource &&
		entry.status === facts.status &&
		entry.parentId === facts.parentId
	);
}
