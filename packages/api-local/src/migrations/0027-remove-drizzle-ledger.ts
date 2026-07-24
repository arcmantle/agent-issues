import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const removeDrizzleLedgerMigration: Migration = {
	id: "0027-remove-drizzle-ledger",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("Drizzle ledger removal migration requires the SQLite dialect.");
		}
		await conn.run(sql`DROP TABLE IF EXISTS __drizzle_migrations`);
	}
};