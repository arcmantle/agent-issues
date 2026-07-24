import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const removeMetadataMigration: Migration = {
	id: "0025-remove-metadata",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Metadata removal requires the PostgreSQL dialect.");
		}
		await conn.run(sql`DROP TABLE IF EXISTS metadata`);
	}
};