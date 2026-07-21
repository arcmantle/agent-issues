import { describe, expect, it } from "vitest";

import { computeEntityContentHash } from "../entity-store/domain.js";
import { mergeCanonicalChainBundles, SynchronizeConflictError, type CanonicalChainBundle, type CanonicalEntityChain } from "./canonical-chain.js";

const emptyBundle = (): CanonicalChainBundle => ({ entities: [], contexts: [], contextTerms: [] });

function entityChain(title: string, revision: number, priorTitles: string[] = []): CanonicalEntityChain {
	const deltas = priorTitles.map((priorTitle, index) => ({
		id: `delta-${index + 2}-${priorTitle}`,
		revision: index + 2,
		author: "author",
		createdAt: `2026-01-0${index + 2}T00:00:00.000Z`,
		priorTitle,
		priorBody: "body",
		priorBodySource: "authored" as const
	}));
	return {
		head: {
			id: "ISS1",
			kind: "issue",
			title,
			body: "body",
			bodySource: "authored",
			status: "todo",
			parentId: null,
			tombstone: false,
			revision,
			contentHash: computeEntityContentHash(title, "body"),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: `2026-01-0${revision}T00:00:00.000Z`
		},
		deltas
	};
}

describe("mergeCanonicalChainBundles", () => {
	it("keeps identical heads as a no-op", () => {
		const chain = entityChain("Initial", 1);
		const left = { ...emptyBundle(), entities: [chain] };
		const right = { ...emptyBundle(), entities: [{ ...chain, deltas: [{ id: "different-baseline", revision: 1, author: "other", createdAt: chain.head.createdAt, priorTitle: "Initial", priorBody: "body", priorBodySource: "authored" }] }] };

		expect(mergeCanonicalChainBundles(left, right)).toEqual(left);
	});

	it("selects a strict compatible extension regardless of source direction", () => {
		const revision1 = entityChain("Initial", 1);
		const revision2 = entityChain("Updated", 2, ["Initial"]);

		expect(mergeCanonicalChainBundles({ ...emptyBundle(), entities: [revision1] }, { ...emptyBundle(), entities: [revision2] }).entities).toEqual([revision2]);
		expect(mergeCanonicalChainBundles({ ...emptyBundle(), entities: [revision2] }, { ...emptyBundle(), entities: [revision1] }).entities).toEqual([revision2]);
	});

	it("rejects divergent heads with current revision metadata", () => {
		const left = entityChain("Local", 2, ["Initial"]);
		const right = entityChain("Cloud", 2, ["Initial"]);

		expect(() => mergeCanonicalChainBundles({ ...emptyBundle(), entities: [left] }, { ...emptyBundle(), entities: [right] })).toThrow(SynchronizeConflictError);
		try {
			mergeCanonicalChainBundles({ ...emptyBundle(), entities: [left] }, { ...emptyBundle(), entities: [right] });
		} catch (error) {
			expect(error).toMatchObject({ recordKind: "entity", recordId: "ISS1", currentRevision: 2, currentContentHash: left.head.contentHash });
		}
	});

	it("rejects equal revision and content hash when lifecycle facts diverge", () => {
		const left = entityChain("Same content", 1);
		const right = { ...entityChain("Same content", 1), head: { ...entityChain("Same content", 1).head, status: "in-progress" } };

		expect(() => mergeCanonicalChainBundles({ ...emptyBundle(), entities: [left] }, { ...emptyBundle(), entities: [right] })).toThrow(SynchronizeConflictError);
	});

	it("rejects a higher revision that does not descend from the lower head", () => {
		const lower = entityChain("Expected ancestor", 1);
		const incompatibleHigher = entityChain("Current", 2, ["Different ancestor"]);

		expect(() => mergeCanonicalChainBundles({ ...emptyBundle(), entities: [lower] }, { ...emptyBundle(), entities: [incompatibleHigher] })).toThrow(SynchronizeConflictError);
	});
});