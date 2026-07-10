import type { ContextSyncRecord, ContextTermSyncRecord } from "./context-store.js";
import type { HistoryEntryRecord, RelationRecord } from "./domain.js";
import { mergeHistoryLogs } from "./history-merge.js";
import type { StorageDriver } from "./storage-driver.js";
import type { HandoffRecord } from "./store.js";

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
	/** Handoffs newly inserted on each side (ISS62/ADR16). Edits to an already-synced handoff don't propagate - see `listAllHandoffs`. */
	handoffsAppliedToLocal: number;
	handoffsAppliedToCloud: number;
	/** Contexts/terms upserted on each side via last-writer-wins by `updatedAt` (ISS62/ADR16). Counts every context/term applied, including no-op re-applies of a side's own already-current row. */
	contextsAppliedToLocal: number;
	contextsAppliedToCloud: number;
	contextTermsAppliedToLocal: number;
	contextTermsAppliedToCloud: number;
};

// Relations and handoffs have no append-only log of their own to merge
// against, so converging both sides is a plain union keyed by the table's
// own primary key rather than a version-aware resolve-latest.
function unionByKey<T>(a: T[], b: T[], keyOf: (item: T) => string): T[] {
	const byKey = new Map<string, T>();

	for (const item of [...a, ...b]) {
		const key = keyOf(item);
		if (!byKey.has(key)) {
			byKey.set(key, item);
		}
	}

	return [...byKey.values()];
}

function unionRelations(a: RelationRecord[], b: RelationRecord[]): RelationRecord[] {
	return unionByKey(a, b, (relation) => `${relation.fromId}\u0000${relation.toId}\u0000${relation.type}`);
}

function unionHandoffs(a: HandoffRecord[], b: HandoffRecord[]): HandoffRecord[] {
	return unionByKey(a, b, (handoff) => handoff.id);
}

// Unlike relations/handoffs, contexts and their terms are actively
// re-edited over their lifetime (title/summary/definitions), so a plain
// "first occurrence wins" union would stop propagating edits made after a
// context's first sync. Instead this keeps whichever side's row has the
// more recent `updatedAt` per key, so both sides converge on the latest
// edit regardless of which side made it.
function unionByLastWriter<T extends { updatedAt: string }>(a: T[], b: T[], keyOf: (item: T) => string): T[] {
	const byKey = new Map<string, T>();

	for (const item of [...a, ...b]) {
		const key = keyOf(item);
		const existing = byKey.get(key);
		if (!existing || item.updatedAt > existing.updatedAt) {
			byKey.set(key, item);
		}
	}

	return [...byKey.values()];
}

function unionContexts(a: ContextSyncRecord[], b: ContextSyncRecord[]): ContextSyncRecord[] {
	return unionByLastWriter(a, b, (context) => context.key);
}

function unionContextTerms(a: ContextTermSyncRecord[], b: ContextTermSyncRecord[]): ContextTermSyncRecord[] {
	return unionByLastWriter(a, b, (term) => `${term.contextKey}\u0000${term.term}`);
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
 * relations, handoffs, and contexts/terms (`applyRelations`/`applyHandoffs`/
 * `applyContexts`/`applyContextTerms`, ISS60/ISS62) - which must run last,
 * after every entity a relation/handoff/context could reference already
 * exists on both sides. Contexts are applied before their terms so each
 * term's `context_key` FK target already exists. Operates on two
 * already-open `StorageDriver`s - opening them (requiring a cloud binding
 * and a valid session) is `openSynchronizeStores`'s job, not this
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

	const [localHandoffs, cloudHandoffs] = await Promise.all([local.listAllHandoffs(), cloud.listAllHandoffs()]);
	const handoffUnion = unionHandoffs(localHandoffs, cloudHandoffs);
	const [localHandoffsApplied, cloudHandoffsApplied] = await Promise.all([
		local.applyHandoffs(handoffUnion),
		cloud.applyHandoffs(handoffUnion)
	]);

	const [localContexts, cloudContexts] = await Promise.all([local.listAllContexts(), cloud.listAllContexts()]);
	const contextUnion = unionContexts(localContexts, cloudContexts);
	const [localContextsApplied, cloudContextsApplied] = await Promise.all([
		local.applyContexts(contextUnion),
		cloud.applyContexts(contextUnion)
	]);

	const [localContextTerms, cloudContextTerms] = await Promise.all([local.listAllContextTerms(), cloud.listAllContextTerms()]);
	const contextTermUnion = unionContextTerms(localContextTerms, cloudContextTerms);
	const [localContextTermsApplied, cloudContextTermsApplied] = await Promise.all([
		local.applyContextTerms(contextTermUnion),
		cloud.applyContextTerms(contextTermUnion)
	]);

	return {
		entriesAppliedToLocal: appliedToLocal.inserted,
		entriesAppliedToCloud: appliedToCloud.inserted,
		relationsAppliedToLocal: localRelationsApplied.inserted,
		relationsAppliedToCloud: cloudRelationsApplied.inserted,
		handoffsAppliedToLocal: localHandoffsApplied.inserted,
		handoffsAppliedToCloud: cloudHandoffsApplied.inserted,
		contextsAppliedToLocal: localContextsApplied.applied,
		contextsAppliedToCloud: cloudContextsApplied.applied,
		contextTermsAppliedToLocal: localContextTermsApplied.applied,
		contextTermsAppliedToCloud: cloudContextTermsApplied.applied,
		entitiesCreatedLocal: localFacts.created,
		entitiesUpdatedLocal: localFacts.updated,
		entitiesCreatedCloud: cloudFacts.created,
		entitiesUpdatedCloud: cloudFacts.updated,
		concurrentEditConflicts: countConcurrentEditConflicts(union, latestByEntity)
	};
}
