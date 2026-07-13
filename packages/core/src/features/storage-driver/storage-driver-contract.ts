import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { HistoryEntryRecord } from "../entity-store/domain.js";
import type { StorageDriver } from "./storage-driver.js";

export type StorageDriverContractOptions = {
	/** Folded into each describe block's title so a failure identifies which backend broke. */
	label: string;
	/** Opens a fresh `StorageDriver` for a single test; the test closes it via `store.close()`. */
	openStore: () => StorageDriver | Promise<StorageDriver>;
};

/**
 * The behavioral contract every `StorageDriver` backend must satisfy
 * (ADR11, ADR13): entity lifecycle, handoffs, context/glossary, and
 * connection lifecycle - run against whichever backend `openStore` opens,
 * per the ai-tdd principle that both backends are held to one identical
 * spec rather than duplicated bespoke tests (ISS46).
 *
 * Tenant administration is deliberately excluded from this shared spec.
 * Postgres RLS (ADR9) makes each `PgStore` instance's own tenant the only
 * one it can ever see or touch, so "list every tenant"/cross-tenant admin
 * behavior is structurally different per backend by design, not an
 * oversight - each backend covers it with its own bespoke test instead
 * (`storage-driver.test.ts` for `SqliteStore`, `pg-store.test.ts` for
 * `PgStore`).
 */
export function runStorageDriverContractSuite(options: StorageDriverContractOptions): void {
	const { label, openStore } = options;

	describe(`storage-driver seam: entity lifecycle (${label})`, () => {
		it("creates an entity and reads it back through the async seam", async () => {
			const store = await openStore();

			try {
				const created = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const details = await store.getEntityDetails(created.id);

				expect(details.entity).toEqual(created);
			} finally {
				await store.close();
			}
		});

		it("updates status, links, moves, and archives an entity through the seam", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });
				const blocker = await store.createEntity({ kind: "issue", title: "Blocking issue", parentId: initiative.id });

				const linked = await store.linkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
				expect(linked.created).toBe(true);

				const unlinked = await store.unlinkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
				expect(unlinked.removed).toBe(true);

				const statusUpdate = await store.updateEntityStatus({ entityId: issue.id, status: "in-progress" });
				expect(statusUpdate.entity.status).toBe("in-progress");

				const otherInitiative = await store.createEntity({ kind: "initiative", title: "Other initiative" });
				const moved = await store.moveEntity({ entityId: issue.id, newParentId: otherInitiative.id });
				expect(moved.newParentId).toBe(otherInitiative.id);

				const bodyUpdated = await store.setEntityBody({ entityId: issue.id, body: "Detailed plan." });
				expect(bodyUpdated.body).toBe("Detailed plan.");

				const archived = await store.archiveEntity({ entityId: issue.id });
				expect(archived.entity.status).toBe("done");

				const deleted = await store.deleteEntity({ entityId: issue.id });
				expect(deleted.entity.id).toBe(issue.id);
			} finally {
				await store.close();
			}
		});

		it("lists entities, orphans, project ADRs, and reads the snapshot and initiative bundle", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				await store.createEntity({ kind: "issue", title: "Tracked issue", parentId: initiative.id });
				const orphanAdr = await store.createEntity({ kind: "adr", title: "Project-scoped ADR" });

				expect((await store.listEntities("initiative")).map((entity) => entity.id)).toContain(initiative.id);
				expect((await store.listOrphans()).map((entity) => entity.id)).not.toContain(orphanAdr.id);
				expect((await store.listProjectAdrs()).map((entity) => entity.id)).toContain(orphanAdr.id);

				const snapshot = await store.getDatabaseSnapshot();
				expect(snapshot.entities.map((entity) => entity.id)).toContain(initiative.id);

				const bundle = await store.getInitiativeBundle(initiative.id);
				expect(bundle.issues.map((entity) => entity.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^ISS/)]));
			} finally {
				await store.close();
			}
		});

		it("lists an entity's append-only history through the async seam", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				await store.updateEntityStatus({ entityId: initiative.id, status: "active" });

				const history = await store.listEntityHistory(initiative.id);
				expect(history.map((entry) => entry.version)).toEqual([1, 2]);
				expect(history[1]?.status).toBe("active");
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: snapshot signature (${label})`, () => {
		it("stays stable across calls with no intervening write, then changes after one (ISS191)", async () => {
			const store = await openStore();

			try {
				const before = await store.getSnapshotSignature();
				const stillBefore = await store.getSnapshotSignature();
				expect(stillBefore).toBe(before);

				await store.createEntity({ kind: "initiative", title: "Snapshot signature bump" });

				const after = await store.getSnapshotSignature();
				expect(after).not.toBe(before);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: handoff lifecycle (${label})`, () => {
		it("creates, updates, lists, and deletes a handoff through the seam", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });

				const created = await store.createHandoff({ entityId: initiative.id, summary: "First pass", body: "Body." });
				expect(created.entityId).toBe(initiative.id);

				const updated = await store.updateHandoff({ handoffId: created.id, summary: "Revised" });
				expect(updated.summary).toBe("Revised");

				expect((await store.listHandoffs({ entityId: initiative.id })).map((handoff) => handoff.id)).toContain(created.id);

				const details = await store.getHandoffDetails(initiative.id);
				expect(details.handoffs.map((handoff) => handoff.id)).toContain(created.id);

				const deleted = await store.deleteHandoff({ handoffId: created.id });
				expect(deleted.removed).toBe(true);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: context lifecycle (${label})`, () => {
		it("defines, reads, queries, and forgets a context term through the seam", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				await store.upsertContext({ scopeRef: initiative.id, title: "Custom title", summary: "Custom summary" });

				const defineResult = await store.defineContextTerm({
					scopeRef: initiative.id,
					term: "storage-driver seam",
					definition: "The engine-agnostic boundary the domain layer talks to."
				});
				expect(defineResult.created).toBe(true);

				const details = await store.getContextDetails({ scopeRef: initiative.id });
				expect(details.context.title).toBe("Custom title");
				expect(details.terms.map((term) => term.term)).toContain("storage-driver seam");

				const directory = await store.getContextDirectory();
				expect(directory.initiatives.map((entry) => entry.context.scopeEntityId)).toContain(initiative.id);

				const queried = await store.queryContextDirectory({ query: "storage-driver" });
				expect(queried.terms.map((term) => term.term)).toContain("storage-driver seam");

				expect((await store.listContexts()).contexts.length).toBeGreaterThan(0);

				const forgotten = await store.forgetContextTerm({ scopeRef: initiative.id, term: "storage-driver seam" });
				expect(forgotten.removed).toBe(true);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: lifecycle (${label})`, () => {
		it("releases the underlying connection on close", async () => {
			const store = await openStore();
			await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });

			await store.close();

			await expect(store.listEntities("initiative")).rejects.toThrow();
		});
	});

	describe(`storage-driver seam: bulk history log (${label})`, () => {
		it("lists every tenant history entry and idempotently applies a batch (ISS57/ADR16)", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				await store.updateEntityStatus({ entityId: initiative.id, status: "active" });

				const allEntries = await store.listAllHistoryEntries();
				expect(allEntries.map((entry) => entry.entityId)).toContain(initiative.id);
				expect(allEntries.length).toBeGreaterThanOrEqual(2);

				const reapplied = await store.applyHistoryEntries(allEntries);
				expect(reapplied.inserted).toBe(0);

				const foreignEntry: HistoryEntryRecord = {
					id: randomUUID(),
					entityId: initiative.id,
					version: 99,
					author: "system",
					title: "Imported from the other side",
					body: "",
					bodySource: "authored",
					status: "active",
					parentId: null,
					createdAt: new Date().toISOString()
				};

				const appliedForeign = await store.applyHistoryEntries([foreignEntry, ...allEntries]);
				expect(appliedForeign.inserted).toBe(1);

				const afterApply = await store.listAllHistoryEntries();
				expect(afterApply.map((entry) => entry.id)).toContain(foreignEntry.id);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: resolved-facts apply (${label})`, () => {
		it("overwrites an existing entity's facts to match a resolved entry, without appending a new history entry", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const historyBefore = await store.listEntityHistory(initiative.id);

				const resolved: HistoryEntryRecord = {
					id: randomUUID(),
					entityId: initiative.id,
					version: 99,
					author: "system",
					title: "Resolved from the other side",
					body: "merged body",
					bodySource: "authored",
					status: "active",
					parentId: null,
					createdAt: new Date().toISOString()
				};

				const result = await store.applyResolvedFacts([resolved]);
				expect(result.updated).toEqual([initiative.id]);
				expect(result.created).toEqual([]);

				const { entity } = await store.getEntityDetails(initiative.id);
				expect(entity.title).toBe("Resolved from the other side");
				expect(entity.body).toBe("merged body");
				expect(entity.status).toBe("active");

				const historyAfter = await store.listEntityHistory(initiative.id);
				expect(historyAfter).toHaveLength(historyBefore.length);

				// Re-applying the same resolved facts is a no-op (idempotent).
				const reapplied = await store.applyResolvedFacts([resolved]);
				expect(reapplied.updated).toEqual([]);
				expect(reapplied.created).toEqual([]);
			} finally {
				await store.close();
			}
		});

		it("creates a live-cache row for an entity this side has never seen, deriving its kind from its id prefix", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });

				const newIssueId = "ISS999999";
				const resolved: HistoryEntryRecord = {
					id: randomUUID(),
					entityId: newIssueId,
					version: 1,
					author: "system",
					title: "Introduced by the other side",
					body: "",
					bodySource: "authored",
					status: "todo",
					parentId: initiative.id,
					createdAt: new Date().toISOString()
				};

				const result = await store.applyResolvedFacts([resolved]);
				expect(result.created).toEqual([newIssueId]);

				const { entity, incoming } = await store.getEntityDetails(newIssueId);
				expect(entity.kind).toBe("issue");
				expect(entity.title).toBe("Introduced by the other side");
				expect(incoming.some((relation) => relation.entity.id === initiative.id && relation.relationType === "tracks")).toBe(true);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: bulk relations (${label})`, () => {
		it("lists only non-structural relations and idempotently applies a batch (ISS60/ADR16)", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const blocker = await store.createEntity({ kind: "issue", title: "Blocker issue", parentId: initiative.id });
				const blocked = await store.createEntity({ kind: "issue", title: "Blocked issue", parentId: initiative.id });
				await store.linkEntities({ fromId: blocker.id, toId: blocked.id, relationType: "blocks" });

				const relations = await store.listAllRelations();
				// The "tracks" relations created by parentId above are structural
				// and must be excluded - only the explicit "blocks" link should
				// show up here.
				expect(relations.some((relation) => relation.type === "tracks")).toBe(false);
				expect(relations).toContainEqual(expect.objectContaining({ fromId: blocker.id, toId: blocked.id, type: "blocks" }));

				const reapplied = await store.applyRelations(relations);
				expect(reapplied.inserted).toBe(0);

				const foreignRelation = { fromId: blocked.id, toId: blocker.id, type: "blocks" as const, createdAt: new Date().toISOString() };
				const appliedForeign = await store.applyRelations([foreignRelation, ...relations]);
				expect(appliedForeign.inserted).toBe(1);

				const afterApply = await store.listAllRelations();
				expect(afterApply).toContainEqual(expect.objectContaining({ fromId: blocked.id, toId: blocker.id, type: "blocks" }));
			} finally {
				await store.close();
			}
		});

		it("still lists a structural-type relation manually linked alongside an entity's real structural parent", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const issueA = await store.createEntity({ kind: "issue", title: "Issue A", parentId: initiative.id });
				const issueB = await store.createEntity({ kind: "issue", title: "Issue B", parentId: initiative.id });

				// A "decomposes" edge is structural (usually auto-derived from
				// `parentId`), but the `link` command lets it be created as a
				// plain manual annotation too, coexisting with issueB's real
				// structural parent (the initiative, via "tracks") -
				// `reconcileStructuralParent` tolerates this extra row but never
				// reconstructs it, so `listAllRelations` must not drop it either.
				await store.linkEntities({ fromId: issueA.id, toId: issueB.id, relationType: "decomposes" });

				const relations = await store.listAllRelations();
				expect(relations.some((relation) => relation.type === "tracks")).toBe(false);
				expect(relations).toContainEqual(expect.objectContaining({ fromId: issueA.id, toId: issueB.id, type: "decomposes" }));
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: bulk handoffs (${label})`, () => {
		it("lists every handoff and idempotently applies a batch (ISS62/ADR16)", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const handoff = await store.createHandoff({ entityId: initiative.id, body: "Picking up from here." });

				const handoffs = await store.listAllHandoffs();
				expect(handoffs).toContainEqual(expect.objectContaining({ id: handoff.id, entityId: initiative.id, body: "Picking up from here." }));

				const reapplied = await store.applyHandoffs(handoffs);
				expect(reapplied.inserted).toBe(0);

				const foreignHandoff = {
					id: `HANDOFF-${randomUUID()}`,
					entityId: initiative.id,
					initiativeId: initiative.id,
					summary: "",
					body: "A handoff synced in from another store.",
					createdAt: new Date().toISOString()
				};
				const appliedForeign = await store.applyHandoffs([foreignHandoff, ...handoffs]);
				expect(appliedForeign.inserted).toBe(1);

				const afterApply = await store.listAllHandoffs();
				expect(afterApply).toContainEqual(expect.objectContaining({ id: foreignHandoff.id, body: "A handoff synced in from another store." }));
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: bulk contexts (${label})`, () => {
		it("lists every context/term and idempotently applies a batch (ISS62/ADR16)", async () => {
			const store = await openStore();

			try {
				await store.defineContextTerm({ term: "tenant", definition: "A workspace's isolated slice of data." });

				const contexts = await store.listAllContexts();
				const terms = await store.listAllContextTerms();
				expect(contexts).toContainEqual(expect.objectContaining({ key: "default" }));
				expect(terms).toContainEqual(expect.objectContaining({ term: "tenant", definition: "A workspace's isolated slice of data." }));

				const reappliedContexts = await store.applyContexts(contexts);
				const reappliedTerms = await store.applyContextTerms(terms);
				expect(reappliedContexts.applied).toBe(0);
				expect(reappliedTerms.applied).toBe(0);
			} finally {
				await store.close();
			}
		});

		it("converges on whichever side's context/term edit is strictly newer (ISS62/ADR16)", async () => {
			const store = await openStore();

			try {
				await store.defineContextTerm({ term: "tenant", definition: "Original definition." });
				const [original] = await store.listAllContextTerms();

				const staleEdit = { ...original, definition: "A stale edit from before the winning one.", updatedAt: original.createdAt };
				const applyStale = await store.applyContextTerms([staleEdit]);
				expect(applyStale.applied).toBe(0);

				const detailsAfterStale = await store.getContextDetails();
				expect(detailsAfterStale.terms).toContainEqual(expect.objectContaining({ term: "tenant", definition: "Original definition." }));

				const newerEdit = { ...original, definition: "A newer, winning edit.", updatedAt: new Date(Date.now() + 60_000).toISOString() };
				const applyNewer = await store.applyContextTerms([newerEdit]);
				expect(applyNewer.applied).toBe(1);

				const detailsAfterNewer = await store.getContextDetails();
				expect(detailsAfterNewer.terms).toContainEqual(expect.objectContaining({ term: "tenant", definition: "A newer, winning edit." }));
			} finally {
				await store.close();
			}
		});
	});
}
