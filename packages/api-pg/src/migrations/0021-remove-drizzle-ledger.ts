import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const removeDrizzleLedgerMigration: Migration = {
	id: "0021-remove-drizzle-ledger",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Drizzle ledger removal migration requires the PostgreSQL dialect.");
		}
		await conn.run(sql`DROP TABLE IF EXISTS __drizzle_migrations`);
	}
};