import { describe, expect, it } from "vitest";

import {
	materializeContextFromPatches,
	materializeContextTermFromPatches
} from "./materialize-context-revision.js";
import type { ContextRevisionPatch, ContextTermRevisionPatch } from "./context-types.js";

describe("context revision materialization", () => {
	it("materializes context revisions newest-first", () => {
		const patches: ContextRevisionPatch[] = [
			{
				revision: 3,
				author: "carol",
				createdAt: "2026-01-03T00:00:00.000Z",
				priorTitle: "Second",
				priorSummary: "Second summary."
			},
			{
				revision: 2,
				author: "bob",
				createdAt: "2026-01-02T00:00:00.000Z",
				priorTitle: "First",
				priorSummary: "First summary."
			}
		];

		expect(materializeContextFromPatches(
			{
				key: "default",
				title: "Third",
				summary: "Third summary.",
				revision: 3,
				createdAt: "2026-01-01T00:00:00.000Z"
			},
			patches,
			1
		)).toEqual({
			contextKey: "default",
			targetRevision: 1,
			headRevision: 3,
			title: "First",
			summary: "First summary.",
			author: "system",
			createdAt: "2026-01-01T00:00:00.000Z",
			restoredFromRevision: null
		});
	});

	it("materializes a term before its tombstone", () => {
		const patches: ContextTermRevisionPatch[] = [
			{
				revision: 3,
				author: "carol",
				createdAt: "2026-01-03T00:00:00.000Z",
				priorDefinition: "Second definition.",
				priorAvoid: ["second"],
				priorTombstone: false
			},
			{
				revision: 2,
				author: "bob",
				createdAt: "2026-01-02T00:00:00.000Z",
				priorDefinition: "First definition.",
				priorAvoid: [],
				priorTombstone: false
			}
		];

		expect(materializeContextTermFromPatches(
			{
				contextKey: "default",
				term: "Order",
				definition: "Second definition.",
				avoid: ["second"],
				tombstone: true,
				revision: 3,
				createdAt: "2026-01-01T00:00:00.000Z"
			},
			patches,
			1
		)).toEqual({
			contextKey: "default",
			term: "Order",
			targetRevision: 1,
			headRevision: 3,
			definition: "First definition.",
			avoid: [],
			tombstone: false,
			author: "system",
			createdAt: "2026-01-01T00:00:00.000Z",
			restoredFromRevision: null
		});
	});
});