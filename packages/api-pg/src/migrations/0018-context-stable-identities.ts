import { deriveMigratedContextIdentity, encodeContextRecordKey } from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const contextStableIdentitiesMigration: Migration = {
	id: "0018-context-stable-identities",
	async up(conn) {
		if (conn.dialect !== "postgres") throw new Error("PostgreSQL context Stable identity migration requires the PostgreSQL dialect.");
		await conn.run(sql`ALTER TABLE contexts ADD COLUMN id TEXT`);
		await conn.run(sql`ALTER TABLE contexts ADD COLUMN stable_id UUID`);
		const contexts = await conn.all<{ tenant_id: string; key: string }>(sql`SELECT tenant_id, key FROM contexts`);
		for (const context of contexts) {
			const identity = deriveMigratedContextIdentity(context.key);
			await conn.run(sql`UPDATE revision_patch_entries SET record_key=${encodeContextRecordKey(identity.stableId)}
				WHERE tenant_id=${context.tenant_id} AND record_kind='context' AND record_key=${encodeContextRecordKey(context.key)}`);
			await conn.run(sql`UPDATE contexts SET id=${identity.reference}, stable_id=${identity.stableId}::uuid
				WHERE tenant_id=${context.tenant_id} AND key=${context.key}`);
		}
		await conn.run(sql`ALTER TABLE contexts ALTER COLUMN id SET NOT NULL`);
		await conn.run(sql`ALTER TABLE contexts ALTER COLUMN stable_id SET NOT NULL`);
		await conn.run(sql`CREATE UNIQUE INDEX contexts_tenant_id_idx ON contexts (tenant_id, id)`);
		await conn.run(sql`CREATE UNIQUE INDEX contexts_tenant_stable_id_idx ON contexts (tenant_id, stable_id)`);
	}
};