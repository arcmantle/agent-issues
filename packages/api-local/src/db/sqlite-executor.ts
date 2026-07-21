import { and, eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { entities, schema } from "../schema.js";
import type { DatabaseHandle } from "./database.js";

const drizzleByDatabase = new WeakMap<DatabaseHandle, BetterSQLite3Database<typeof schema>>();

export type SqliteExecutor = {
	db: DatabaseHandle;
	drizzle: BetterSQLite3Database<typeof schema>;
	tenantId: string;
	currentProjectId: string;
	transaction<T>(fn: () => T): T;
};

export function createSqliteExecutor(db: DatabaseHandle): SqliteExecutor {
	const drizzleDatabase = drizzle(db, { schema });
	drizzleByDatabase.set(db, drizzleDatabase);

	return {
		db,
		drizzle: drizzleDatabase,
		get tenantId() {
			return db.tenantId;
		},
		get currentProjectId() {
			return db.currentProjectId;
		},
		set currentProjectId(currentProjectId: string) {
			db.currentProjectId = currentProjectId;
		},
		transaction<T>(fn: () => T): T {
			return db.transaction(fn)();
		}
	};
}

export function getSqliteDrizzle(db: DatabaseHandle): BetterSQLite3Database<typeof schema> {
	const drizzleDatabase = drizzleByDatabase.get(db);
	if (!drizzleDatabase) {
		throw new Error("Missing Drizzle SQLite executor for database handle.");
	}

	return drizzleDatabase;
}

export function getSqliteEntityOrThrow(executor: SqliteExecutor, entityId: string) {
	const row = executor.drizzle
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, executor.db.tenantId), eq(entities.id, entityId), eq(entities.tombstone, false)))
		.get();

	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return row;
}