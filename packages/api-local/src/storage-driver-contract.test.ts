import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runStorageDriverContractSuite } from "@agent-issues/core/storage-driver-contract";
import type { StorageDriver } from "@agent-issues/core";
import { openSqliteStore } from "./sqlite-store.js";

let tempDir: string | null = null;

function openTestStore(): Promise<StorageDriver> {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-"));
	return openSqliteStore(path.join(tempDir, "test.db"), { tenant: "test" }).then((result) => result.store);
}

// Both identities open the same database file and tenant, so the contract's
// separation assertions are about project scoping rather than about two
// unrelated databases.
let contractDir: string | null = null;
function openTestStoreForProject(projectIdentity: string): Promise<StorageDriver> {
	contractDir ??= mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-project-"));
	return openSqliteStore(path.join(contractDir, "test.db"), { tenant: "test", projectIdentity }).then((result) => result.store);
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}

	if (contractDir) {
		rmSync(contractDir, { force: true, recursive: true });
		contractDir = null;
	}
});

runStorageDriverContractSuite({ label: "SqliteStore", openStore: openTestStore, openStoreForProject: openTestStoreForProject });

describe("storage-driver seam: persisted Stable identity (SqliteStore)", () => {
	it("stores the UUID, Canonical reference, and short reference separately", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-identity-"));
		const dbPath = path.join(tempDir, "test.db");
		const store = (await openSqliteStore(dbPath, { tenant: "test" })).store;

		try {
			const created = await store.createEntity({ kind: "initiative", title: "Persisted identity" });
			const inspection = new Database(dbPath, { readonly: true, fileMustExist: true });
			const row = inspection.prepare("SELECT id, reference, short_reference FROM entities WHERE tenant_id = ? AND id = ?").get("test", created.id);
			inspection.close();

			expect(row).toEqual({ id: created.id, reference: created.reference, short_reference: created.shortReference });
		} finally {
			await store.close();
		}
	});
});

describe("storage-driver seam: revision patch hash persistence (SqliteStore)", () => {
	it("stores 32-byte hashes while exposing hexadecimal transitions", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-hashes-"));
		const dbPath = path.join(tempDir, "test.db");
		const store = (await openSqliteStore(dbPath, { tenant: "test" })).store;

		try {
			const created = await store.createEntity({ kind: "initiative", title: "First" });
			await store.updateEntity({ entityId: created.id, title: "Second", expectedRevision: created.revision, expectedContentHash: created.contentHash });

			const inspection = new Database(dbPath, { readonly: true, fileMustExist: true });
			const storedHashes = inspection.prepare(`SELECT typeof(source_hash) AS source_type, length(source_hash) AS source_length, typeof(target_hash) AS target_type, length(target_hash) AS target_length FROM revision_entries`).all();
			inspection.close();
			expect(storedHashes).not.toHaveLength(0);
			expect(storedHashes).toEqual(storedHashes.map(() => ({ source_type: "blob", source_length: 32, target_type: "blob", target_length: 32 })));

			const chain = (await store.exportCanonicalChains()).entities.find((candidate) => candidate.head.id === created.id);
			expect(chain?.deltas.every((delta) => /^[0-9a-f]{64}$/.test(delta.sourceHash) && /^[0-9a-f]{64}$/.test(delta.targetHash))).toBe(true);
			await expect(store.materializeEntityRevision({ entityId: created.id, revision: 1 })).resolves.toMatchObject({ title: "First", headRevision: 2 });
		} finally {
			await store.close();
		}
	});
});

describe("storage-driver seam: tenant administration (SqliteStore)", () => {
	it("lists, renames, and deletes tenants through the seam", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-tenants-"));
		const dbPath = path.join(tempDir, "test.db");
		const alphaStore = (await openSqliteStore(dbPath, { tenant: "alpha-team" })).store;
		const betaStore = (await openSqliteStore(dbPath, { tenant: "beta-team" })).store;

		try {
			const initiative = await alphaStore.createEntity({ kind: "initiative", title: "Alpha" });
			const plan = await alphaStore.createEntity({ kind: "plan", title: "Alpha Plan", parentId: initiative.id });
			await alphaStore.createPlanEntry({ planId: plan.id, role: "question", body: "Does tenant rename preserve entries?" });
			await betaStore.createEntity({ kind: "initiative", title: "Beta" });

			expect((await alphaStore.listTenants()).map((tenant) => tenant.id)).toEqual(["alpha-team", "beta-team"]);

			const renamed = await alphaStore.renameTenant("alpha-team", "renamed-team");
			expect(renamed.renamed).toBe(true);
			expect(renamed.newTenantId).toBe("renamed-team");
			const renamedStore = (await openSqliteStore(dbPath, { tenant: "renamed-team" })).store;
			try {
				expect(await renamedStore.listPlanEntries({ planId: plan.id })).toHaveLength(1);
			} finally {
				await renamedStore.close();
			}

			const deleted = await betaStore.deleteTenant("beta-team");
			expect(deleted.removed).toBe(true);
		} finally {
			await alphaStore.close();
			await betaStore.close();
		}
	});
});
