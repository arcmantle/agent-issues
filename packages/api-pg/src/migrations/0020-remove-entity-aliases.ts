import { encodeCanonicalReference, isEntityKind } from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const removeEntityAliasesMigration: Migration = {
	id: "0020-remove-entity-aliases",
	async up(conn) {
		if (conn.dialect !== "postgres") throw new Error("Entity alias removal migration requires the PostgreSQL dialect.");

		const entities = await conn.all<{ tenant_id: string; id: string; kind: string }>(sql`SELECT tenant_id,id::text,kind FROM entities`);
		for (const entity of entities) {
			if (!isEntityKind(entity.kind)) throw new Error(`Cannot encode reference for entity ${entity.id} with unknown kind ${entity.kind}.`);
			await conn.run(sql`UPDATE entities SET reference=${encodeCanonicalReference(entity.kind, entity.id)} WHERE tenant_id=${entity.tenant_id} AND id=${entity.id}::uuid`);
		}

		const contexts = await conn.all<{ tenant_id: string; id: string }>(sql`SELECT tenant_id,id::text FROM contexts`);
		for (const context of contexts) {
			await conn.run(sql`UPDATE contexts SET reference=${encodeCanonicalReference("context", context.id)} WHERE tenant_id=${context.tenant_id} AND id=${context.id}::uuid`);
		}

		await conn.run(sql`DROP TABLE entity_aliases`);
	}
};
