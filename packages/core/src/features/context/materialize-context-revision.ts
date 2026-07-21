import { materializeRevisionChain } from "../entity-store/materialize-revision-chain.js";
import {
	ContextRevisionError,
	type ContextRevisionPatch,
	type ContextTermRevisionPatch,
	type MaterializedContextRevision,
	type MaterializedContextTermRevision
} from "./context-types.js";

export function materializeContextFromPatches(
	head: { key: string; title: string; summary: string; revision: number; createdAt: string },
	patches: ContextRevisionPatch[],
	targetRevision: number
): MaterializedContextRevision {
	const materialized = materializeRevisionChain({
		recordLabel: `context ${head.key}`,
		headState: { title: head.title, summary: head.summary },
		headRevision: head.revision,
		headCreatedAt: head.createdAt,
		patches,
		targetRevision,
		applyReversePatch: (_state, patch) => ({ title: patch.priorTitle, summary: patch.priorSummary }),
		createError: (message, headRevision) => new ContextRevisionError(
			head.key,
			message.startsWith("Broken") ? "broken-chain" : "revision-out-of-range",
			message,
			headRevision
		)
	});

	return {
		contextKey: head.key,
		targetRevision,
		headRevision: head.revision,
		...materialized.state,
		author: materialized.author,
		createdAt: materialized.createdAt,
		restoredFromRevision: patches.find((patch) => patch.revision === targetRevision)?.restoredFromRevision ?? null
	};
}

export function materializeContextTermFromPatches(
	head: { contextKey: string; term: string; definition: string; avoid: string[]; tombstone: boolean; revision: number; createdAt: string },
	patches: ContextTermRevisionPatch[],
	targetRevision: number
): MaterializedContextTermRevision {
	const materialized = materializeRevisionChain({
		recordLabel: `context term ${head.term} in ${head.contextKey}`,
		headState: { definition: head.definition, avoid: head.avoid, tombstone: head.tombstone },
		headRevision: head.revision,
		headCreatedAt: head.createdAt,
		patches,
		targetRevision,
		applyReversePatch: (_state, patch) => ({
			definition: patch.priorDefinition,
			avoid: patch.priorAvoid,
			tombstone: patch.priorTombstone
		}),
		createError: (message, headRevision) => new ContextRevisionError(
			head.contextKey,
			message.startsWith("Broken") ? "broken-chain" : "revision-out-of-range",
			message,
			headRevision,
			head.term
		)
	});

	return {
		contextKey: head.contextKey,
		term: head.term,
		targetRevision,
		headRevision: head.revision,
		...materialized.state,
		author: materialized.author,
		createdAt: materialized.createdAt,
		restoredFromRevision: patches.find((patch) => patch.revision === targetRevision)?.restoredFromRevision ?? null
	};
}