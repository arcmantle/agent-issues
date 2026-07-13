import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runStorageDriverContractSuite } from "@agent-issues/core/storage-driver-contract";
import type { StorageDriver } from "@agent-issues/core";
import { openSqliteStore } from "./sqlite-store.js";

let tempDir: string | null = null;

function openTestStore(): Promise<StorageDriver> {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-"));
	return openSqliteStore(path.join(tempDir, "test.db"), { tenant: "test" }).then((result) => result.store);
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

runStorageDriverContractSuite({ label: "SqliteStore", openStore: openTestStore });

describe("storage-driver seam: tenant administration (SqliteStore)", () => {
	it("lists, renames, and deletes tenants through the seam", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-tenants-"));
		const dbPath = path.join(tempDir, "test.db");
		// Both opens deliberately keep "alpha-team"/"beta-team" un-migrated
		// (skipTenantConsolidation) - the automatic sweep now runs on every
		// open (ISS178), and this test's whole point is exercising
		// listTenants/renameTenant/deleteTenant against two genuinely-
		// separate, still-unmerged tenants coexisting in one file.
		const alphaStore = (await openSqliteStore(dbPath, { skipTenantConsolidation: true, tenant: "alpha-team" })).store;
		const betaStore = (await openSqliteStore(dbPath, { skipTenantConsolidation: true, tenant: "beta-team" })).store;

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
