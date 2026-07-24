import { encodeCanonicalReference, isEntityKind, type Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const removeEntityAliasesMigration: Migration = {
	id: "0026-remove-entity-aliases",
	async up(conn) {
		if (conn.dialect !== "sqlite") throw new Error("Entity alias removal migration requires the SQLite dialect.");

		const entities = await conn.all<{ tenant_id: string; id: string; kind: string }>(sql`SELECT tenant_id,id,kind FROM entities`);
		for (const entity of entities) {
			if (!isEntityKind(entity.kind)) throw new Error(`Cannot encode reference for entity ${entity.id} with unknown kind ${entity.kind}.`);
			await conn.run(sql`UPDATE entities SET reference=${encodeCanonicalReference(entity.kind, entity.id)} WHERE tenant_id=${entity.tenant_id} AND id=${entity.id}`);
		}

		const contexts = await conn.all<{ tenant_id: string; id: string }>(sql`SELECT tenant_id,id FROM contexts`);
		for (const context of contexts) {
			await conn.run(sql`UPDATE contexts SET reference=${encodeCanonicalReference("context", context.id)} WHERE tenant_id=${context.tenant_id} AND id=${context.id}`);
		}

		await conn.run(sql`DROP TABLE entity_aliases`);
	}
};
