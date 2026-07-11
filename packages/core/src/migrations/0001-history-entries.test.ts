import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { historyEntriesMigration } from "./0001-history-entries.js";

type ColumnShape = { name: string; type: string; notnull: number; dflt: string | null; pk: number };

function describeTable(db: Database.Database, table: string): ColumnShape[] {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
		type: string;
		notnull: number;
		dflt_value: string | null;
		pk: number;
	}>;
	return columns.map((column) => ({
		name: column.name,
		type: column.type.toUpperCase(),
		notnull: column.notnull,
		dflt: column.dflt_value,
		pk: column.pk
	}));
}

describe("historyEntriesMigration", () => {
	it("creates the history_entries table matching the live schema on a fresh install", async () => {
		const db = new Database(":memory:");

		await runMigrations(db, [baselineV7Migration, historyEntriesMigration]);

		expect(describeTable(db, "history_entries")).toEqual([
			{ name: "id", type: "TEXT", notnull: 1, dflt: null, pk: 1 },
			{ name: "tenant_id", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "entity_id", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "version", type: "INTEGER", notnull: 1, dflt: null, pk: 0 },
			{ name: "author", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "title", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "body", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "body_source", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "status", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
			{ name: "parent_id", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
			{ name: "created_at", type: "TEXT", notnull: 1, dflt: null, pk: 0 }
		]);
	});
});
