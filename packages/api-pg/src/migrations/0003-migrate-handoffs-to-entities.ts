import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const migrateHandoffsToEntitiesMigration: Migration = {
	id: "0003-migrate-handoffs-to-entities",
	up: async (conn) => {
		const tables = await conn.all<{ table_name: string }>(
			sql`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'handoffs'`
		);
		if (tables.length === 0) {
			return;
		}

		await conn.run(sql`
			INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, project_id, created_at, updated_at)
			SELECT handoffs.tenant_id,
				handoffs.id,
				'handoff',
				CASE WHEN btrim(handoffs.summary) = '' THEN 'Handoff ' || handoffs.id ELSE handoffs.summary END,
				'active',
				handoffs.body,
				'authored',
				focus.project_id,
				handoffs.created_at,
				handoffs.created_at
			FROM handoffs
			JOIN entities AS focus ON focus.tenant_id = handoffs.tenant_id AND focus.id = handoffs.entity_id
		`);
		await conn.run(sql`
			INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
			SELECT tenant_id, id, entity_id, 'handsOff', created_at FROM handoffs
		`);
		await conn.run(sql`
			INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			SELECT md5(random()::text || clock_timestamp()::text || id),
				tenant_id,
				id,
				1,
				'system',
				CASE WHEN btrim(summary) = '' THEN 'Handoff ' || id ELSE summary END,
				body,
				'authored',
				'active',
				NULL,
				created_at
			FROM handoffs
		`);
		await conn.run(sql`
			INSERT INTO counters (tenant_id, kind, next_value)
			SELECT tenant_id, 'handoff', MAX(substring(id FROM 3)::integer) + 1
			FROM handoffs
			WHERE id ~ '^HO[0-9]+$'
			GROUP BY tenant_id
			ON CONFLICT (tenant_id, kind) DO UPDATE SET next_value = GREATEST(counters.next_value, EXCLUDED.next_value)
		`);
		await conn.run(sql`DROP TABLE handoffs`);
	}
};