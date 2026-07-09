import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { StorageDriver } from "./storage-driver.js";
import { openSqliteStore } from "./sqlite-store.js";

let tempDir: string | null = null;

function openTestStore(): StorageDriver {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-"));
	return openSqliteStore(path.join(tempDir, "test.db"), { tenant: "test" }).store;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("storage-driver seam: entity lifecycle", () => {
	it("creates an entity and reads it back through the async seam", async () => {
		const store = openTestStore();

		try {
			const created = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
			const details = await store.getEntityDetails(created.id);

			expect(details.entity).toEqual(created);
		} finally {
			await store.close();
		}
	});

	it("updates status, links, moves, and archives an entity through the seam", async () => {
		const store = openTestStore();

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
		const store = openTestStore();

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
			expect(bundle.issues.map((entity) => entity.id)).toEqual(
				expect.arrayContaining([expect.stringMatching(/^ISS/)])
			);
		} finally {
			await store.close();
		}
	});
});

describe("storage-driver seam: handoff lifecycle", () => {
	it("creates, updates, lists, and deletes a handoff through the seam", async () => {
		const store = openTestStore();

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

describe("storage-driver seam: context lifecycle", () => {
	it("defines, reads, queries, and forgets a context term through the seam", async () => {
		const store = openTestStore();

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

describe("storage-driver seam: tenant administration", () => {
	it("lists, renames, and deletes tenants through the seam", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-tenants-"));
		const dbPath = path.join(tempDir, "test.db");
		const alphaStore = openSqliteStore(dbPath, { tenant: "alpha-team" }).store;
		const betaStore = openSqliteStore(dbPath, { tenant: "beta-team" }).store;

		try {
			await alphaStore.createEntity({ kind: "initiative", title: "Alpha" });
			await betaStore.createEntity({ kind: "initiative", title: "Beta" });

			expect((await alphaStore.listTenants()).map((tenant) => tenant.id)).toEqual(["alpha-team", "beta-team"]);

			const renamed = await alphaStore.renameTenant("alpha-team", "renamed-team");
			expect(renamed.renamed).toBe(true);
			expect(renamed.newTenantId).toBe("renamed-team");

			const deleted = await betaStore.deleteTenant("beta-team");
			expect(deleted.removed).toBe(true);
		} finally {
			await alphaStore.close();
			await betaStore.close();
		}
	});
});

describe("storage-driver seam: lifecycle", () => {
	it("releases the underlying connection on close", async () => {
		const store = openTestStore();
		await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });

		await store.close();

		await expect(store.listEntities("initiative")).rejects.toThrow();
	});
});
