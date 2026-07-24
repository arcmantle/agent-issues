import type { ContextRevisionPatch, ContextTermRevisionPatch } from "../context/context-types.js";
import { computeContextContentHash, computeContextTermContentHash } from "../context/context-types.js";
import type { BodySource, EntityKind, EntityRevisionPatch } from "../entity-store/domain.js";
import { computeEntityContentHash } from "../entity-store/domain.js";
import { materializeContextFromPatches, materializeContextTermFromPatches } from "../context/materialize-context-revision.js";
import { decodeCanonicalReference } from "../entity-store/canonical-reference.js";
import { materializeFromPatches } from "../entity-store/materialize-revision.js";

export type CanonicalEntityDelta = EntityRevisionPatch & { id: string };
export type CanonicalContextDelta = ContextRevisionPatch & { id: string };
export type CanonicalContextTermDelta = ContextTermRevisionPatch & { id: string };

export type CanonicalEntityChain = {
	head: {
		id: string;
		reference: string;
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
		id: string;
		reference: string;
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
		id: string;
		reference: string;
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

export type CanonicalChainWireBundle = Omit<CanonicalChainBundle, "entities" | "contexts" | "contextTerms"> & {
	entities: Array<Omit<CanonicalEntityChain, "deltas"> & { deltas: Array<Omit<CanonicalEntityDelta, "reversePatch"> & { reversePatch: string }> }>;
	contexts: Array<Omit<CanonicalContextChain, "deltas"> & { deltas: Array<Omit<CanonicalContextDelta, "reversePatch"> & { reversePatch: string }> }>;
	contextTerms: Array<Omit<CanonicalContextTermChain, "deltas"> & { deltas: Array<Omit<CanonicalContextTermDelta, "reversePatch"> & { reversePatch: string }> }>;
};

export function encodeCanonicalChainBundle(bundle: CanonicalChainBundle): CanonicalChainWireBundle {
	return mapCanonicalChainBundle(bundle, (reversePatch) => Buffer.from(reversePatch).toString("base64"));
}

export function decodeCanonicalChainBundle(bundle: CanonicalChainWireBundle): CanonicalChainBundle {
	const decoded = mapCanonicalChainBundle(bundle, (reversePatch) => Uint8Array.from(Buffer.from(reversePatch, "base64"))) as CanonicalChainBundle;
	assertCanonicalBundle(decoded);
	return decoded;
}

function mapCanonicalChainBundle<Input extends CanonicalChainBundle | CanonicalChainWireBundle, Output>(
	bundle: Input,
	mapPatch: (reversePatch: Input["entities"][number]["deltas"][number]["reversePatch"]) => Output
) {
	const mapChain = <Chain extends { deltas: Array<{ reversePatch: Input["entities"][number]["deltas"][number]["reversePatch"] }> }>(chain: Chain) => ({
		...chain,
		deltas: chain.deltas.map((delta) => ({ ...delta, reversePatch: mapPatch(delta.reversePatch) }))
	});
	return {
		entities: bundle.entities.map((chain) => mapChain(chain as never)),
		contexts: bundle.contexts.map((chain) => mapChain(chain as never)),
		contextTerms: bundle.contextTerms.map((chain) => mapChain(chain as never))
	};
}

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
	assertBundleReferenceCollisions(left, right);
	assertCanonicalBundle(left);
	assertCanonicalBundle(right);
	return {
		entities: mergeChains(left.entities, right.entities, (chain) => chain.head.id, entityHeadsMatch, assertEntityExtension),
		contexts: mergeChains(left.contexts, right.contexts, (chain) => chain.head.id, contextHeadsMatch, assertContextExtension),
		contextTerms: mergeChains(left.contextTerms, right.contextTerms, (chain) => chain.head.id, contextTermHeadsMatch, assertContextTermExtension)
	};
}

function assertCanonicalBundle(bundle: CanonicalChainBundle): void {
	const entityIds = new Set(bundle.entities.map((chain) => chain.head.id));
	for (const chain of bundle.entities) {
		assertCanonicalHead(chain.head.reference, chain.head.id, chain.head.kind);
		if (chain.head.parentId !== null && !entityIds.has(chain.head.parentId)) {
			throw new Error(`Missing canonical parent ${chain.head.parentId} for ${chain.head.id}.`);
		}
	}
	for (const chain of bundle.contexts) {
		assertCanonicalHead(chain.head.reference, chain.head.id, "context");
		if (chain.head.scopeEntityId !== null && !entityIds.has(chain.head.scopeEntityId)) {
			throw new Error(`Missing canonical context scope ${chain.head.scopeEntityId} for ${chain.head.id}.`);
		}
	}
	for (const chain of bundle.contextTerms) {
		assertCanonicalHead(chain.head.reference, chain.head.id, "contextTerm");
	}
}

function assertCanonicalHead(reference: string, id: string, expectedKind: EntityKind | "context" | "contextTerm"): void {
	const decoded = decodeCanonicalReference(reference);
	if (decoded.kind !== expectedKind || decoded.stableId !== id) {
		throw new Error(`Canonical reference ${reference} does not match ${expectedKind} Stable identity ${id}.`);
	}
}

function assertBundleReferenceCollisions(left: CanonicalChainBundle, right: CanonicalChainBundle): void {
	assertUniqueAcrossBundles(left.entities, right.entities, (chain) => chain.head.reference, (chain) => chain.head.id, "canonical-reference");
	assertUniqueAcrossBundles(left.contexts, right.contexts, (chain) => chain.head.reference, (chain) => chain.head.id, "canonical-reference");
	assertUniqueAcrossBundles(left.contexts, right.contexts, (chain) => chain.head.key, (chain) => chain.head.id, "context-key");
	assertUniqueAcrossBundles(left.contextTerms, right.contextTerms, (chain) => `${chain.head.contextKey}\0${chain.head.term.toLocaleLowerCase()}`, (chain) => chain.head.id, "term-name");
}

function assertUniqueAcrossBundles<Chain>(left: Chain[], right: Chain[], keyOf: (chain: Chain) => string, identityOf: (chain: Chain) => string, collisionClass: string): void {
	const identities = new Map<string, string>();
	for (const chain of [...left, ...right]) {
		const key = keyOf(chain);
		const identity = identityOf(chain);
		const existing = identities.get(key);
		if (existing !== undefined && existing !== identity) {
			throw new Error(`Synchronization preflight ${collisionClass} collision: ${key}.`);
		}
		identities.set(key, identity);
	}
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
	return left.head.reference === right.head.reference && left.head.contentHash === right.head.contentHash && left.head.kind === right.head.kind && left.head.title === right.head.title && left.head.body === right.head.body && left.head.bodySource === right.head.bodySource && left.head.status === right.head.status && left.head.parentId === right.head.parentId && left.head.tombstone === right.head.tombstone;
}

function contextHeadsMatch(left: CanonicalContextChain, right: CanonicalContextChain): boolean {
	return left.head.reference === right.head.reference && left.head.key === right.head.key && left.head.contentHash === right.head.contentHash && left.head.scopeEntityId === right.head.scopeEntityId && left.head.title === right.head.title && left.head.summary === right.head.summary;
}

function contextTermHeadsMatch(left: CanonicalContextTermChain, right: CanonicalContextTermChain): boolean {
	return left.head.reference === right.head.reference && left.head.contentHash === right.head.contentHash && left.head.contextKey === right.head.contextKey && left.head.term === right.head.term && left.head.definition === right.head.definition && JSON.stringify(left.head.avoid) === JSON.stringify(right.head.avoid) && left.head.tombstone === right.head.tombstone;
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
	if (candidate.head.contextKey !== current.head.contextKey || materialized.id !== current.head.id || materialized.term !== current.head.term || materialized.definition !== current.head.definition || JSON.stringify(materialized.avoid) !== JSON.stringify(current.head.avoid) || materialized.tombstone !== current.head.tombstone || computeContextTermContentHash(materialized.term, materialized.definition, materialized.avoid, materialized.tombstone) !== current.head.contentHash) {
		throwConflict(current);
	}
}

function throwConflict(chain: { head: { revision: number; contentHash: string; id?: string; key?: string; kind?: EntityKind; term?: string } }): never {
	const recordKind: SynchronizeRecordKind = "kind" in chain.head ? "entity" : "term" in chain.head ? "context-term" : "context";
	const recordId = recordKind === "context" ? chain.head.key! : chain.head.id!;
	throw new SynchronizeConflictError(recordKind, recordId, chain.head.revision, chain.head.contentHash);
}