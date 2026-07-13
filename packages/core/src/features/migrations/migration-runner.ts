import type Database from "better-sqlite3";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { copyFileSync } from "node:fs";

import type { Migration, MigrationConn, MigrationEngine } from "./migration-engine.js";
import { runMigrationSequence } from "./migration-engine.js";

const LEDGER_TABLE = "schema_migrations";

export type { Migration };

export type RunMigrationsOptions = {
	/**
	 * Path to the on-disk database file. When supplied, a timestamped copy is
	 * taken before applying each not-yet-applied migration (ADR13's
	 * pre-migration backup guarantee, folded into ADR43). Omit for in-memory
	 * or throwaway databases where a backup has nothing to protect.
	 */
	dbPath?: string;
};

/**
 * The SQLite-specific half of the ADR43 runner (ISS173/ISS174): a thin
 * `MigrationEngine` adapter around `better-sqlite3`, driven by the one
 * shared `runMigrationSequence` algorithm in `./migration-engine.js`. Drives
 * its transaction boundary with raw `BEGIN`/`COMMIT`/`ROLLBACK` rather than
 * `db.transaction()`, since that helper only supports a synchronous callback
 * and would commit before an `async` callback's awaited steps actually ran -
 * every statement issued inside is still a plain synchronous `better-sqlite3`
 * call either way, so this preserves identical atomicity. The ledger itself
 * still talks to the raw handle directly (not through `MigrationConn`),
 * since the ledger is the engine's own bookkeeping, not migration content.
 */
class SqliteMigrationEngine implements MigrationEngine {
	constructor(
		private readonly db: Database.Database,
		private readonly dbPath?: string
	) {}

	async ensureLedgerTable(): Promise<void> {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
				id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL
			)
		`);
	}

	async isApplied(id: string): Promise<boolean> {
		return this.db.prepare(`SELECT 1 FROM ${LEDGER_TABLE} WHERE id = ?`).get(id) !== undefined;
	}

	async recordApplied(id: string): Promise<void> {
		this.db.prepare(`INSERT INTO ${LEDGER_TABLE} (id, applied_at) VALUES (?, ?)`).run(id, new Date().toISOString());
	}

	async backup(): Promise<void> {
		if (!this.dbPath) {
			return;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		copyFileSync(this.dbPath, `${this.dbPath}.${timestamp}.bak`);
	}

	async withTransaction<T>(_migrationId: string, fn: () => Promise<T>): Promise<T> {
		this.db.exec("BEGIN");
		try {
			const result = await fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

/**
 * Builds the `MigrationConn` every migration module's `up()` receives
 * (ISS174): a thin wrapper around `drizzle-orm/better-sqlite3`'s `run`/`all`,
 * so migration content issues only dialect-agnostic `sql`-tagged-template
 * statements, never a raw `better-sqlite3` call.
 */
function createSqliteMigrationConn(db: Database.Database): MigrationConn {
	const drizzleDb = drizzle(db);
	return {
		dialect: "sqlite",
		async run(query: SQL) {
			drizzleDb.run(query);
		},
		async all<T>(query: SQL) {
			return drizzleDb.all<T>(query);
		}
	};
}

/**
 * Applies every migration in `migrations` that has not yet run against `db`,
 * in order, recording each applied id in a `schema_migrations` ledger so
 * later runs skip it. Replaces drizzle-kit's `__drizzle_migrations` ledger
 * (ADR43). `project_migrations` (schema.ts) itself is NOT replaced by this
 * ledger - it remains a separate, durable `legacyTenantId -> projectId`
 * lookup table consulted by `getProjectMigration`/`resolveCurrentProjectId`,
 * populated exclusively by the automatic one-time sweep
 * (`0008-consolidate-legacy-tenants-backfill.ts`, ISS181) - consolidation is
 * migration-only; there is no manual/on-demand path. What IS ledgered here
 * (ISS180) is the copy/remap operation itself:
 * `buildConsolidateLegacyTenantMigration` gives each discovered legacy
 * tenant its own dynamically-parameterized migration id
 * (`consolidate-legacy-tenant:<tenantId>`), so this same `schema_migrations`
 * table also guarantees that specific copy only ever runs once, without a
 * second bespoke ledger. Delegates its control flow to the shared
 * `runMigrationSequence` (ISS173); this function is only the SQLite driver
 * adapter plus its familiar call shape.
 */
export async function runMigrations(
	db: Database.Database,
	migrations: Migration[],
	options?: RunMigrationsOptions
): Promise<void> {
	const engine = new SqliteMigrationEngine(db, options?.dbPath);
	const conn = createSqliteMigrationConn(db);
	await runMigrationSequence(migrations, engine, conn);
}
