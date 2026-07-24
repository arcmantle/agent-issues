import { sql } from "drizzle-orm";

import type { Migration } from "@agent-issues/core";

export const removeMetadataMigration: Migration = {
	id: "0031-remove-metadata",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("Metadata removal requires the SQLite dialect.");
		}
		await conn.run(sql`DROP TABLE IF EXISTS metadata`);
	}
};