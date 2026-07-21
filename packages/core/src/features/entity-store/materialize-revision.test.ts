import { describe, expect, it } from "vitest";

import { EntityRevisionError, type EntityRevisionPatch } from "./domain.js";
import { applyReversePatch, materializeFromPatches } from "./materialize-revision.js";

describe("materializeFromPatches", () => {
	it("treats a legacy null tombstone patch as unchanged", () => {
		const state = { title: "Current", body: "Body", bodySource: "authored" as const, status: "todo", parentId: null, tombstone: false };
		const patch: EntityRevisionPatch = { revision: 2, author: "system", createdAt: "2026-01-02T00:00:00.000Z", priorTitle: "Initial", priorBody: "Body", priorBodySource: "authored", priorTombstone: null };

		expect(applyReversePatch(state, patch).tombstone).toBe(false);
	});

	it("applies content and lifecycle patches newest-first with target revision metadata", () => {
		const patches: EntityRevisionPatch[] = [
			{
				revision: 3,
				author: "third-author",
				createdAt: "2026-01-03T00:00:00.000Z",
				priorTitle: "Second",
				priorBody: "Second body",
				priorBodySource: "generated",
				priorStatus: "in-progress",
				priorParentId: "INIT1",
				priorTombstone: false
			},
			{
				revision: 2,
				author: "second-author",
				createdAt: "2026-01-02T00:00:00.000Z",
				priorTitle: "First",
				priorBody: "First body",
				priorBodySource: "authored",
				priorStatus: "todo",
				priorParentId: null,
				priorTombstone: null
			}
		];

		const materialized = materializeFromPatches(
			"ISS1",
			{
				id: "ISS1",
				title: "Third",
				body: "Third body",
				bodySource: "authored",
				status: "done",
				parentId: "INIT2",
				revision: 3,
				createdAt: "2026-01-01T00:00:00.000Z"
			},
			patches,
			2
		);

		expect(materialized).toEqual({
			entityId: "ISS1",
			targetRevision: 2,
			headRevision: 3,
			title: "Second",
			body: "Second body",
			bodySource: "generated",
			status: "in-progress",
			parentId: "INIT1",
			tombstone: false,
			author: "second-author",
			createdAt: "2026-01-02T00:00:00.000Z",
			restoredFromRevision: null
		});
	});

	it("reports a stable broken-chain error when a required delta is absent", () => {
		expect(() =>
			materializeFromPatches(
				"ISS1",
				{
					id: "ISS1",
					title: "Third",
					body: "Third body",
					bodySource: "authored",
					status: "done",
					parentId: null,
					revision: 3,
					createdAt: "2026-01-01T00:00:00.000Z"
				},
				[],
				1
			)
		).toThrow(EntityRevisionError);

		try {
			materializeFromPatches(
				"ISS1",
				{
					id: "ISS1",
					title: "Third",
					body: "Third body",
					bodySource: "authored",
					status: "done",
					parentId: null,
					revision: 3,
					createdAt: "2026-01-01T00:00:00.000Z"
				},
				[],
				1
			);
		} catch (error) {
			expect(error).toBeInstanceOf(EntityRevisionError);
			expect((error as EntityRevisionError).reason).toBe("broken-chain");
			expect((error as EntityRevisionError).headRevision).toBe(3);
		}
	});

	it("reports a broken chain when target revision metadata is absent", () => {
		try {
			materializeFromPatches(
				"ISS1",
				{
					id: "ISS1",
					title: "Third",
					body: "Third body",
					bodySource: "authored",
					status: "done",
					parentId: null,
					revision: 3,
					createdAt: "2026-01-01T00:00:00.000Z"
				},
				[
					{
						revision: 3,
						author: "third-author",
						createdAt: "2026-01-03T00:00:00.000Z",
						priorTitle: "Second",
						priorBody: "Second body",
						priorBodySource: "authored"
					}
				],
				2
			);
			expect.unreachable("Expected materialization to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(EntityRevisionError);
			expect(error).toMatchObject({ reason: "broken-chain", headRevision: 3 });
		}
	});
});