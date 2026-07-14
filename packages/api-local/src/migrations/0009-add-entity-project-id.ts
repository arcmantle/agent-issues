import { sql } from "drizzle-orm";

import { assignEntitiesToProjects, type Migration, type MigrationConn } from "@agent-issues/core";

/**
 * Adds the `entities.project_id` column and backfills it for every tenant
 * already present in the database file (ISS166 follow-up). Before this,
 * reads scoped only by `tenant_id`, so the one shared local tenant's many
 * projects (ISS63) all bled into each other - `list`, the site snapshot,
 * orphans, etc. dumped every project's records merged together. `project_id`
 * gives each entity a single, unambiguous owning project so those reads can
 * scope to the workspace's own resolved project (`db.currentProjectId`).
 *
 * The column is nullable: a multi-project tenant's genuinely unattributable
 * leftovers (orphans/parentless ADRs with no sole/`PROJ0` fallback) stay
 * NULL rather than being force-assigned to an arbitrary project. Ongoing
 * writes stamp `project_id` at creation (`createEntity`), and a per-open,
 * per-tenant backfill (`ensureCurrentTenantProjectIds` in `database.ts`)
 * covers tenants onboarded AFTER this one-time, ledgered migration ran.
 */
export const addEntityProjectIdMigration: Migration = {
	id: "0009-add-entity-project-id",
	up: async (conn) => {
		await addProjectIdColumnIfMissing(conn);
		await backfillProjectIds(conn);
	}
};

async function addProjectIdColumnIfMissing(conn: MigrationConn): Promise<void> {
	const columns = await conn.all<{ name: string }>(sql`PRAGMA table_info(entities)`);
	if (columns.some((column) => column.name === "project_id")) {
		return;
	}

	await conn.run(sql`ALTER TABLE entities ADD COLUMN project_id TEXT`);
}

async function backfillProjectIds(conn: MigrationConn): Promise<void> {
	const tenantRows = await conn.all<{ tenant_id: string }>(sql`SELECT DISTINCT tenant_id FROM entities ORDER BY tenant_id`);

	for (const { tenant_id } of tenantRows) {
		const entities = await conn.all<{ id: string; kind: string }>(
			sql`SELECT id, kind FROM entities WHERE tenant_id = ${tenant_id}`
		);
		const relations = await conn.all<{ fromId: string; toId: string; type: string }>(
			sql`SELECT from_id AS "fromId", to_id AS "toId", type FROM relations WHERE tenant_id = ${tenant_id}`
		);

		const assignment = assignEntitiesToProjects(entities, relations);
		for (const [entityId, projectId] of assignment) {
			await conn.run(
				sql`UPDATE entities SET project_id = ${projectId} WHERE tenant_id = ${tenant_id} AND id = ${entityId}`
			);
		}
	}
}
