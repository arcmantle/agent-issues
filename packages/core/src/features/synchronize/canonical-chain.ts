import type { ContextRevisionPatch, ContextTermRevisionPatch } from "../context/context-types.js";
import { computeContextContentHash, computeContextTermContentHash } from "../context/context-types.js";
import type { BodySource, EntityKind, EntityRevisionPatch } from "../entity-store/domain.js";
import { computeEntityContentHash } from "../entity-store/domain.js";
import { materializeContextFromPatches, materializeContextTermFromPatches } from "../context/materialize-context-revision.js";
import { materializeFromPatches } from "../entity-store/materialize-revision.js";

export type CanonicalEntityDelta = EntityRevisionPatch & { id: string };
export type CanonicalContextDelta = ContextRevisionPatch & { id: string };
export type CanonicalContextTermDelta = ContextTermRevisionPatch & { id: string };

export type CanonicalEntityChain = {
	head: {
		id: string;
		kind: EntityKind;
		title: string;
		body: string;
		bodySource: BodySource;
		status: string;
		parentId: string | null;
		tombstone: boolean;
		revision: number;
		contentHash: string;
		createdAt: string;
		updatedAt: string;
	};
	deltas: CanonicalEntityDelta[];
};

export type CanonicalContextChain = {
	head: {
		key: string;
		scopeEntityId: string | null;
		title: string;
		summary: string;
		revision: number;
		contentHash: string;
		createdAt: string;
		updatedAt: string;
	};
	deltas: CanonicalContextDelta[];
};

export type CanonicalContextTermChain = {
	head: {
		contextKey: string;
		term: string;
		definition: string;
		avoid: string[];
		tombstone: boolean;
		revision: number;
		contentHash: string;
		createdAt: string;
		updatedAt: string;
	};
	deltas: CanonicalContextTermDelta[];
};

export type CanonicalChainBundle = {
	entities: CanonicalEntityChain[];
	contexts: CanonicalContextChain[];
	contextTerms: CanonicalContextTermChain[];
};

export type CanonicalChainImportResult = {
	entitiesCreated: string[];
	entitiesAdvanced: string[];
	contextsCreated: string[];
	contextsAdvanced: string[];
	contextTermsCreated: string[];
	contextTermsAdvanced: string[];
};

export type SynchronizeRecordKind = "entity" | "context" | "context-term";

export class SynchronizeConflictError extends Error {
	public constructor(recordKind: SynchronizeRecordKind, recordId: string, currentRevision: number, currentContentHash: string) {
		super(`Cannot synchronize divergent or stale ${recordKind} ${recordId}: current revision is ${currentRevision}.`);
		this.name = "SynchronizeConflictError";
		this.recordKind = recordKind;
		this.recordId = recordId;
		this.currentRevision = currentRevision;
		this.currentContentHash = currentContentHash;
	}

	public readonly recordKind: SynchronizeRecordKind;
	public readonly recordId: string;
	public readonly currentRevision: number;
	public readonly currentContentHash: string;
}

export function mergeCanonicalChainBundles(left: CanonicalChainBundle, right: CanonicalChainBundle): CanonicalChainBundle {
	return {
		entities: mergeChains(left.entities, right.entities, (chain) => chain.head.id, entityHeadsMatch, assertEntityExtension),
		contexts: mergeChains(left.contexts, right.contexts, (chain) => chain.head.key, contextHeadsMatch, assertContextExtension),
		contextTerms: mergeChains(left.contextTerms, right.contextTerms, (chain) => `${chain.head.contextKey}\u0000${chain.head.term}`, contextTermHeadsMatch, assertContextTermExtension)
	};
}

function mergeChains<Chain extends { head: { revision: number; contentHash: string } }>(
	left: Chain[],
	right: Chain[],
	keyOf: (chain: Chain) => string,
	headsMatch: (left: Chain, right: Chain) => boolean,
	assertExtension: (candidate: Chain, current: Chain) => void
): Chain[] {
	const merged = new Map(left.map((chain) => [keyOf(chain), chain]));
	for (const candidate of right) {
		const key = keyOf(candidate);
		const current = merged.get(key);
		if (!current) {
			merged.set(key, candidate);
			continue;
		}
		if (candidate.head.revision === current.head.revision && headsMatch(candidate, current)) {
			continue;
		}
		if (candidate.head.revision > current.head.revision) {
			assertExtension(candidate, current);
			merged.set(key, candidate);
			continue;
		}
		if (candidate.head.revision < current.head.revision) {
			assertExtension(current, candidate);
			continue;
		}
		throwConflict(current);
	}
	return [...merged.values()];
}

function entityHeadsMatch(left: CanonicalEntityChain, right: CanonicalEntityChain): boolean {
	return left.head.contentHash === right.head.contentHash && left.head.kind === right.head.kind && left.head.title === right.head.title && left.head.body === right.head.body && left.head.bodySource === right.head.bodySource && left.head.status === right.head.status && left.head.parentId === right.head.parentId && left.head.tombstone === right.head.tombstone;
}

function contextHeadsMatch(left: CanonicalContextChain, right: CanonicalContextChain): boolean {
	return left.head.contentHash === right.head.contentHash && left.head.scopeEntityId === right.head.scopeEntityId && left.head.title === right.head.title && left.head.summary === right.head.summary;
}

function contextTermHeadsMatch(left: CanonicalContextTermChain, right: CanonicalContextTermChain): boolean {
	return left.head.contentHash === right.head.contentHash && left.head.definition === right.head.definition && JSON.stringify(left.head.avoid) === JSON.stringify(right.head.avoid) && left.head.tombstone === right.head.tombstone;
}

function assertEntityExtension(candidate: CanonicalEntityChain, current: CanonicalEntityChain): void {
	const materialized = materializeFromPatches(candidate.head.id, candidate.head, candidate.deltas, current.head.revision);
	const expected = current.head;
	if (materialized.title !== expected.title || materialized.body !== expected.body || materialized.bodySource !== expected.bodySource || materialized.status !== expected.status || materialized.parentId !== expected.parentId || materialized.tombstone !== expected.tombstone || computeEntityContentHash(materialized.title, materialized.body) !== expected.contentHash) {
		throwConflict(current);
	}
}

function assertContextExtension(candidate: CanonicalContextChain, current: CanonicalContextChain): void {
	const materialized = materializeContextFromPatches(candidate.head, candidate.deltas, current.head.revision);
	if (materialized.title !== current.head.title || materialized.summary !== current.head.summary || candidate.head.scopeEntityId !== current.head.scopeEntityId || computeContextContentHash(materialized.title, materialized.summary) !== current.head.contentHash) {
		throwConflict(current);
	}
}

function assertContextTermExtension(candidate: CanonicalContextTermChain, current: CanonicalContextTermChain): void {
	const materialized = materializeContextTermFromPatches(candidate.head, candidate.deltas, current.head.revision);
	if (materialized.definition !== current.head.definition || JSON.stringify(materialized.avoid) !== JSON.stringify(current.head.avoid) || materialized.tombstone !== current.head.tombstone || computeContextTermContentHash(materialized.definition, materialized.avoid, materialized.tombstone) !== current.head.contentHash) {
		throwConflict(current);
	}
}

function throwConflict(chain: { head: { revision: number; contentHash: string; id?: string; key?: string; contextKey?: string; term?: string } }): never {
	const recordKind: SynchronizeRecordKind = "id" in chain.head ? "entity" : "term" in chain.head ? "context-term" : "context";
	const recordId = chain.head.id ?? (chain.head.term === undefined ? chain.head.key! : `${chain.head.contextKey}:${chain.head.term}`);
	throw new SynchronizeConflictError(recordKind, recordId, chain.head.revision, chain.head.contentHash);
}