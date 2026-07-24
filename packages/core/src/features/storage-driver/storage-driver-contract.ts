import { describe, expect, it } from "vitest";

import { decodeCanonicalReference, deriveMigratedEntityIdentity } from "../entity-store/canonical-reference.js";
import { computeEntityContentHash, DEFAULT_EPIC_ID, EntityConflictError, EntityRevisionError } from "../entity-store/domain.js";
import { computeContextTermContentHash, ContextConflictError, ContextRevisionError, ContextTermConflictError } from "../context/context-types.js";
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

	describe(`storage-driver seam: Stable identity and Canonical reference (${label})`, () => {
		it("creates and resolves an entity by UUID or Canonical reference", async () => {
			const store = await openStore();

			try {
				const created = await store.createEntity({ kind: "initiative", title: "Canonical identity" });

				expect(created).toEqual(expect.objectContaining({
					id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
					reference: expect.stringMatching(/^INIT_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
				}));
				expect(decodeCanonicalReference(created.reference)).toEqual({ kind: "initiative", stableId: created.id });

				const byId = await store.getEntityDetails(created.id);
				const byReference = await store.getEntityDetails(created.reference);
				expect(byId.entity).toMatchObject({ id: created.id, reference: created.reference });
				expect(byReference.entity).toMatchObject({ id: created.id, reference: created.reference });
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: canonical revision patch hashes (${label})`, () => {
		it("exposes lowercase 64-character hexadecimal hashes", async () => {
			const store = await openStore();

			try {
				const created = await store.createEntity({ kind: "initiative", title: "First" });
				await store.updateEntity({ entityId: created.id, title: "Second", expectedRevision: created.revision, expectedContentHash: created.contentHash });
				const chain = (await store.exportCanonicalChains()).entities.find((candidate) => candidate.head.id === created.id);

				expect(chain).toBeDefined();
				expect(chain!.deltas.every((delta) => /^[0-9a-f]{64}$/.test(delta.sourceHash) && /^[0-9a-f]{64}$/.test(delta.targetHash))).toBe(true);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: history diagnostics (${label})`, () => {
		it("measures empty, short, and multi-step chains without charging ordinary reads", async () => {
			const store = await openStore();

			try {
				const initial = await store.getHistoryDiagnostics();
				expect(initial.entity.maxMaterializationDepth).toBe(0);
				expect(initial.context).toMatchObject({ historyBytes: 0, deltaCount: 0, maxChainLength: 0, maxMaterializationDepth: 0, records: [] });
				expect(initial["context-term"]).toMatchObject({ historyBytes: 0, deltaCount: 0, maxChainLength: 0, maxMaterializationDepth: 0, records: [] });

				const entityV1 = await store.createEntity({ kind: "initiative", title: "History diagnostics" });
				const entityV2 = await store.updateEntity({ entityId: entityV1.id, body: "Second", expectedRevision: entityV1.revision, expectedContentHash: entityV1.contentHash });
				await store.updateEntity({ entityId: entityV1.id, body: "Third", expectedRevision: entityV2.revision, expectedContentHash: entityV2.contentHash });
				const contextV1 = await store.upsertContext({ title: "Initial context", summary: "First" });
				await store.upsertContext({ title: "Current context", summary: "Second", expectedRevision: contextV1.context.revision, expectedContentHash: contextV1.context.contentHash });
				const termV1 = await store.defineContextTerm({ term: "Diagnostic", definition: "Initial" });
				await store.defineContextTerm({ term: "Diagnostic", definition: "Current", expectedRevision: termV1.term.revision, expectedContentHash: termV1.term.contentHash });

				const beforeOrdinaryReads = await store.getHistoryDiagnostics();
				expect(beforeOrdinaryReads.entity.deltaCount).toBe(initial.entity.deltaCount + 3);
				expect(beforeOrdinaryReads.entity).toMatchObject({ maxChainLength: 3, maxMaterializationDepth: 0 });
				expect(beforeOrdinaryReads.context).toMatchObject({ deltaCount: 2, maxChainLength: 2, maxMaterializationDepth: 0 });
				expect(beforeOrdinaryReads["context-term"]).toMatchObject({ deltaCount: 2, maxChainLength: 2, maxMaterializationDepth: 0 });
				expect(beforeOrdinaryReads.entity.records).toContainEqual({ recordId: entityV1.id, deltaCount: 3, historyBytes: expect.any(Number) });
				expect(beforeOrdinaryReads.context.records).toContainEqual({ recordId: "default", deltaCount: 2, historyBytes: expect.any(Number) });
				expect(beforeOrdinaryReads["context-term"].records).toContainEqual({ recordId: "default:Diagnostic", deltaCount: 2, historyBytes: expect.any(Number) });
				expect(beforeOrdinaryReads.entity.historyBytes).toBeGreaterThan(0);
				expect(beforeOrdinaryReads.context.historyBytes).toBeGreaterThan(0);
				expect(beforeOrdinaryReads["context-term"].historyBytes).toBeGreaterThan(0);
				for (const kind of ["entity", "context", "context-term"] as const) {
					expect(beforeOrdinaryReads[kind].historyBytes).toBe(beforeOrdinaryReads[kind].records.reduce((total, record) => total + record.historyBytes, 0));
					expect(beforeOrdinaryReads[kind].records.every((record) => record.historyBytes >= 0)).toBe(true);
				}

				await store.listEntities("initiative");
				await store.getEntityDetails(entityV1.id);
				await store.listEntityHistory(entityV1.id);
				await store.listAllRelations();
				await store.listOrphans();
				await store.listProjectAdrs();
				await store.getInitiativeBundle(entityV1.id);
				await store.getDatabaseSnapshot();
				await store.getProjectDiscovery();
				await store.listContexts();
				await store.getContextDetails();
				await store.getContextDirectory();
				await store.queryContextDirectory({ query: "Diagnostic" });
				await expect(store.updateEntity({ entityId: entityV1.id, title: "Stale", expectedRevision: entityV1.revision, expectedContentHash: entityV1.contentHash })).rejects.toBeInstanceOf(EntityConflictError);
				await expect(store.upsertContext({ title: "Stale", summary: "Stale", expectedRevision: contextV1.context.revision, expectedContentHash: contextV1.context.contentHash })).rejects.toBeInstanceOf(ContextConflictError);
				await expect(store.defineContextTerm({ term: "Diagnostic", definition: "Stale", expectedRevision: termV1.term.revision, expectedContentHash: termV1.term.contentHash })).rejects.toBeInstanceOf(ContextTermConflictError);
				expect(await store.getHistoryDiagnostics()).toEqual(beforeOrdinaryReads);

				await store.materializeEntityRevision({ entityId: entityV1.id, revision: 1 });
				await store.materializeContextRevision({ revision: 1 });
				await store.materializeContextTermRevision({ term: "Diagnostic", revision: 1 });
				const afterHistoricalReads = await store.getHistoryDiagnostics();
				expect(afterHistoricalReads.entity.maxMaterializationDepth).toBe(2);
				expect(afterHistoricalReads.context.maxMaterializationDepth).toBe(1);
				expect(afterHistoricalReads["context-term"].maxMaterializationDepth).toBe(1);
			} finally {
				await store.close();
			}
		});

		it("keeps a tiny edit to a large body proportional to the edit", async () => {
			const store = await openStore();

			try {
				const largeBody = "a".repeat(50 * 1024);
				const created = await store.createEntity({ kind: "initiative", title: "Compact history", body: largeBody });
				await store.updateEntity({ entityId: created.id, body: `${largeBody}!`, expectedRevision: created.revision, expectedContentHash: created.contentHash });

				const diagnostics = await store.getHistoryDiagnostics();
				const record = diagnostics.entity.records.find((candidate) => candidate.recordId === created.id);
				expect(record).toBeDefined();
				expect(record!.historyBytes).toBeLessThan(largeBody.length / 100);
				expect(diagnostics.entity.historyBytes).toBe(diagnostics.entity.records.reduce((total, candidate) => total + candidate.historyBytes, 0));
			} finally {
				await store.close();
			}
		});

		it("records restore traversal without counting the appended live head", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.createEntity({ kind: "initiative", title: "Restore diagnostics" });
				const revision2 = await store.updateEntity({ entityId: revision1.id, body: "Second", expectedRevision: revision1.revision, expectedContentHash: revision1.contentHash });
				const revision3 = await store.updateEntity({ entityId: revision1.id, body: "Third", expectedRevision: revision2.revision, expectedContentHash: revision2.contentHash });
				const revision4 = await store.updateEntity({ entityId: revision1.id, body: "Fourth", expectedRevision: revision3.revision, expectedContentHash: revision3.contentHash });

				expect((await store.getHistoryDiagnostics()).entity.maxMaterializationDepth).toBe(0);
				await store.restoreEntityRevision({ entityId: revision1.id, revision: 1, expectedRevision: revision4.revision, expectedContentHash: revision4.contentHash });
				expect((await store.getHistoryDiagnostics()).entity.maxMaterializationDepth).toBe(3);
			} finally {
				await store.close();
			}
		});
	});

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

					expect(handoff).toEqual(expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), reference: expect.stringMatching(/^HO_[0-9A-HJKMNP-TV-Z]{26}$/), kind: "handoff" }));
					await expect(store.materializeEntityRevision({ entityId: handoff.id, revision: 1 })).resolves.toEqual(
						expect.objectContaining({ title: `Resume ${target.kind}`, body: "The migration test is green.", headRevision: 1 })
					);
					expect(await store.listAllRelations()).toEqual(expect.arrayContaining([
						expect.objectContaining({ fromId: handoff.id, toId: target.id, type: "handsOff" })
					]));
				}

				const project = await store.createEntity({ kind: "project", title: "Forbidden project" });
				const version = await store.createEntity({ kind: "version", parentId: project.id, title: "Forbidden version" });
				const standaloneHandoff = await store.createEntity({ kind: "handoff", title: "Standalone handoff" });
				const defaultEpicId = deriveMigratedEntityIdentity("epic", DEFAULT_EPIC_ID).stableId;
				for (const targetId of [project.id, defaultEpicId, version.id, standaloneHandoff.id]) {
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

				const edited = await store.updateEntity({ entityId: created.id, body: "Final body", title: "Final title", expectedRevision: created.revision, expectedContentHash: created.contentHash });
				expect(edited).toEqual(expect.objectContaining({ body: "Final body", title: "Final title" }));
				await expect(store.materializeEntityRevision({ entityId: created.id, revision: 1 })).resolves.toEqual(
					expect.objectContaining({ title: "Created with links", body: "", headRevision: 2 })
				);
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

				const bodyUpdated = await store.setEntityBody({ entityId: issue.id, body: "Detailed plan.", expectedRevision: moved.entity.revision, expectedContentHash: moved.entity.contentHash });
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

		it("records lifecycle revisions in the canonical reverse-delta chain", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				await store.updateEntityStatus({ entityId: initiative.id, status: "active" });

				await expect(store.materializeEntityRevision({ entityId: initiative.id, revision: 1 })).resolves.toEqual(
					expect.objectContaining({ status: "draft", headRevision: 2 })
				);
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

	describe(`storage-driver seam: canonical-chain import (${label})`, () => {
		it("imports new records, strict extensions, contexts, and terms exactly once", async () => {
			const source = await openStore();
			const target = await openStore();
			try {
				const created = await source.createEntity({ kind: "issue", title: "First", body: "First body" });
				const revision2 = await source.updateEntity({ entityId: created.id, title: "Second", body: "Second body", expectedRevision: created.revision, expectedContentHash: created.contentHash });
				await source.updateEntity({ entityId: created.id, title: "Third", body: "Third body", expectedRevision: revision2.revision, expectedContentHash: revision2.contentHash });
				const context = await source.upsertContext({ title: "Language", summary: "Canonical terms." });
				const term = await source.defineContextTerm({ term: "Order", definition: "Initial." });
				await source.defineContextTerm({ term: "Order", definition: "Current.", expectedRevision: term.term.revision, expectedContentHash: term.term.contentHash });

				const bundle = await source.exportCanonicalChains();
				await source.deleteTenant(source.tenantId);
				const imported = await target.importCanonicalChains(bundle);
				expect(imported.entitiesCreated).toContain(created.id);
				expect(imported.contextsCreated).toContain(context.context.key);
				expect(imported.contextTermsCreated).toContain(`${context.context.key}:Order`);
				await expect(target.materializeEntityRevision({ entityId: created.id, revision: 1 })).resolves.toMatchObject({ title: "First", body: "First body", headRevision: 3 });
				await expect(target.materializeEntityRevision({ entityId: created.id, revision: 2 })).resolves.toMatchObject({ title: "Second", body: "Second body", headRevision: 3 });
				await expect(target.materializeContextTermRevision({ term: "Order", revision: 1 })).resolves.toMatchObject({ definition: "Initial.", headRevision: 2 });
				expect(await target.importCanonicalChains(bundle)).toEqual({ entitiesCreated: [], entitiesAdvanced: [], contextsCreated: [], contextsAdvanced: [], contextTermsCreated: [], contextTermsAdvanced: [] });
				const afterImport = await target.createEntity({ kind: "issue", title: "After import" });
				expect(afterImport.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
				expect(afterImport.reference).toMatch(/^ISS_[0-9A-HJKMNP-TV-Z]{26}$/);
				expect(afterImport.id).not.toBe(created.id);
			} finally {
				await source.close();
				await target.close();
			}
		});

		it("rejects a divergent batch atomically with current head metadata", async () => {
			const source = await openStore();
			const target = await openStore();
			try {
				const shared = await source.createEntity({ kind: "issue", title: "Shared" });
				await target.importCanonicalChains(await source.exportCanonicalChains());
				await source.updateEntity({ entityId: shared.id, title: "Source", expectedRevision: shared.revision, expectedContentHash: shared.contentHash });
				await target.updateEntity({ entityId: shared.id, title: "Target", expectedRevision: shared.revision, expectedContentHash: shared.contentHash });
				const newRecord = await source.createEntity({ kind: "issue", title: "Must not import" });
				const bundle = await source.exportCanonicalChains();
				await source.deleteTenant(source.tenantId);
				const signatureBefore = await target.getSnapshotSignature();

				await expect(target.importCanonicalChains(bundle)).rejects.toMatchObject({ name: "SynchronizeConflictError", recordKind: "entity", recordId: shared.id, currentRevision: 2 });
				await expect(target.getEntityDetails(newRecord.id)).rejects.toThrow(/not found/i);
				expect(await target.getSnapshotSignature()).toBe(signatureBefore);
			} finally {
				await source.close();
				await target.close();
			}
		});
	});

	describe(`storage-driver seam: context lifecycle (${label})`, () => {
		it("resolves a nested issue scope through its owning initiative", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
				const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Settlement" });
				const subIssue = await store.createEntity({ kind: "issue", parentId: issue.id, title: "Retries" });

				await store.defineContextTerm({ scopeRef: subIssue.id, term: "Capture", definition: "Confirmed funds." });

				const details = await store.getContextDetails({ scopeRef: initiative.id });
				expect(details.terms.map((term) => term.term)).toContain("Capture");
			} finally {
				await store.close();
			}
		});

		it("context term creation establishes a revision-1 baseline with a canonical content hash", async () => {
			const store = await openStore();

			try {
				const created = await store.defineContextTerm({
					term: "Order",
					definition: "A confirmed purchase.",
					avoid: [" request ", "Request", "Order"]
				});

				expect(created.term.revision).toBe(1);
				expect(created.term.contentHash).toBe(
					computeContextTermContentHash("Order", "A confirmed purchase.", ["request"], false)
				);
			} finally {
				await store.close();
			}
		});

		it("context term edits use CAS and stale writes leave the current head unchanged", async () => {
			const store = await openStore();

			try {
				const created = await store.defineContextTerm({ term: "Order", definition: "Initial definition." });
				const updated = await store.defineContextTerm({
					term: "Order",
					definition: "Updated definition.",
					avoid: ["request"],
					author: "alice",
					expectedRevision: created.term.revision,
					expectedContentHash: created.term.contentHash
				});

				expect(updated.created).toBe(false);
				expect(updated.term.revision).toBe(2);
				expect(updated.term.contentHash).toBe(
					computeContextTermContentHash("Order", "Updated definition.", ["request"], false)
				);

				await expect(store.defineContextTerm({
					term: "Order",
					definition: "Stale definition.",
					expectedRevision: created.term.revision,
					expectedContentHash: created.term.contentHash
				})).rejects.toMatchObject({
					name: "ContextTermConflictError",
					term: "Order",
					currentRevision: updated.term.revision,
					currentContentHash: updated.term.contentHash
				});

				const head = (await store.getContextDetails()).terms.find((candidate) => candidate.term === "Order");
				expect(head).toEqual(updated.term);
			} finally {
				await store.close();
			}
		});

		it("context term removal tombstones the chain and a matching define resurrects it", async () => {
			const store = await openStore();

			try {
				const created = await store.defineContextTerm({ term: "Order", definition: "Initial definition." });
				const forgotten = await store.forgetContextTerm({
					term: "Order",
					author: "alice",
					expectedRevision: created.term.revision,
					expectedContentHash: created.term.contentHash
				});

				expect(forgotten).toMatchObject({ removed: true, currentRevision: 2 });
				expect((await store.getContextDetails()).terms).toEqual([]);

				let tombstoneHead: ContextTermConflictError | undefined;
				try {
					await store.defineContextTerm({ term: "Order", definition: "Restored definition." });
				} catch (error) {
					if (error instanceof ContextTermConflictError) {
						tombstoneHead = error;
					}
				}
				expect(tombstoneHead?.currentRevision).toBe(2);

				const restored = await store.defineContextTerm({
					term: "Order",
					definition: "Restored definition.",
					expectedRevision: tombstoneHead!.currentRevision,
					expectedContentHash: tombstoneHead!.currentContentHash
				});
				expect(restored).toMatchObject({ created: false, term: { revision: 3, definition: "Restored definition." } });
				expect((await store.getContextDetails()).terms).toEqual([restored.term]);
			} finally {
				await store.close();
			}
		});

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

				const forgotten = await store.forgetContextTerm({
					scopeRef: initiative.id,
					term: "storage-driver seam",
					expectedRevision: defineResult.term.revision,
					expectedContentHash: defineResult.term.contentHash
				});
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

	describe(`storage-driver seam: bulk relations (${label})`, () => {
		it("queries bounded entities and selected relation edges", async () => {
			const store = await openStore();

			try {
				const selectedParent = await store.createEntity({ kind: "initiative", title: "Selected parent" });
				const otherParent = await store.createEntity({ kind: "initiative", title: "Other parent" });
				const first = await store.createEntity({ kind: "issue", title: "First", parentId: selectedParent.id });
				const second = await store.createEntity({ kind: "issue", title: "Second", parentId: selectedParent.id, status: "in-progress" });
				await store.createEntity({ kind: "issue", title: "Other", parentId: otherParent.id });
				await store.linkEntities({ fromId: first.id, toId: second.id, relationType: "blocks" });

				const queried = await store.queryEntities({
					kind: "issue",
					statuses: ["todo", "in-progress"],
					parentId: selectedParent.reference,
					limit: 1
				});
				expect(queried.entities).toHaveLength(1);
				expect([first.id, second.id]).toContain(queried.entities[0]?.id);
				expect(queried.total).toBe(2);

				const relations = await store.queryEntityRelations({ entityId: second.id, direction: "incoming", types: ["blocks"] });
				expect(relations.incoming).toEqual([expect.objectContaining({ relationType: "blocks", entity: expect.objectContaining({ id: first.id }) })]);
				expect(relations.outgoing).toEqual([]);
			} finally {
				await store.close();
			}
		});

		it("lists every relation key and idempotently applies a batch (ISS267/ADR55)", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const blocker = await store.createEntity({ kind: "issue", title: "Blocker issue", parentId: initiative.id });
				const blocked = await store.createEntity({ kind: "issue", title: "Blocked issue", parentId: initiative.id });
				await store.linkEntities({ fromId: blocker.id, toId: blocked.id, relationType: "blocks" });

				const relations = await store.listAllRelations();
				expect(relations).toContainEqual(expect.objectContaining({ fromId: initiative.id, toId: blocker.id, type: "tracks" }));
				expect(relations).toContainEqual(expect.objectContaining({ fromId: initiative.id, toId: blocked.id, type: "tracks" }));
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
				expect(relations).toContainEqual(expect.objectContaining({ fromId: initiative.id, toId: issueB.id, type: "tracks" }));
				expect(relations).toContainEqual(expect.objectContaining({ fromId: issueA.id, toId: issueB.id, type: "decomposes" }));
			} finally {
				await store.close();
			}
		});
	});

describe(`storage-driver seam: entity revision and reverse-delta chain (${label})`, () => {
	it("creation establishes revision-1 baseline with a correct content hash", async () => {
		const store = await openStore();

		try {
			const entity = await store.createEntity({ kind: "issue", title: "Initial title", body: "Initial body." });

			expect(entity.revision).toBe(1);
			expect(entity.contentHash).toBe(computeEntityContentHash("Initial title", "Initial body."));

			const details = await store.getEntityDetails(entity.id);
			expect(details.entity.revision).toBe(1);
			expect(details.entity.contentHash).toBe(entity.contentHash);

			const listed = await store.listEntities("issue");
			const found = listed.find((e) => e.id === entity.id);
			expect(found?.revision).toBe(1);
			expect(found?.contentHash).toBe(entity.contentHash);
		} finally {
			await store.close();
		}
	});

	it("a matching edit atomically advances revision and appends a reverse delta", async () => {
		const store = await openStore();

		try {
			const created = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body." });
			expect(created.revision).toBe(1);

			const edited = await store.updateEntity({
				entityId: created.id,
				title: "Updated title",
				body: "Updated body.",
				expectedRevision: created.revision,
				expectedContentHash: created.contentHash
			});

			expect(edited.revision).toBe(2);
			expect(edited.contentHash).toBe(computeEntityContentHash("Updated title", "Updated body."));
			expect(edited.title).toBe("Updated title");
			expect(edited.body).toBe("Updated body.");

			const details = await store.getEntityDetails(edited.id);
			expect(details.entity.revision).toBe(2);
			expect(details.entity.contentHash).toBe(edited.contentHash);

			await expect(store.materializeEntityRevision({ entityId: edited.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ title: "Original title", body: "Original body.", headRevision: 2 })
			);
		} finally {
			await store.close();
		}
	});

	it("content mutations resolve stable entity references", async () => {
		const store = await openStore();

		try {
			const created = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body." });
			const edited = await store.updateEntity({
				entityId: created.reference,
				title: "Updated title",
				expectedRevision: created.revision,
				expectedContentHash: created.contentHash
			});
			const bodyUpdated = await store.setEntityBody({
				entityId: created.reference,
				body: "Updated body.",
				expectedRevision: edited.revision,
				expectedContentHash: edited.contentHash
			});
			const statusUpdated = await store.updateEntityStatus({ entityId: created.reference, status: "in-progress" });
			const restored = await store.restoreEntityRevision({
				entityId: created.reference,
				revision: 1,
				expectedRevision: statusUpdated.entity.revision,
				expectedContentHash: statusUpdated.entity.contentHash
			});
			const deleted = await store.deleteEntity({ entityId: created.reference });

			expect(bodyUpdated).toMatchObject({
				id: created.id,
				reference: created.reference,
				title: "Updated title",
				body: "Updated body.",
				revision: 3
			});
			expect(restored).toMatchObject({ entityId: created.id, title: "Original title", body: "Original body." });
			expect(deleted).toMatchObject({ entity: { id: created.id, reference: created.reference }, removed: true });
			await expect(store.getEntityDetails(created.id)).rejects.toThrow(`Entity not found: ${created.id}`);
		} finally {
			await store.close();
		}
	});

	it("a stale revision rejects with current revision metadata and leaves head unchanged", async () => {
		const store = await openStore();

		try {
			const created = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body." });

			await expect(
				store.updateEntity({
					entityId: created.id,
					title: "Should not apply",
					expectedRevision: 99,
					expectedContentHash: created.contentHash
				})
			).rejects.toThrow(EntityConflictError);

			try {
				await store.updateEntity({
					entityId: created.id,
					title: "Should not apply",
					expectedRevision: 99,
					expectedContentHash: created.contentHash
				});
			} catch (err) {
				expect(err).toBeInstanceOf(EntityConflictError);
				expect((err as EntityConflictError).currentRevision).toBe(1);
				expect((err as EntityConflictError).currentContentHash).toBe(created.contentHash);
			}

			const unchanged = await store.getEntityDetails(created.id);
			expect(unchanged.entity.title).toBe("Original title");
			expect(unchanged.entity.revision).toBe(1);

			await expect(store.materializeEntityRevision({ entityId: created.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ targetRevision: 1, headRevision: 1, title: "Original title", body: "Original body." })
			);
		} finally {
			await store.close();
		}
	});

	it("a stale content hash rejects even when revision matches", async () => {
		const store = await openStore();

		try {
			const created = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body." });

			await expect(
				store.updateEntity({
					entityId: created.id,
					title: "Should not apply",
					expectedRevision: 1,
					expectedContentHash: "wrong-hash-never-valid"
				})
			).rejects.toThrow(EntityConflictError);

			const unchanged = await store.getEntityDetails(created.id);
			expect(unchanged.entity.title).toBe("Original title");
			expect(unchanged.entity.revision).toBe(1);
		} finally {
			await store.close();
		}
	});

	it("setEntityBody also validates revision/hash and appends a delta on match", async () => {
		const store = await openStore();

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Plan", body: "" });
			const issue = await store.createEntity({ kind: "issue", title: "Issue", parentId: initiative.id });

			const updated = await store.setEntityBody({
				entityId: issue.id,
				body: "Detailed plan.",
				expectedRevision: issue.revision,
				expectedContentHash: issue.contentHash
			});

			expect(updated.revision).toBe(2);
			expect(updated.body).toBe("Detailed plan.");
			expect(updated.contentHash).toBe(computeEntityContentHash("Issue", "Detailed plan."));

			await expect(
				store.setEntityBody({
					entityId: issue.id,
					body: "Late arrival.",
					expectedRevision: issue.revision,
					expectedContentHash: issue.contentHash
				})
			).rejects.toThrow(EntityConflictError);

			try {
				await store.setEntityBody({
					entityId: issue.id,
					body: "Late arrival.",
					expectedRevision: issue.revision,
					expectedContentHash: issue.contentHash
				});
			} catch (error) {
				expect(error).toBeInstanceOf(EntityConflictError);
				expect((error as EntityConflictError).currentRevision).toBe(updated.revision);
				expect((error as EntityConflictError).currentContentHash).toBe(updated.contentHash);
			}
		} finally {
			await store.close();
		}
	});

	it("sequential edits build a chain where each revision's hash matches its head content", async () => {
		const store = await openStore();

		try {
			const entity = await store.createEntity({ kind: "issue", title: "v0 title", body: "v0 body." });

			const v2 = await store.updateEntity({
				entityId: entity.id,
				title: "v1 title",
				body: "v1 body.",
				expectedRevision: entity.revision,
				expectedContentHash: entity.contentHash
			});

			const v3 = await store.updateEntity({
				entityId: entity.id,
				title: "v2 title",
				body: "v2 body.",
				expectedRevision: v2.revision,
				expectedContentHash: v2.contentHash
			});

			expect(v2.revision).toBe(2);
			expect(v3.revision).toBe(3);
			expect(v3.contentHash).toBe(computeEntityContentHash("v2 title", "v2 body."));

			await expect(store.materializeEntityRevision({ entityId: entity.id, revision: 1 })).resolves.toEqual(expect.objectContaining({ title: "v0 title", body: "v0 body.", headRevision: 3 }));
			await expect(store.materializeEntityRevision({ entityId: entity.id, revision: 2 })).resolves.toEqual(expect.objectContaining({ title: "v1 title", body: "v1 body.", headRevision: 3 }));
		} finally {
			await store.close();
		}
	});

	it("materializes prior revisions without changing the current head or history", async () => {
		const store = await openStore();

		try {
			const revision1 = await store.createEntity({ kind: "issue", title: "First title", body: "First body." });
			const revision2 = await store.updateEntity({
				entityId: revision1.id,
				title: "Second title",
				body: "Second body.",
				expectedRevision: revision1.revision,
				expectedContentHash: revision1.contentHash
			});
			const revision3 = await store.updateEntity({
				entityId: revision1.id,
				title: "Third title",
				body: "Third body.",
				expectedRevision: revision2.revision,
				expectedContentHash: revision2.contentHash
			});
			const historyBefore = await store.listEntityHistory(revision1.id);

			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 2 })).resolves.toEqual(
				expect.objectContaining({
					entityId: revision1.id,
					targetRevision: 2,
					headRevision: 3,
					title: "Second title",
					body: "Second body.",
					bodySource: "authored"
				})
			);
			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({
					entityId: revision1.id,
					targetRevision: 1,
					headRevision: 3,
					title: "First title",
					body: "First body.",
					bodySource: "authored"
				})
			);

			const headAfter = await store.getEntityDetails(revision1.id);
			expect(headAfter.entity).toEqual(revision3);
			expect(await store.listEntityHistory(revision1.id)).toEqual(historyBefore);
		} finally {
			await store.close();
		}
	});

	it("restores a prior revision as a new head and preserves the existing chain", async () => {
		const store = await openStore();

		try {
			const revision1 = await store.createEntity({ kind: "issue", title: "First title", body: "First body." });
			const revision2 = await store.updateEntity({ entityId: revision1.id, title: "Second title", body: "Second body.", expectedRevision: revision1.revision, expectedContentHash: revision1.contentHash });
			const revision3 = await store.updateEntity({ entityId: revision1.id, title: "Third title", body: "Third body.", expectedRevision: revision2.revision, expectedContentHash: revision2.contentHash });

			const restored = await store.restoreEntityRevision({ entityId: revision1.id, revision: 1, author: "restorer", expectedRevision: revision3.revision, expectedContentHash: revision3.contentHash });
			expect(restored).toEqual(expect.objectContaining({ entityId: revision1.id, targetRevision: 4, headRevision: 4, title: "First title", body: "First body.", author: "restorer", restoredFromRevision: 1 }));
			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 3 })).resolves.toEqual(expect.objectContaining({ title: "Third title", body: "Third body.", restoredFromRevision: null }));
			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 1 })).resolves.toEqual(expect.objectContaining({ title: "First title", body: "First body.", restoredFromRevision: null }));

			await expect(store.restoreEntityRevision({ entityId: revision1.id, revision: 2, expectedRevision: revision3.revision, expectedContentHash: revision3.contentHash })).rejects.toMatchObject({ name: "EntityConflictError", currentRevision: 4 });
			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 4 })).resolves.toEqual(restored);
		} finally {
			await store.close();
		}
	});

	it("restores active and tombstoned lifecycle states through new heads", async () => {
		const store = await openStore();

		try {
			const parent = await store.createEntity({ kind: "initiative", title: "Parent" });
			const created = await store.createEntity({ kind: "issue", title: "Recoverable", parentId: parent.id });
			await store.deleteEntity({ entityId: created.id });

			const active = await store.restoreEntityRevision({
				entityId: created.id,
				revision: 1,
				expectedRevision: 2,
				expectedContentHash: created.contentHash
			});
			expect(active).toEqual(expect.objectContaining({ targetRevision: 3, headRevision: 3, tombstone: false, parentId: parent.id, restoredFromRevision: 1 }));
			await expect(store.getEntityDetails(created.id)).resolves.toEqual(expect.objectContaining({ entity: expect.objectContaining({ id: created.id, revision: 3 }) }));

			const tombstoned = await store.restoreEntityRevision({
				entityId: created.id,
				revision: 2,
				expectedRevision: 3,
				expectedContentHash: computeEntityContentHash(active.title, active.body)
			});
			expect(tombstoned).toEqual(expect.objectContaining({ targetRevision: 4, headRevision: 4, tombstone: true, parentId: null, restoredFromRevision: 2 }));
			await expect(store.getEntityDetails(created.id)).rejects.toThrow(`Entity not found: ${created.id}`);
			await expect(store.materializeEntityRevision({ entityId: created.id, revision: 3 })).resolves.toEqual(expect.objectContaining({ tombstone: false, parentId: parent.id }));
		} finally {
			await store.close();
		}
	});

	it("returns stable errors for missing entities and out-of-range revisions", async () => {
		const store = await openStore();

		try {
			const entity = await store.createEntity({ kind: "issue", title: "Only revision" });
			const requests = [
				{ input: { entityId: "ISS-does-not-exist", revision: 1 }, reason: "entity-not-found" },
				{ input: { entityId: entity.id, revision: 0 }, reason: "revision-out-of-range" },
				{ input: { entityId: entity.id, revision: 2 }, reason: "revision-out-of-range" }
			] as const;

			for (const request of requests) {
				try {
					await store.materializeEntityRevision(request.input);
					expect.unreachable("Expected materialization to reject");
				} catch (error) {
					expect(error).toBeInstanceOf(EntityRevisionError);
					expect((error as EntityRevisionError).reason).toBe(request.reason);
				}
			}
		} finally {
			await store.close();
		}
	});

	it("records status changes in the revision chain", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Lifecycle issue" });
			const statusUpdate = await store.updateEntityStatus({ entityId: issue.id, status: "in-progress" });

			expect(statusUpdate.entity).toEqual(expect.objectContaining({ status: "in-progress", revision: 2 }));
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({
					entityId: issue.id,
					targetRevision: 1,
					headRevision: 2,
					status: "todo"
				})
			);
		} finally {
			await store.close();
		}
	});

	it("records archive status in the revision chain", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Archivable" });
			const archived = await store.archiveEntity({ entityId: issue.id });

			expect(archived.entity).toEqual(expect.objectContaining({ status: "done", revision: 2 }));
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ status: "todo", targetRevision: 1, headRevision: 2 })
			);
		} finally {
			await store.close();
		}
	});

	it("failed lifecycle writes leave the head and revision chain unchanged", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Stable" });
			const historyBefore = await store.listEntityHistory(issue.id);

			await expect(store.updateEntityStatus({ entityId: issue.id, status: "not-a-status" })).rejects.toThrow();
			await expect(store.moveEntity({ entityId: issue.id, newParentId: issue.id })).rejects.toThrow();

			const unchanged = await store.getEntityDetails(issue.id);
			expect(unchanged.entity).toEqual(issue);
			expect(await store.listEntityHistory(issue.id)).toEqual(historyBefore);
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 2 })).rejects.toMatchObject({
				reason: "revision-out-of-range",
				headRevision: 1
			});
		} finally {
			await store.close();
		}
	});

	it("records structural moves in the revision chain", async () => {
		const store = await openStore();

		try {
			const firstParent = await store.createEntity({ kind: "initiative", title: "First parent" });
			const secondParent = await store.createEntity({ kind: "initiative", title: "Second parent" });
			const issue = await store.createEntity({ kind: "issue", title: "Movable", parentId: firstParent.id });
			const moved = await store.moveEntity({ entityId: issue.id, newParentId: secondParent.id });

			expect(moved.entity.revision).toBe(2);
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ parentId: firstParent.id, targetRevision: 1, headRevision: 2 })
			);
		} finally {
			await store.close();
		}
	});

	it("records deletion as a tombstone while hiding the live entity", async () => {
		const store = await openStore();

		try {
			const parent = await store.createEntity({ kind: "initiative", title: "Parent" });
			const issue = await store.createEntity({ kind: "issue", title: "Disposable", parentId: parent.id });
			const deleted = await store.deleteEntity({ entityId: issue.id });

			expect(deleted).toEqual(expect.objectContaining({ removed: true, entity: expect.objectContaining({ id: issue.id }) }));
			await expect(store.getEntityDetails(issue.id)).rejects.toThrow(`Entity not found: ${issue.id}`);
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ targetRevision: 1, headRevision: 2, parentId: parent.id, tombstone: false })
			);
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 2 })).resolves.toEqual(
				expect.objectContaining({ targetRevision: 2, headRevision: 2, tombstone: true })
			);
		} finally {
			await store.close();
		}
	});

	it("listEntityHistory returns full revision facts from the reverse-delta chain", async () => {
		const store = await openStore();

		try {
			const parent = await store.createEntity({ kind: "initiative", title: "Host initiative" });
			const issue = await store.createEntity({ kind: "issue", title: "Initial title", body: "Initial body." });

			// revision 2: title/body edit
			const rev2 = await store.updateEntity({
				entityId: issue.id,
				title: "Revised title",
				body: "Revised body.",
				author: "alice",
				expectedRevision: 1,
				expectedContentHash: issue.contentHash
			});

			// revision 3: status change
			await store.updateEntityStatus({ entityId: issue.id, status: "in-progress", author: "bob" });

			// revision 4: structural move
			await store.moveEntity({ entityId: issue.id, newParentId: parent.id, author: "charlie" });

			// revision 5: tombstone (no author param on deleteEntity)
			await store.deleteEntity({ entityId: issue.id });

			// revision 6: restore revision 1
			await store.restoreEntityRevision({
				entityId: issue.id,
				revision: 1,
				author: "dave",
				expectedRevision: 5,
				expectedContentHash: rev2.contentHash
			});

			const history = await store.listEntityHistory(issue.id);

			expect(history).toHaveLength(6);

			// Entries are oldest-first
			expect(history[0]).toMatchObject({
				entityId: issue.id,
				version: 1,
				title: "Initial title",
				body: "Initial body.",
				bodySource: "authored",
				status: "todo",
				parentId: null
			});
			expect(history[1]).toMatchObject({
				entityId: issue.id,
				version: 2,
				title: "Revised title",
				body: "Revised body.",
				bodySource: "authored",
				status: "todo",
				parentId: null,
				author: "alice"
			});
			expect(history[2]).toMatchObject({
				entityId: issue.id,
				version: 3,
				title: "Revised title",
				body: "Revised body.",
				status: "in-progress",
				parentId: null,
				author: "bob"
			});
			expect(history[3]).toMatchObject({
				entityId: issue.id,
				version: 4,
				status: "in-progress",
				parentId: parent.id,
				author: "charlie"
			});
			expect(history[4]).toMatchObject({
				entityId: issue.id,
				version: 5,
				status: "in-progress",
				parentId: null
			});
			expect(history[5]).toMatchObject({
				entityId: issue.id,
				version: 6,
				title: "Initial title",
				body: "Initial body.",
				status: "todo",
				parentId: null,
				author: "dave"
			});

			// IDs are real UUIDs from revision_entries — not fabricated ephemeral strings
			const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			expect(history.every((entry) => UUID_RE.test(entry.id))).toBe(true);
			// History is stable across repeated calls
			expect(await store.listEntityHistory(issue.id)).toEqual(history);
		} finally {
			await store.close();
		}
	});
});

	describe(`storage-driver seam: context revision history (${label})`, () => {
		it("creation establishes a revision-1 baseline with a correct content hash", async () => {
			const store = await openStore();

			try {
				const created = await store.upsertContext({ title: "Initial title", summary: "Initial summary" });

				expect(created.context.revision).toBe(1);
				expect(created.context.contentHash).toMatch(/^[0-9a-f]{64}$/);
				expect(created.context.exists).toBe(true);

				const direct = await store.getContextDetails();
				expect(direct.context.revision).toBe(1);
				expect(direct.context.contentHash).toBe(created.context.contentHash);
			} finally {
				await store.close();
			}
		});

		it("a matching update atomically advances to revision 2 and appends a reverse delta", async () => {
			const store = await openStore();

			try {
				const created = await store.upsertContext({ title: "Initial title", summary: "Initial summary" });
				expect(created.context.revision).toBe(1);

				const updated = await store.upsertContext({
					title: "Updated title",
					summary: "Updated summary",
					expectedRevision: created.context.revision,
					expectedContentHash: created.context.contentHash
				});

				expect(updated.context.revision).toBe(2);
				expect(updated.context.contentHash).not.toBe(created.context.contentHash);
				expect(updated.context.title).toBe("Updated title");
				expect(updated.context.summary).toBe("Updated summary");
				expect(updated.context.exists).toBe(true);
			} finally {
				await store.close();
			}
		});

		it("a stale revision rejects with ContextConflictError and leaves head unchanged", async () => {
			const store = await openStore();

			try {
				const created = await store.upsertContext({ title: "Initial title", summary: "Initial summary" });
				const updated = await store.upsertContext({
					title: "Updated title",
					summary: "Updated summary",
					expectedRevision: created.context.revision,
					expectedContentHash: created.context.contentHash
				});
				expect(updated.context.revision).toBe(2);

				// Stale: still at revision 1
				let caughtError: unknown;
				try {
					await store.upsertContext({
						title: "Stale title",
						summary: "Stale summary",
						expectedRevision: created.context.revision,
						expectedContentHash: created.context.contentHash
					});
					expect.unreachable("Expected ContextConflictError to be thrown");
				} catch (err) {
					caughtError = err;
				}

				expect(caughtError).toBeInstanceOf(ContextConflictError);
				expect((caughtError as ContextConflictError).contextKey).toBeDefined();
				expect((caughtError as ContextConflictError).currentRevision).toBe(2);

				// Head unchanged after rejected write
				const head = await store.getContextDetails();
				expect(head.context.revision).toBe(2);
				expect(head.context.title).toBe("Updated title");
			} finally {
				await store.close();
			}
		});

		it("an existing context cannot be updated without its expected head", async () => {
			const store = await openStore();

			try {
				const created = await store.upsertContext({ title: "Initial title", summary: "Initial summary" });

				await expect(store.upsertContext({ title: "Unguarded title", summary: "Unguarded summary" })).rejects.toMatchObject({
					name: "ContextConflictError",
					currentRevision: created.context.revision,
					currentContentHash: created.context.contentHash
				});

				await expect(store.getContextDetails()).resolves.toEqual(created);
			} finally {
				await store.close();
			}
		});

		it("direct reads (list/search/getContextDetails) remain direct and do not require revision tracking", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
				await store.upsertContext({ scopeRef: initiative.id, title: "Payments context", summary: "Payments glossary" });

				const details = await store.getContextDetails({ scopeRef: initiative.id });
				expect(details.context.revision).toBe(1);

				const list = await store.listContexts();
				const found = list.contexts.find((item) => item.context.scopeEntityId === initiative.id);
				expect(found?.context.revision).toBe(1);

				const directory = await store.getContextDirectory();
				const initiative_context = directory.initiatives.find((ctx) => ctx.context.scopeEntityId === initiative.id);
				expect(initiative_context?.context.revision).toBe(1);
			} finally {
				await store.close();
			}
		});

		it("author and timestamp are recorded on the delta and the context head preserves ordering", async () => {
			const store = await openStore();

			try {
				const r1 = await store.upsertContext({ title: "v1", summary: "s1", author: "alice" });
				const r2 = await store.upsertContext({
					title: "v2",
					summary: "s2",
					author: "bob",
					expectedRevision: r1.context.revision,
					expectedContentHash: r1.context.contentHash
				});

				expect(r2.context.revision).toBe(2);
				expect(r2.context.updatedAt).not.toBeNull();
				expect(r2.context.updatedAt! >= r1.context.updatedAt!).toBe(true);
			} finally {
				await store.close();
			}
		});

		it("materializes context revisions without changing the current head", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.upsertContext({ title: "First", summary: "First summary.", author: "alice" });
				const revision2 = await store.upsertContext({ title: "Second", summary: "Second summary.", author: "bob", expectedRevision: revision1.context.revision, expectedContentHash: revision1.context.contentHash });
				await store.upsertContext({ title: "Third", summary: "Third summary.", author: "carol", expectedRevision: revision2.context.revision, expectedContentHash: revision2.context.contentHash });

				await expect(store.materializeContextRevision({ revision: 2 })).resolves.toEqual(expect.objectContaining({ contextKey: revision1.context.key, targetRevision: 2, headRevision: 3, title: "Second", summary: "Second summary.", author: "bob" }));
				await expect(store.materializeContextRevision({ revision: 1 })).resolves.toEqual(expect.objectContaining({ targetRevision: 1, headRevision: 3, title: "First", summary: "First summary.", author: "alice" }));
				await expect(store.getContextDetails()).resolves.toEqual(expect.objectContaining({ context: expect.objectContaining({ revision: 3, title: "Third" }) }));
			} finally {
				await store.close();
			}
		});

		it("materializes context terms before and at their tombstone", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.defineContextTerm({ term: "Order", definition: "First definition.", author: "alice" });
				const revision2 = await store.defineContextTerm({ term: "Order", definition: "Second definition.", avoid: ["purchase"], author: "bob", expectedRevision: revision1.term.revision, expectedContentHash: revision1.term.contentHash });
				await store.forgetContextTerm({ term: "Order", author: "carol", expectedRevision: revision2.term.revision, expectedContentHash: revision2.term.contentHash });

				await expect(store.getContextDetails()).resolves.toEqual(expect.objectContaining({ terms: [] }));
				await expect(store.materializeContextTermRevision({ term: "Order", revision: 1 })).resolves.toEqual(expect.objectContaining({ targetRevision: 1, headRevision: 3, definition: "First definition.", avoid: [], tombstone: false, author: "alice" }));
				await expect(store.materializeContextTermRevision({ term: "Order", revision: 2 })).resolves.toEqual(expect.objectContaining({ targetRevision: 2, headRevision: 3, definition: "Second definition.", avoid: ["purchase"], tombstone: false, author: "bob" }));
				await expect(store.materializeContextTermRevision({ term: "Order", revision: 3 })).resolves.toEqual(expect.objectContaining({ targetRevision: 3, headRevision: 3, tombstone: true, author: "carol" }));
			} finally {
				await store.close();
			}
		});

		it("restores context revisions as new heads without replacing newer history", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.upsertContext({ title: "First", summary: "First summary.", author: "alice" });
				const revision2 = await store.upsertContext({ title: "Second", summary: "Second summary.", author: "bob", expectedRevision: revision1.context.revision, expectedContentHash: revision1.context.contentHash });
				const revision3 = await store.upsertContext({ title: "Third", summary: "Third summary.", author: "carol", expectedRevision: revision2.context.revision, expectedContentHash: revision2.context.contentHash });

				const restored = await store.restoreContextRevision({ revision: 1, author: "restorer", expectedRevision: revision3.context.revision, expectedContentHash: revision3.context.contentHash });
				expect(restored).toEqual(expect.objectContaining({ targetRevision: 4, headRevision: 4, title: "First", summary: "First summary.", author: "restorer", restoredFromRevision: 1 }));
				await expect(store.materializeContextRevision({ revision: 3 })).resolves.toEqual(expect.objectContaining({ title: "Third", restoredFromRevision: null }));
				await expect(store.restoreContextRevision({ revision: 2, expectedRevision: 3, expectedContentHash: revision3.context.contentHash })).rejects.toMatchObject({ name: "ContextConflictError", currentRevision: 4 });
			} finally {
				await store.close();
			}
		});

		it("restores removed context terms on their existing revision chain", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.defineContextTerm({ term: "Order", definition: "First definition.", author: "alice" });
				const revision2 = await store.defineContextTerm({ term: "Order", definition: "Second definition.", avoid: ["purchase"], author: "bob", expectedRevision: revision1.term.revision, expectedContentHash: revision1.term.contentHash });
				const removed = await store.forgetContextTerm({ term: "Order", author: "carol", expectedRevision: revision2.term.revision, expectedContentHash: revision2.term.contentHash });

				const restored = await store.restoreContextTermRevision({ term: "Order", revision: 1, author: "restorer", expectedRevision: removed.currentRevision!, expectedContentHash: removed.currentContentHash! });
				expect(restored).toEqual(expect.objectContaining({ targetRevision: 4, headRevision: 4, definition: "First definition.", avoid: [], tombstone: false, author: "restorer", restoredFromRevision: 1 }));
				await expect(store.getContextDetails()).resolves.toEqual(expect.objectContaining({ terms: [expect.objectContaining({ term: "Order", revision: 4 })] }));
				await expect(store.materializeContextTermRevision({ term: "Order", revision: 3 })).resolves.toEqual(expect.objectContaining({ tombstone: true, restoredFromRevision: null }));
				await expect(store.restoreContextTermRevision({ term: "Order", revision: 2, expectedRevision: 3, expectedContentHash: removed.currentContentHash! })).rejects.toMatchObject({ name: "ContextTermConflictError", currentRevision: 4 });
			} finally {
				await store.close();
			}
		});

		it("returns typed errors for missing records and invalid context revisions", async () => {
			const store = await openStore();

			try {
				await expect(store.materializeContextRevision({ revision: 1 })).rejects.toBeInstanceOf(ContextRevisionError);
				await store.upsertContext({ title: "Only", summary: "Only revision." });
				await expect(store.materializeContextRevision({ revision: 2 })).rejects.toMatchObject({ name: "ContextRevisionError", reason: "revision-out-of-range", headRevision: 1 });
				await expect(store.materializeContextTermRevision({ term: "Missing", revision: 1 })).rejects.toMatchObject({ name: "ContextRevisionError", reason: "term-not-found" });
			} finally {
				await store.close();
			}
		});
	});
}