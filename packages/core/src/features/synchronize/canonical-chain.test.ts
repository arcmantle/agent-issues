import { describe, expect, it } from "vitest";

import { computeContextTermContentHash } from "../context/context-types.js";
import { computeIssueCommentContentHash } from "../issue-comment/issue-comment-types.js";
import { computeEntityContentHash } from "../entity-store/domain.js";
import { encodeCanonicalReference } from "../entity-store/canonical-reference.js";
import { deriveUserIdentity } from "../user-directory/user-directory.js";
import { CONTEXT_TERM_REVERSE_PATCH_REGISTRY, createReverseFieldPatch, ENTITY_REVERSE_PATCH_REGISTRY, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY } from "../reverse-field-patch/reverse-field-patch.js";
import { mergeCanonicalChainBundles, SynchronizeConflictError, type CanonicalChainBundle, type CanonicalContextChain, type CanonicalContextTermChain, type CanonicalEntityChain, type CanonicalIssueCommentChain } from "./canonical-chain.js";

const emptyBundle = (): CanonicalChainBundle => ({ entities: [], contexts: [], contextTerms: [], issueComments: [], users: [] });
const ENTITY_STABLE_ID = "00000000-0000-4000-8000-000000000001";
const ENTITY_REFERENCE = encodeCanonicalReference("issue", ENTITY_STABLE_ID);
const ISSUE_COMMENT_STABLE_ID = "00000000-0000-4000-8000-000000000002";

function entityChain(title: string, revision: number, predecessorTitles: string[] = []): CanonicalEntityChain {
	const titles = [...predecessorTitles, title];
	const state = (stateTitle: string) => ({ title: stateTitle, body: "body", bodySource: "authored" as const, status: "todo", parentId: null, tombstone: false });
	const deltas = predecessorTitles.map((predecessorTitle, index) => {
		const deltaRevision = index + 2;
		return {
			id: `delta-${deltaRevision}-${predecessorTitle}`,
			revision: deltaRevision,
			author: "author",
			createdAt: `2026-01-0${deltaRevision}T00:00:00.000Z`,
			...createReverseFieldPatch(state(titles[index + 1]), state(predecessorTitle), ENTITY_REVERSE_PATCH_REGISTRY)
		};
	});
	return {
		head: {
			id: ENTITY_STABLE_ID,
			reference: ENTITY_REFERENCE,
			createdBy: "user",
			updatedBy: "user",
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

function contextTermChain(term: string, revision: number, predecessorTerm?: string): CanonicalContextTermChain {
	const stableId = "018f0000-0000-4000-8000-000000000001";
	const state = (stateTerm: string) => ({ term: stateTerm, definition: "A confirmed purchase.", avoid: ["request"], tombstone: false });
	return {
		head: {
			id: stableId,
			reference: encodeCanonicalReference("contextTerm", stableId),
			createdBy: "user",
			updatedBy: "user",
			contextKey: "default",
			...state(term),
			revision,
			contentHash: computeContextTermContentHash(term, "A confirmed purchase.", ["request"], false),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: `2026-01-0${revision}T00:00:00.000Z`
		},
		deltas: predecessorTerm === undefined ? [] : [{
			id: "rename-delta",
			revision,
			author: "alice",
			createdAt: `2026-01-0${revision}T00:00:00.000Z`,
			...createReverseFieldPatch(state(term), state(predecessorTerm), CONTEXT_TERM_REVERSE_PATCH_REGISTRY)
		}]
	};
}

function contextChain(key: string, stableId = "00000000-0000-4000-8000-000000000010"): CanonicalContextChain {
	return {
		head: {
			id: stableId,
			reference: encodeCanonicalReference("context", stableId),
			createdBy: "user",
			updatedBy: "user",
			key,
			scopeEntityId: null,
			title: "Context",
			summary: "Summary",
			revision: 1,
			contentHash: "hash",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z"
		},
		deltas: []
	};
}

function issueCommentChain(body: string, referencedIssueIds: string[], revision: number, predecessor?: { body: string; referencedIssueIds: string[]; tombstone: boolean }): CanonicalIssueCommentChain {
	const state = { body, referencedIssueIds, tombstone: false };
	return {
		head: {
			id: ISSUE_COMMENT_STABLE_ID,
			reference: encodeCanonicalReference("issueComment", ISSUE_COMMENT_STABLE_ID),
			issueId: ENTITY_STABLE_ID,
			createdBy: "user",
			updatedBy: "user",
			...state,
			revision,
			contentHash: computeIssueCommentContentHash(body, referencedIssueIds, false),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: `2026-01-0${revision}T00:00:00.000Z`
		},
		deltas: predecessor === undefined ? [] : [{
			id: `issue-comment-delta-${revision}`,
			revision,
			author: "user",
			createdAt: `2026-01-0${revision}T00:00:00.000Z`,
			...createReverseFieldPatch(state, predecessor, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY)
		}]
	};
}

describe("mergeCanonicalChainBundles", () => {
	it("merges user directories by newest non-empty display name", () => {
		const identity = deriveUserIdentity("entra:alice");
		const original = { ...identity, displayName: "Alice", updatedAt: "2026-08-07T10:00:00.000Z" };
		const renamed = { ...identity, displayName: "Alicia", updatedAt: "2026-08-07T11:00:00.000Z" };

		expect(mergeCanonicalChainBundles(
			{ ...emptyBundle(), users: [original] },
			{ ...emptyBundle(), users: [renamed] }
		).users).toEqual([renamed]);
	});

	it("merges a renamed context term as one stable-ID chain", () => {
		const original = contextTermChain("Order", 1);
		const renamed = contextTermChain("Purchase", 2, "Order");

		expect(mergeCanonicalChainBundles(
			{ ...emptyBundle(), contextTerms: [original] },
			{ ...emptyBundle(), contextTerms: [renamed] }
		).contextTerms).toEqual([renamed]);
	});

	it("merges a comment body and referenced issue IDs as one compatible extension", () => {
		const issue = entityChain("Issue", 1);
		const original = issueCommentChain("Initial", [], 1);
		const updated = issueCommentChain("Updated", [ENTITY_STABLE_ID], 2, { body: "Initial", referencedIssueIds: [], tombstone: false });

		expect(mergeCanonicalChainBundles(
			{ ...emptyBundle(), entities: [issue], issueComments: [original] },
			{ ...emptyBundle(), entities: [issue], issueComments: [updated] }
		).issueComments).toEqual([updated]);
	});

	it("keeps identical heads as a no-op", () => {
		const chain = entityChain("Initial", 1);
		const left = { ...emptyBundle(), entities: [chain] };
		const baselineState = { title: chain.head.title, body: chain.head.body, bodySource: chain.head.bodySource, status: chain.head.status, parentId: chain.head.parentId, tombstone: chain.head.tombstone };
		const right = { ...emptyBundle(), entities: [{ ...chain, deltas: [{ id: "different-baseline", revision: 1, author: "other", createdAt: chain.head.createdAt, ...createReverseFieldPatch(baselineState, baselineState, ENTITY_REVERSE_PATCH_REGISTRY) }] }] };

		expect(mergeCanonicalChainBundles(left, right)).toEqual(left);
	});

	it("classifies duplicate canonical references before mutation", () => {
		const left = entityChain("Local", 1);
		const right = entityChain("Cloud", 1);
		right.head.id = "00000000-0000-4000-8000-000000000002";

		expect(() => mergeCanonicalChainBundles(
			{ ...emptyBundle(), entities: [left] },
			{ ...emptyBundle(), entities: [right] }
		)).toThrow(`Synchronization preflight canonical-reference collision: ${ENTITY_REFERENCE}.`);
	});

	it("classifies duplicate context keys before mutation", () => {
		const left = contextChain("default");
		const right = contextChain("default", "00000000-0000-4000-8000-000000000011");

		expect(() => mergeCanonicalChainBundles(
			{ ...emptyBundle(), contexts: [left] },
			{ ...emptyBundle(), contexts: [right] }
		)).toThrow("Synchronization preflight context-key collision: default.");
	});

	it("classifies duplicate term names before mutation", () => {
		const left = contextTermChain("Order", 1);
		const right = contextTermChain("order", 1);
		right.head.id = "018f0000-0000-4000-8000-000000000002";
		right.head.reference = encodeCanonicalReference("contextTerm", right.head.id);

		expect(() => mergeCanonicalChainBundles(
			{ ...emptyBundle(), contextTerms: [left] },
			{ ...emptyBundle(), contextTerms: [right] }
		)).toThrow(/Synchronization preflight term-name collision/);
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
			expect(error).toMatchObject({ recordKind: "entity", recordId: ENTITY_STABLE_ID, currentRevision: 2, currentContentHash: left.head.contentHash });
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