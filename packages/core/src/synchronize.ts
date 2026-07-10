import type { HistoryEntryRecord, RelationRecord } from "./domain.js";
import { mergeHistoryLogs } from "./history-merge.js";
import type { StorageDriver } from "./storage-driver.js";

export type SynchronizeSummary = {
	entriesAppliedToLocal: number;
	entriesAppliedToCloud: number;
	entitiesCreatedLocal: string[];
	entitiesUpdatedLocal: string[];
	entitiesCreatedCloud: string[];
	entitiesUpdatedCloud: string[];
	/** Entities whose history contains two entries tied at the winning version that genuinely disagree on facts - the concurrent-edit case last-writer-wins resolves (ADR16). Identical-content ties (e.g. independently-seeded sentinel history) are not counted. Reports every such entity known to the converged history, not just ones newly discovered by this run. */
	concurrentEditConflicts: number;
	/** Non-structural relations (e.g. "blocks", "fixes") newly inserted on each side (ISS60/ADR16). Structural relations aren't counted here - they're already reconstructed by applyResolvedFacts. */
	relationsAppliedToLocal: number;
	relationsAppliedToCloud: number;
};

// Relations have no append-only log of their own to merge against, so
// converging both sides is a plain union keyed by the table's own primary
// key (fromId, toId, type) rather than a version-aware resolve-latest.
function unionRelations(a: RelationRecord[], b: RelationRecord[]): RelationRecord[] {
	const byKey = new Map<string, RelationRecord>();

	for (const relation of [...a, ...b]) {
		const key = `${relation.fromId}\u0000${relation.toId}\u0000${relation.type}`;
		if (!byKey.has(key)) {
			byKey.set(key, relation);
		}
	}

	return [...byKey.values()];
}

// A tie at the winning version only counts as a genuine concurrent-edit
// conflict if the tied entries actually disagree on facts. Identical-content
// ties happen legitimately and don't indicate any real edit collision -
// most notably `ensureHistorySeed` (database.ts) independently seeding the
// same sentinel entity's version-1 history on both sides with identical
// facts but different entry ids, on every project's very first synchronize.
function countConcurrentEditConflicts(union: HistoryEntryRecord[], latestByEntity: Map<string, HistoryEntryRecord>): number {
	const tiedByEntity = new Map<string, HistoryEntryRecord[]>();

	for (const entry of union) {
		const winner = latestByEntity.get(entry.entityId);
		if (winner && entry.version === winner.version) {
			const tied = tiedByEntity.get(entry.entityId) ?? [];
			tied.push(entry);
			tiedByEntity.set(entry.entityId, tied);
		}
	}

	let conflicts = 0;
	for (const tied of tiedByEntity.values()) {
		if (tied.length < 2) {
			continue;
		}

		const distinctFacts = new Set(
			tied.map((entry) => JSON.stringify([entry.title, entry.body, entry.bodySource, entry.status, entry.parentId]))
		);
		if (distinctFacts.size > 1) {
			conflicts += 1;
		}
	}

	return conflicts;
}

/**
 * The explicit, user-invoked synchronize operation (ISS41/ADR15, ADR16):
 * merges `local` and `cloud`'s append-only history logs as an idempotent
 * union (`mergeHistoryLogs`, ISS58), applies whatever entries each side is
 * missing (`applyHistoryEntries`, ISS57), then converges both sides'
 * live-cache facts to the resolved-latest entry per entity
 * (`applyResolvedFacts`, ISS59), and finally converges non-structural
 * relations (`applyRelations`, ISS60) - which must run last, after every
 * entity a relation could reference already exists on both sides. Operates
 * on two already-open `StorageDriver`s - opening them (requiring a cloud
 * binding and a valid session) is `openSynchronizeStores`'s job, not this
 * function's, so this stays pure orchestration with no filesystem/auth
 * concerns of its own.
 */
export async function synchronizeStores(local: StorageDriver, cloud: StorageDriver): Promise<SynchronizeSummary> {
	const [localEntries, cloudEntries] = await Promise.all([local.listAllHistoryEntries(), cloud.listAllHistoryEntries()]);
	const { union, latestByEntity } = mergeHistoryLogs(localEntries, cloudEntries);
	const resolvedEntries = [...latestByEntity.values()];

	const [appliedToLocal, appliedToCloud] = await Promise.all([local.applyHistoryEntries(union), cloud.applyHistoryEntries(union)]);
	const [localFacts, cloudFacts] = await Promise.all([local.applyResolvedFacts(resolvedEntries), cloud.applyResolvedFacts(resolvedEntries)]);

	const [localRelations, cloudRelations] = await Promise.all([local.listAllRelations(), cloud.listAllRelations()]);
	const relationUnion = unionRelations(localRelations, cloudRelations);
	const [localRelationsApplied, cloudRelationsApplied] = await Promise.all([
		local.applyRelations(relationUnion),
		cloud.applyRelations(relationUnion)
	]);

	return {
		entriesAppliedToLocal: appliedToLocal.inserted,
		entriesAppliedToCloud: appliedToCloud.inserted,
		relationsAppliedToLocal: localRelationsApplied.inserted,
		relationsAppliedToCloud: cloudRelationsApplied.inserted,
		entitiesCreatedLocal: localFacts.created,
		entitiesUpdatedLocal: localFacts.updated,
		entitiesCreatedCloud: cloudFacts.created,
		entitiesUpdatedCloud: cloudFacts.updated,
		concurrentEditConflicts: countConcurrentEditConflicts(union, latestByEntity)
	};
}
