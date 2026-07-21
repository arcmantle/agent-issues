import type { RelationRecord } from "../entity-store/domain.js";
import type { StorageDriver } from "../storage-driver/storage-driver.js";
import { mergeCanonicalChainBundles, type CanonicalChainBundle } from "./canonical-chain.js";

export type SynchronizeSummary = {
	entriesAppliedToLocal: number;
	entriesAppliedToCloud: number;
	entitiesCreatedLocal: string[];
	entitiesUpdatedLocal: string[];
	entitiesCreatedCloud: string[];
	entitiesUpdatedCloud: string[];
	concurrentEditConflicts: number;
	relationsAppliedToLocal: number;
	relationsAppliedToCloud: number;
	contextsAppliedToLocal: number;
	contextsAppliedToCloud: number;
	contextTermsAppliedToLocal: number;
	contextTermsAppliedToCloud: number;
};

function unionRelations(left: RelationRecord[], right: RelationRecord[]): RelationRecord[] {
	const byKey = new Map<string, RelationRecord>();
	for (const relation of [...left, ...right]) {
		byKey.set(`${relation.fromId}\u0000${relation.toId}\u0000${relation.type}`, relation);
	}
	return [...byKey.values()];
}

function countImportedDeltas(bundle: CanonicalChainBundle, recordIds: string[]): number {
	const imported = new Set(recordIds);
	return bundle.entities
		.filter((chain) => imported.has(chain.head.id))
		.reduce((count, chain) => count + chain.deltas.length, 0);
}

/**
 * Explicitly transfers one compatible canonical chain between local and cloud.
 * Compatibility is preflighted for every entity, context, and term before
 * either destination mutates. Each destination then compares and imports the
 * complete canonical bundle in one backend transaction. Divergent or stale
 * heads reject; no history union, timestamp resolution, overwrite, or merge is
 * attempted. Relations remain an idempotent key union after entity import.
 */
export async function synchronizeStores(local: StorageDriver, cloud: StorageDriver): Promise<SynchronizeSummary> {
	const [localBundle, cloudBundle, localRelations, cloudRelations] = await Promise.all([
		local.exportCanonicalChains(),
		cloud.exportCanonicalChains(),
		local.listAllRelations(),
		cloud.listAllRelations()
	]);
	const canonical = mergeCanonicalChainBundles(localBundle, cloudBundle);
	const [localImport, cloudImport] = await Promise.all([
		local.importCanonicalChains(canonical),
		cloud.importCanonicalChains(canonical)
	]);
	const relationUnion = unionRelations(localRelations, cloudRelations);
	const [localRelationImport, cloudRelationImport] = await Promise.all([
		local.applyRelations(relationUnion),
		cloud.applyRelations(relationUnion)
	]);
	const localEntityChanges = [...localImport.entitiesCreated, ...localImport.entitiesAdvanced];
	const cloudEntityChanges = [...cloudImport.entitiesCreated, ...cloudImport.entitiesAdvanced];

	return {
		entriesAppliedToLocal: countImportedDeltas(canonical, localEntityChanges),
		entriesAppliedToCloud: countImportedDeltas(canonical, cloudEntityChanges),
		entitiesCreatedLocal: localImport.entitiesCreated,
		entitiesUpdatedLocal: localImport.entitiesAdvanced,
		entitiesCreatedCloud: cloudImport.entitiesCreated,
		entitiesUpdatedCloud: cloudImport.entitiesAdvanced,
		concurrentEditConflicts: 0,
		relationsAppliedToLocal: localRelationImport.inserted,
		relationsAppliedToCloud: cloudRelationImport.inserted,
		contextsAppliedToLocal: localImport.contextsCreated.length + localImport.contextsAdvanced.length,
		contextsAppliedToCloud: cloudImport.contextsCreated.length + cloudImport.contextsAdvanced.length,
		contextTermsAppliedToLocal: localImport.contextTermsCreated.length + localImport.contextTermsAdvanced.length,
		contextTermsAppliedToCloud: cloudImport.contextTermsCreated.length + cloudImport.contextTermsAdvanced.length
	};
}
