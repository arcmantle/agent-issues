import type { BodySource } from "./domain.js";
import { EntityRevisionError, type EntityRevisionPatch, type MaterializedEntityRevision } from "./domain.js";
import { materializeRevisionChain } from "./materialize-revision-chain.js";

type EntityHead = {
	id: string;
	title: string;
	body: string;
	bodySource: BodySource;
	status: string;
	parentId: string | null;
	revision: number;
	createdAt: string;
	tombstone?: boolean | null;
};

/**
 * Applies a single reverse patch to the given state, returning the
 * predecessor state one revision earlier (ADR55/ISS261). Pure: does not
 * mutate `state`.
 */
export function applyReversePatch(
	state: { title: string; body: string; bodySource: BodySource; status: string; parentId: string | null; tombstone: boolean | null },
	patch: EntityRevisionPatch
): { title: string; body: string; bodySource: BodySource; status: string; parentId: string | null; tombstone: boolean | null } {
	return {
		title: patch.priorTitle,
		body: patch.priorBody,
		bodySource: patch.priorBodySource,
		status: patch.priorStatus ?? state.status,
		parentId: patch.priorParentId !== undefined ? patch.priorParentId : state.parentId,
		tombstone: patch.priorTombstone != null ? patch.priorTombstone : state.tombstone
	};
}

/**
 * Walks the reverse-delta chain newest-first from `head` and returns the
 * materialized entity state at `targetRevision` (ISS261/ADR55).
 *
 * `patches` must be the entity's delta rows ordered by revision **descending**.
 * The caller must supply all patches from HEAD down to `targetRevision + 1`
 * for reconstruction, plus the target revision's patch for attribution
 * metadata. Missing reconstruction entries cause a `"broken-chain"` error.
 *
 * `status`, `parentId`, and `tombstone` on the result are best-effort from
 * the current head until ISS258 writes lifecycle deltas.
 */
export function materializeFromPatches(
	entityId: string,
	head: EntityHead,
	patches: EntityRevisionPatch[],
	targetRevision: number
): MaterializedEntityRevision {
	const headRevision = head.revision;
	const materialized = materializeRevisionChain({
		recordLabel: entityId,
		headState: {
			title: head.title,
			body: head.body,
			bodySource: head.bodySource,
			status: head.status,
			parentId: head.parentId,
			tombstone: head.tombstone ?? null
		},
		headRevision,
		headCreatedAt: head.createdAt,
		patches,
		targetRevision,
		applyReversePatch,
		createError: (message, currentHeadRevision) => new EntityRevisionError(
			entityId,
			message.startsWith("Broken") ? "broken-chain" : "revision-out-of-range",
			message,
			currentHeadRevision
		)
	});

	return {
		entityId,
		targetRevision,
		headRevision,
		...materialized.state,
		author: materialized.author,
		createdAt: materialized.createdAt,
		restoredFromRevision: patches.find((patch) => patch.revision === targetRevision)?.restoredFromRevision ?? null
	};
}
