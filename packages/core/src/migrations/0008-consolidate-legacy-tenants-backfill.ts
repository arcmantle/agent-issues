import { sql } from "drizzle-orm";

import { formatTenantDisplayName } from "../domain.js";
import type { Migration, MigrationConn } from "../migration-engine.js";
import { resolveWellKnownLocalTenantId } from "../tenant-identity.js";
import { consolidateLegacyTenantData } from "./0007-consolidate-legacy-tenant.js";

/**
 * Every tenant id present in `counters` other than the well-known merge
 * target and `excludeTenantId` (whichever tenant the one open that actually
 * executes this migration requested - left untouched so this migration can
 * never pull the rug out from under the very command that happens to
 * trigger it), excluding ones `project_migrations` already recorded as
 * folded in. Mirrors the pre-ISS181 `findUnmigratedLegacyTenantIds` query
 * (`database.ts`) that this migration replaces - reading from `counters`
 * rather than a UNION across the six tenant-scoped tables (ISS179), since
 * every onboarded tenant already has `counters` rows and that table only
 * ever grows with tenant count, not tracked-data volume.
 */
async function listOutstandingLegacyTenantIds(
	conn: MigrationConn,
	targetTenantId: string,
	excludeTenantId: string
): Promise<string[]> {
	const rows = await conn.all<{ tenant_id: string }>(sql`
		SELECT DISTINCT counters.tenant_id AS tenant_id
		FROM counters
		WHERE counters.tenant_id != ${targetTenantId}
		AND counters.tenant_id != ${excludeTenantId}
		AND NOT EXISTS (
			SELECT 1 FROM project_migrations
			WHERE project_migrations.tenant_id = ${targetTenantId}
			AND project_migrations.legacy_tenant_id = counters.tenant_id
		)
		ORDER BY counters.tenant_id
	`);

	return rows.map((row) => row.tenant_id);
}

/**
 * Builds the one-time, ledgered migration (ISS181) that folds every
 * pre-ISS63 per-folder legacy tenant already present in the database file
 * into its own `project` entity under the well-known local tenant, in one
 * pass, using a FIXED id (`buildConsolidateLegacyTenantsBackfillMigration`'s
 * one parameter, `excludeTenantId`, does not vary this migration's own `id`
 * - it only tailors which tenant the one execution that actually applies it
 * leaves untouched) so `schema_migrations` records it as done, forever,
 * exactly once for the whole database file - never re-run, and never
 * re-checked on any later open.
 *
 * Replaces `consolidateAllLegacyTenants` (ISS63/ISS178/ISS179), which used
 * to re-run this same discovery query on EVERY ordinary `ensureDatabase`
 * open. Per explicit direction (ISS181): once this migration has folded in
 * every tenant that already existed before it first ran, a subsequently
 * created `--tenant <name>` is a real, durable tenant from that point
 * forward - it is never automatically swept into a project. Folding a
 * tenant created after this point into a project remains possible, but only
 * on request, via the explicit `consolidate-tenant` admin command
 * (`database.ts`'s `consolidateTenantIntoProject`,
 * `buildConsolidateLegacyTenantMigration` in `./0007-consolidate-legacy-tenant.js`).
 */
export function buildConsolidateLegacyTenantsBackfillMigration(params: { excludeTenantId: string }): Migration {
	return {
		id: "0008-consolidate-legacy-tenants-backfill",
		up: async (conn) => {
			const targetTenantId = resolveWellKnownLocalTenantId();
			const legacyTenantIds = await listOutstandingLegacyTenantIds(conn, targetTenantId, params.excludeTenantId);

			for (const legacyTenantId of legacyTenantIds) {
				await consolidateLegacyTenantData(conn, {
					legacyTenantId,
					projectTitle: formatTenantDisplayName(legacyTenantId) || legacyTenantId,
					targetTenantId
				});
			}
		}
	};
}
