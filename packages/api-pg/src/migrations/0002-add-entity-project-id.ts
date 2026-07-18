import { assignEntitiesToProjects, type MigrationConn } from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const addEntityProjectIdMigration: Migration = {
	id: "0002-add-entity-project-id",
	up: async (conn) => {
		const columns = await conn.all<{ column_name: string }>(
			sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entities'`
		);
		if (!columns.some((column) => column.column_name === "project_id")) {
			await conn.run(sql`ALTER TABLE entities ADD COLUMN project_id TEXT`);
		}

		const tenantRows = await conn.all<{ tenant_id: string }>(sql`SELECT DISTINCT tenant_id FROM entities ORDER BY tenant_id`);
		for (const { tenant_id: tenantId } of tenantRows) {
			const entities = await conn.all<{ id: string; kind: string }>(
				sql`SELECT id, kind FROM entities WHERE tenant_id = ${tenantId}`
			);
			const relations = await conn.all<{ fromId: string; toId: string; type: string }>(
				sql`SELECT from_id AS "fromId", to_id AS "toId", type FROM relations WHERE tenant_id = ${tenantId}`
			);

			for (const [entityId, projectId] of assignEntitiesToProjects(entities, relations)) {
				await conn.run(sql`UPDATE entities SET project_id = ${projectId} WHERE tenant_id = ${tenantId} AND id = ${entityId}`);
			}
		}
	}
};