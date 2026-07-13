import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openSqliteStore } from "./sqlite-store.js";
import type { SqliteStore } from "./sqlite-store.js";
import { synchronizeStores } from "@agent-issues/core";

// `synchronizeStores` only depends on the `StorageDriver` interface, so two
// `SqliteStore`s stand in for "local" and "cloud" here - proving the
// orchestration logic (union, resolve-latest, converge both sides) without
// needing a real HTTP round-trip, matching how the merge algorithm (ISS58)
// is tested purely. The underlying seam primitives this composes
// (`listAllHistoryEntries`/`applyHistoryEntries`/`applyResolvedFacts`) are
// separately proven against every real backend by `storage-driver-contract.ts`.
describe("synchronizeStores (ISS59/ADR15, ADR16)", () => {
	let localDirectory: string;
	let cloudDirectory: string;
	let local: SqliteStore;
	let cloud: SqliteStore;

	beforeEach(async () => {
		localDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-synchronize-local-"));
		cloudDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-synchronize-cloud-"));
		// Explicit, distinct `dbPath`s: `openSqliteStore(undefined, ...)` always
		// resolves to the one shared per-user db file (only the tenant slug
		// varies by cwd) - two real backends never share physical storage like
		// that, so the test doubles must not either.
		local = (await openSqliteStore(path.join(localDirectory, "local.db"), { currentWorkingDirectory: localDirectory })).store;
		cloud = (await openSqliteStore(path.join(cloudDirectory, "cloud.db"), { currentWorkingDirectory: cloudDirectory })).store;
	});

	afterEach(async () => {
		await local.close();
		await cloud.close();
		rmSync(localDirectory, { recursive: true, force: true });
		rmSync(cloudDirectory, { recursive: true, force: true });
	});

	it("is a true no-op when both sides are already converged", async () => {
		await synchronizeStores(local, cloud);

		const summary = await synchronizeStores(local, cloud);

		expect(summary).toEqual({
			entriesAppliedToLocal: 0,
			entriesAppliedToCloud: 0,
			entitiesCreatedLocal: [],
			entitiesUpdatedLocal: [],
			entitiesCreatedCloud: [],
			entitiesUpdatedCloud: [],
			concurrentEditConflicts: 0,
			relationsAppliedToLocal: 0,
			relationsAppliedToCloud: 0,
			handoffsAppliedToLocal: 0,
			handoffsAppliedToCloud: 0,
			contextsAppliedToLocal: 0,
			contextsAppliedToCloud: 0,
			contextTermsAppliedToLocal: 0,
			contextTermsAppliedToCloud: 0
		});
	});

	it("propagates a brand-new entity created on one side to the other", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await local.createEntity({ kind: "issue", title: "Local-only issue", parentId: initiative.id });

		const summary = await synchronizeStores(local, cloud);

		expect(summary.entitiesCreatedCloud).toContain(issue.id);
		expect(summary.entitiesCreatedCloud).toContain(initiative.id);

		const cloudDetails = await cloud.getEntityDetails(issue.id);
		expect(cloudDetails.entity.title).toBe("Local-only issue");

		const localSnapshot = await local.getDatabaseSnapshot();
		const cloudSnapshot = await cloud.getDatabaseSnapshot();
		const factsOf = (entities: typeof localSnapshot.entities, id: string) => {
			const entity = entities.find((candidate) => candidate.id === id);
			return entity && { title: entity.title, body: entity.body, status: entity.status };
		};
		expect(factsOf(cloudSnapshot.entities, issue.id)).toEqual(factsOf(localSnapshot.entities, issue.id));
	});

	it("propagates a non-structural relation (e.g. 'blocks') created on one side to the other, without duplicating it on repeated runs", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const blocker = await local.createEntity({ kind: "issue", title: "Blocker issue", parentId: initiative.id });
		const blocked = await local.createEntity({ kind: "issue", title: "Blocked issue", parentId: initiative.id });
		await synchronizeStores(local, cloud);

		await local.linkEntities({ fromId: blocker.id, toId: blocked.id, relationType: "blocks" });

		const summary = await synchronizeStores(local, cloud);
		expect(summary.relationsAppliedToCloud).toBe(1);
		expect(summary.relationsAppliedToLocal).toBe(0);

		const cloudRelations = await cloud.listAllRelations();
		expect(cloudRelations).toContainEqual(expect.objectContaining({ fromId: blocker.id, toId: blocked.id, type: "blocks" }));

		const repeatSummary = await synchronizeStores(local, cloud);
		expect(repeatSummary.relationsAppliedToLocal).toBe(0);
		expect(repeatSummary.relationsAppliedToCloud).toBe(0);
	});

	it("resolves a concurrent same-record edit deterministically and preserves the losing edit in history on both sides", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await synchronizeStores(local, cloud);

		await local.setEntityBody({ entityId: initiative.id, body: "Edited locally, first" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		await cloud.setEntityBody({ entityId: initiative.id, body: "Edited in the cloud, second" });

		const summary = await synchronizeStores(local, cloud);

		expect(summary.concurrentEditConflicts).toBe(1);

		const localDetails = await local.getEntityDetails(initiative.id);
		const cloudDetails = await cloud.getEntityDetails(initiative.id);
		expect(localDetails.entity.body).toBe("Edited in the cloud, second");
		expect(cloudDetails.entity.body).toBe("Edited in the cloud, second");

		const localHistory = await local.listEntityHistory(initiative.id);
		const cloudHistory = await cloud.listEntityHistory(initiative.id);
		expect(localHistory.some((entry) => entry.body === "Edited locally, first")).toBe(true);
		expect(cloudHistory.some((entry) => entry.body === "Edited locally, first")).toBe(true);
	});

	it("repeated synchronize after a resolved conflict applies no new writes (the conflict itself stays reported, since it's a permanent fact of history)", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await synchronizeStores(local, cloud);
		await local.setEntityBody({ entityId: initiative.id, body: "Edited locally, first" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		await cloud.setEntityBody({ entityId: initiative.id, body: "Edited in the cloud, second" });
		await synchronizeStores(local, cloud);

		const summary = await synchronizeStores(local, cloud);

		expect(summary.entriesAppliedToLocal).toBe(0);
		expect(summary.entriesAppliedToCloud).toBe(0);
		expect(summary.entitiesUpdatedLocal).toEqual([]);
		expect(summary.entitiesUpdatedCloud).toEqual([]);
	});

	it("propagates a handoff created on one side to the other, without duplicating it on repeated runs (ISS62)", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await synchronizeStores(local, cloud);

		const handoff = await local.createHandoff({ entityId: initiative.id, body: "Picking up from here." });

		const summary = await synchronizeStores(local, cloud);
		expect(summary.handoffsAppliedToCloud).toBe(1);
		expect(summary.handoffsAppliedToLocal).toBe(0);

		const cloudHandoffs = await cloud.listAllHandoffs();
		expect(cloudHandoffs).toContainEqual(expect.objectContaining({ id: handoff.id, entityId: initiative.id, body: "Picking up from here." }));

		const repeatSummary = await synchronizeStores(local, cloud);
		expect(repeatSummary.handoffsAppliedToLocal).toBe(0);
		expect(repeatSummary.handoffsAppliedToCloud).toBe(0);
	});

	it("propagates a context/term created on one side and converges on whichever side's edit is newer (ISS62)", async () => {
		await local.defineContextTerm({ term: "tenant", definition: "A workspace's isolated slice of data." });
		await synchronizeStores(local, cloud);

		const cloudTermsAfterFirstSync = await cloud.getContextDetails();
		expect(cloudTermsAfterFirstSync.terms).toContainEqual(
			expect.objectContaining({ term: "tenant", definition: "A workspace's isolated slice of data." })
		);

		// Edit the same term on the cloud side, strictly later, so its
		// `updatedAt` wins the next sync's last-writer-wins merge.
		await new Promise((resolve) => setTimeout(resolve, 5));
		await cloud.defineContextTerm({ term: "tenant", definition: "Cloud's newer definition." });

		const summary = await synchronizeStores(local, cloud);
		expect(summary.contextTermsAppliedToLocal).toBeGreaterThan(0);

		const localDetails = await local.getContextDetails();
		const cloudDetails = await cloud.getContextDetails();
		expect(localDetails.terms).toContainEqual(expect.objectContaining({ term: "tenant", definition: "Cloud's newer definition." }));
		expect(cloudDetails.terms).toContainEqual(expect.objectContaining({ term: "tenant", definition: "Cloud's newer definition." }));

		const repeatSummary = await synchronizeStores(local, cloud);
		expect(repeatSummary.contextsAppliedToLocal).toBe(0);
		expect(repeatSummary.contextsAppliedToCloud).toBe(0);
		expect(repeatSummary.contextTermsAppliedToLocal).toBe(0);
		expect(repeatSummary.contextTermsAppliedToCloud).toBe(0);
	});
});
