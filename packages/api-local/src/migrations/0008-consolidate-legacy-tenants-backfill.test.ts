import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migration-runner.js";
import { resolveWellKnownLocalTenantId } from "@agent-issues/core";
import { migrations as coreMigrations } from "./index.js";
import { buildConsolidateLegacyTenantsBackfillMigration } from "./0008-consolidate-legacy-tenants-backfill.js";

const dbs: Database.Database[] = [];

afterEach(() => {
	for (const db of dbs.splice(0)) {
		db.close();
	}
});

// Only the schema-establishing migrations (0000-0003), not the bootstrap
// backfills (0004-0007) - this migration's own contract is independent of
// those, and running them too would manufacture PROJ0/EPIC0 sentinels/
// counters/history for every seeded tenant before the test gets to assert
// on this migration's own effects.
const schemaMigrations = coreMigrations.slice(0, 4);
const targetTenantId = resolveWellKnownLocalTenantId();

async function freshDatabase(): Promise<Database.Database> {
	const db = new Database(":memory:");
	dbs.push(db);
	await runMigrations(db, schemaMigrations);
	return db;
}

function seedEntity(db: Database.Database, tenantId: string, id: string, kind: string, title: string): void {
	db.prepare(
		`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'active', '', 'authored', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
	).run(tenantId, id, kind, title);
}

function seedCounters(db: Database.Database, tenantId: string): void {
	const kinds = ["project", "epic", "version", "initiative", "prd", "userStory", "adr", "issue", "handoff"];
	for (const kind of kinds) {
		db.prepare(`INSERT INTO counters (tenant_id, kind, next_value) VALUES (?, ?, 1)`).run(tenantId, kind);
	}
}

describe("buildConsolidateLegacyTenantsBackfillMigration (ISS181)", () => {
	it("folds every pre-existing legacy tenant into its own project under the well-known tenant, in one pass", async () => {
		const db = await freshDatabase();
		seedCounters(db, "legacy-team-a");
		seedEntity(db, "legacy-team-a", "ISS1", "issue", "Team A issue");
		seedCounters(db, "legacy-team-b");
		seedEntity(db, "legacy-team-b", "ISS1", "issue", "Team B issue");

		const migration = buildConsolidateLegacyTenantsBackfillMigration({ excludeTenantId: targetTenantId });
		await runMigrations(db, [migration]);

		const remainingLegacyRows = db
			.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id IN ('legacy-team-a', 'legacy-team-b')`)
			.get() as { count: number };
		expect(remainingLegacyRows.count).toBe(0);

		const projects = db
			.prepare(`SELECT title FROM entities WHERE tenant_id = ? AND kind = 'project' ORDER BY title`)
			.all(targetTenantId) as Array<{ title: string }>;
		expect(projects.length).toBe(2);

		const migrations = db
			.prepare(`SELECT legacy_tenant_id AS legacyTenantId FROM project_migrations WHERE tenant_id = ? ORDER BY legacy_tenant_id`)
			.all(targetTenantId) as Array<{ legacyTenantId: string }>;
		expect(migrations).toEqual([{ legacyTenantId: "legacy-team-a" }, { legacyTenantId: "legacy-team-b" }]);
	});

	it("excludes the well-known tenant itself, even though it too has counters rows", async () => {
		const db = await freshDatabase();
		seedCounters(db, targetTenantId);
		seedEntity(db, targetTenantId, "ISS1", "issue", "Already-well-known issue");

		const migration = buildConsolidateLegacyTenantsBackfillMigration({ excludeTenantId: targetTenantId });
		await runMigrations(db, [migration]);

		const projectMigrations = db.prepare(`SELECT COUNT(*) AS count FROM project_migrations`).get() as { count: number };
		expect(projectMigrations.count).toBe(0);
		const untouchedIssue = db.prepare(`SELECT title FROM entities WHERE tenant_id = ? AND id = 'ISS1'`).get(targetTenantId) as {
			title: string;
		};
		expect(untouchedIssue.title).toBe("Already-well-known issue");
	});

	it("excludes the requesting open's own tenant (excludeTenantId), even if it looks like a legacy tenant", async () => {
		const db = await freshDatabase();
		seedCounters(db, "current-open-tenant");
		seedEntity(db, "current-open-tenant", "ISS1", "issue", "Currently open tenant's own issue");

		const migration = buildConsolidateLegacyTenantsBackfillMigration({ excludeTenantId: "current-open-tenant" });
		await runMigrations(db, [migration]);

		const projectMigrations = db.prepare(`SELECT COUNT(*) AS count FROM project_migrations`).get() as { count: number };
		expect(projectMigrations.count).toBe(0);
		const untouchedIssue = db.prepare(`SELECT title FROM entities WHERE tenant_id = 'current-open-tenant' AND id = 'ISS1'`).get() as {
			title: string;
		};
		expect(untouchedIssue.title).toBe("Currently open tenant's own issue");
	});

	it("is ledger-idempotent: re-running the exact same migration a second time is a no-op", async () => {
		const db = await freshDatabase();
		seedCounters(db, "legacy-team");
		seedEntity(db, "legacy-team", "ISS1", "issue", "Legacy issue");

		const migration = buildConsolidateLegacyTenantsBackfillMigration({ excludeTenantId: targetTenantId });
		await runMigrations(db, [migration]);

		const entityCountBefore = (
			db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?`).get(targetTenantId) as { count: number }
		).count;

		// A second run against the same ledger (schema_migrations already has
		// "0008-consolidate-legacy-tenants-backfill" recorded) must be a pure
		// no-op - no re-processing, even though this second call passes a
		// DIFFERENT excludeTenantId than the first.
		const secondMigration = buildConsolidateLegacyTenantsBackfillMigration({ excludeTenantId: "some-other-tenant" });
		await runMigrations(db, [secondMigration]);

		const entityCountAfter = (
			db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?`).get(targetTenantId) as { count: number }
		).count;
		expect(entityCountAfter).toBe(entityCountBefore);
	});

	it("never picks up a tenant created AFTER this migration has already run (ISS181's key guarantee)", async () => {
		const db = await freshDatabase();
		seedCounters(db, "legacy-team");
		seedEntity(db, "legacy-team", "ISS1", "issue", "Legacy issue");

		const migration = buildConsolidateLegacyTenantsBackfillMigration({ excludeTenantId: targetTenantId });
		await runMigrations(db, [migration]);

		// A brand-new --tenant created after the historical sweep already ran
		// once - this must stay a real, durable tenant forever, never folded
		// in, even though a second `runMigrations` call happens to run again
		// (ledger-idempotent no-op, per the previous test).
		seedCounters(db, "new-durable-tenant");
		seedEntity(db, "new-durable-tenant", "ISS1", "issue", "Brand-new durable tenant's own issue");

		const secondMigration = buildConsolidateLegacyTenantsBackfillMigration({ excludeTenantId: targetTenantId });
		await runMigrations(db, [secondMigration]);

		const stillPresent = db.prepare(`SELECT title FROM entities WHERE tenant_id = 'new-durable-tenant' AND id = 'ISS1'`).get() as {
			title: string;
		};
		expect(stillPresent.title).toBe("Brand-new durable tenant's own issue");
		const foldedIntoProject = db.prepare(`SELECT COUNT(*) AS count FROM project_migrations WHERE legacy_tenant_id = 'new-durable-tenant'`).get() as {
			count: number;
		};
		expect(foldedIntoProject.count).toBe(0);
	});
});
