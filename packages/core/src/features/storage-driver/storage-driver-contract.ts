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

	describe(`storage-driver seam: project discovery (${label})`, () => {
		it("returns an empty visible-project list for a sentinel-only tenant without changing its snapshot signature", async () => {
			const store = await openStore();

			try {
				const before = await store.getSnapshotSignature();
				const discovery = await store.getProjectDiscovery();
				const after = await store.getSnapshotSignature();

				expect(discovery).toEqual({ kind: "available", projects: [] });
				expect(after).toBe(before);
			} finally {
				await store.close();
			}
		});

		it("returns visible projects with isolated epic, initiative, and completion rollups", async () => {
			const store = await openStore();

			try {
				const firstProject = await store.createEntity({ kind: "project", title: "First project" });
				const firstEpic = await store.createEntity({ kind: "epic", title: "First epic", parentId: firstProject.id });
				const completedInitiative = await store.createEntity({ kind: "initiative", title: "Completed", parentId: firstEpic.id });
				await store.updateEntityStatus({ entityId: completedInitiative.id, status: "done" });
				await store.createEntity({ kind: "initiative", title: "Open", parentId: firstEpic.id });
				const secondProject = await store.createEntity({ kind: "project", title: "Second project" });
				await store.createEntity({ kind: "epic", title: "Second epic", parentId: secondProject.id });

				const discovery = await store.getProjectDiscovery();

				expect(discovery).toEqual({
					kind: "available",
					projects: expect.arrayContaining([
						expect.objectContaining({
							project: expect.objectContaining({ id: firstProject.id }),
							epicCount: 1,
							initiativeCount: 2,
							completedInitiativeCount: 1
						}),
						expect.objectContaining({
							project: expect.objectContaining({ id: secondProject.id }),
							epicCount: 1,
							initiativeCount: 0,
							completedInitiativeCount: 0
						})
					])
				});
			} finally {
				await store.close();
			}
		});

		it("returns a typed unavailable result for a missing project without changing its snapshot signature", async () => {
			const store = await openStore();

			try {
				const before = await store.getSnapshotSignature();
				const discovery = await store.getProjectDiscovery({ projectId: "PROJ404" });
				const after = await store.getSnapshotSignature();

				expect(discovery).toEqual({ kind: "unavailable" });
				expect(after).toBe(before);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: project-scoped snapshots (${label})`, () => {
		it("returns only the selected project's snapshot data and rejects unavailable projects", async () => {
			const store = await openStore();

			try {
				const selectedProject = await store.createEntity({ kind: "project", title: "Selected project" });
				const selectedEpic = await store.createEntity({ kind: "epic", title: "Selected epic", parentId: selectedProject.id });
				const selectedInitiative = await store.createEntity({ kind: "initiative", title: "Selected initiative", parentId: selectedEpic.id });
				const selectedIssue = await store.createEntity({ kind: "issue", title: "Selected issue", parentId: selectedInitiative.id });
				const selectedAdr = await store.createEntity({ kind: "adr", title: "Selected ADR", parentId: selectedInitiative.id });
				await store.upsertContext({ scopeRef: selectedInitiative.id, title: "Selected context", summary: "Only selected project" });

				const otherProject = await store.createEntity({ kind: "project", title: "Other project" });
				const otherEpic = await store.createEntity({ kind: "epic", title: "Other epic", parentId: otherProject.id });
				const otherInitiative = await store.createEntity({ kind: "initiative", title: "Other initiative", parentId: otherEpic.id });
				const otherIssue = await store.createEntity({ kind: "issue", title: "Other issue", parentId: otherInitiative.id });
				const otherAdr = await store.createEntity({ kind: "adr", title: "Other ADR", parentId: otherInitiative.id });
				const otherPrd = await store.createEntity({ kind: "prd", title: "Other PRD", parentId: otherInitiative.id });
				const otherStory = await store.createEntity({ kind: "userStory", title: "Other story", parentId: otherPrd.id });
				await store.linkEntities({ fromId: selectedIssue.id, toId: otherIssue.id, relationType: "blocks" });
				await store.upsertContext({ scopeRef: otherInitiative.id, title: "Other context", summary: "Must not leak" });

				const snapshot = await store.getDatabaseSnapshot({ projectId: selectedProject.id });
				expect(snapshot).toEqual(expect.objectContaining({ kind: "available" }));
				if (snapshot.kind !== "available") {
					return;
				}

				const selectedIds = [selectedProject.id, selectedEpic.id, selectedInitiative.id, selectedIssue.id, selectedAdr.id];
				const otherIds = [otherProject.id, otherEpic.id, otherInitiative.id, otherIssue.id, otherAdr.id];
				expect(snapshot.snapshot.entities.map((entity) => entity.id)).toEqual(expect.arrayContaining(selectedIds));
				expect(snapshot.snapshot.entities.map((entity) => entity.id)).not.toEqual(expect.arrayContaining(otherIds));
				expect(snapshot.snapshot.relations.every((relation) => !otherIds.includes(relation.fromId) && !otherIds.includes(relation.toId))).toBe(true);
				expect(snapshot.snapshot.projectAdrs).toEqual([]);
				expect(snapshot.snapshot.initiatives.map((bundle) => bundle.initiative.id)).toEqual([selectedInitiative.id]);
				expect(snapshot.snapshot.initiatives[0]?.userStories.map((story) => story.id)).not.toContain(otherStory.id);
				expect(snapshot.snapshot.initiatives[0]?.blockerLinks).toEqual([]);
				expect(snapshot.snapshot.contexts.initiatives.map((context) => context.context.scopeEntityId)).toEqual([selectedInitiative.id]);

				expect(await store.getDatabaseSnapshot({ projectId: "PROJ404" })).toEqual({ kind: "unavailable" });
			} finally {
				await store.close();
			}
		});
	});

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

		it("creates a handoff as an ordinary entity with handsOff links only to ADR50 focus kinds", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Initiative focus" });
				const prd = await store.createEntity({ kind: "prd", parentId: initiative.id, title: "PRD focus" });
				const story = await store.createEntity({ kind: "userStory", parentId: prd.id, title: "Story focus" });
				const adr = await store.createEntity({ kind: "adr", parentId: initiative.id, title: "ADR focus" });
				const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Issue focus" });
				const allowedTargets = [initiative, prd, story, adr, issue];

				for (const target of allowedTargets) {
					const handoff = await store.createEntity({
						kind: "handoff",
						title: `Resume ${target.kind}`,
						body: "The migration test is green.",
						links: [{ relationType: "handsOff", targetId: target.id }]
					});

					expect(handoff).toEqual(expect.objectContaining({ id: expect.stringMatching(/^HO\d+$/), kind: "handoff" }));
					expect(await store.listEntityHistory(handoff.id)).toEqual([
						expect.objectContaining({ title: `Resume ${target.kind}`, body: "The migration test is green." })
					]);
					expect(await store.listAllRelations()).toEqual(expect.arrayContaining([
						expect.objectContaining({ fromId: handoff.id, toId: target.id, type: "handsOff" })
					]));
				}

				const project = await store.createEntity({ kind: "project", title: "Forbidden project" });
				const version = await store.createEntity({ kind: "version", parentId: project.id, title: "Forbidden version" });
				const standaloneHandoff = await store.createEntity({ kind: "handoff", title: "Standalone handoff" });
				for (const targetId of [project.id, "EPIC0", version.id, standaloneHandoff.id]) {
					await expect(store.createEntity({
						kind: "handoff",
						title: "Invalid target",
						links: [{ relationType: "handsOff", targetId }]
					})).rejects.toThrow("not allowed");
				}
			} finally {
				await store.close();
			}
		});

		it("creates initial links atomically and records one complete revision for a generic edit", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const blocker = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Blocking issue" });
				const dependency = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Dependency issue" });
				const created = await store.createEntity({
					kind: "issue",
					parentId: initiative.id,
					title: "Created with links",
					links: [
						{ relationType: "blocks", targetId: blocker.id },
						{ relationType: "blocks", targetId: dependency.id }
					]
				});

				expect(await store.listAllRelations()).toEqual(expect.arrayContaining([
					expect.objectContaining({ fromId: created.id, toId: blocker.id, type: "blocks" }),
					expect.objectContaining({ fromId: created.id, toId: dependency.id, type: "blocks" })
				]));
				const relationsBeforeRejectedCreate = await store.listAllRelations();
				const signatureBeforeRejectedCreate = await store.getSnapshotSignature();

				await expect(store.createEntity({
					kind: "issue",
					parentId: initiative.id,
					title: "Rejected atomically",
					links: [
						{ relationType: "blocks", targetId: blocker.id },
						{ relationType: "blocks", targetId: "ISS404" }
					]
				})).rejects.toThrow("Entity not found: ISS404");
				expect((await store.listEntities("issue")).map((entity) => entity.title)).not.toContain("Rejected atomically");
				expect(await store.listAllRelations()).toEqual(relationsBeforeRejectedCreate);
				expect(await store.getSnapshotSignature()).toBe(signatureBeforeRejectedCreate);

				const edited = await store.updateEntity({ entityId: created.id, body: "Final body", title: "Final title" });
				expect(edited).toEqual(expect.objectContaining({ body: "Final body", title: "Final title" }));
				const history = await store.listEntityHistory(created.id);
				expect(history).toHaveLength(2);
				expect(history[1]).toEqual(expect.objectContaining({ body: "Final body", title: "Final title" }));
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

		it("lists entities, orphans, project ADRs, and a complete initiative bundle through the seam", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const prd = await store.createEntity({ kind: "prd", title: "PRD", parentId: initiative.id });
				const story = await store.createEntity({ kind: "userStory", title: "Story", parentId: prd.id });
				const issue = await store.createEntity({ kind: "issue", title: "Fixing issue", parentId: initiative.id });
				const subIssue = await store.createEntity({ kind: "issue", title: "Sub issue", parentId: initiative.id });
				const blocker = await store.createEntity({ kind: "issue", title: "Blocker", parentId: initiative.id });
				const adr = await store.createEntity({ kind: "adr", title: "ADR", parentId: initiative.id });
				const orphanAdr = await store.createEntity({ kind: "adr", title: "Project-scoped ADR" });
				await store.linkEntities({ fromId: issue.id, toId: story.id, relationType: "fixes" });
				await store.linkEntities({ fromId: issue.id, toId: subIssue.id, relationType: "decomposes" });
				await store.linkEntities({ fromId: blocker.id, toId: issue.id, relationType: "blocks" });
				await store.linkEntities({ fromId: adr.id, toId: issue.id, relationType: "constrains" });

				expect((await store.listEntities("initiative")).map((entity) => entity.id)).toContain(initiative.id);
				expect((await store.listOrphans()).map((entity) => entity.id)).not.toContain(orphanAdr.id);
				expect((await store.listProjectAdrs()).map((entity) => entity.id)).toContain(orphanAdr.id);

				const snapshot = await store.getDatabaseSnapshot();
				expect(snapshot.entities.map((entity) => entity.id)).toContain(initiative.id);

				const bundle = await store.getInitiativeBundle(initiative.id);
				expect(bundle.prds.map((entity) => entity.id)).toEqual([prd.id]);
				expect(bundle.userStories.map((entity) => entity.id)).toEqual([story.id]);
				expect(bundle.issues.map((entity) => entity.id).sort()).toEqual([blocker.id, issue.id, subIssue.id].sort());
				expect(bundle.adrs.map((entity) => entity.id)).toEqual([adr.id]);
				expect(bundle.fixLinks).toEqual([{ issue: expect.objectContaining({ id: issue.id }), userStory: expect.objectContaining({ id: story.id }) }]);
				expect(bundle.subIssueLinks).toEqual([{ parent: expect.objectContaining({ id: issue.id }), issue: expect.objectContaining({ id: subIssue.id }) }]);
				expect(bundle.blockerLinks).toEqual([{ source: expect.objectContaining({ id: blocker.id }), target: expect.objectContaining({ id: issue.id }) }]);
				expect(bundle.constrainsLinks).toEqual([{ adr: expect.objectContaining({ id: adr.id }), issue: expect.objectContaining({ id: issue.id }) }]);
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
