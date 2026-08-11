import { and, eq } from "drizzle-orm";

import { entities } from "../schema.js";
import { openSqliteConnection, type SqliteConnection } from "./sqlite-connection.js";

export type SqliteInternalConnection = SqliteConnection;

export type SqliteExecutor = Pick<
	SqliteConnection,
	"drizzle" | "tenantId" | "currentProjectId" | "dbPath" | "close"
>;

export function createSqliteExecutor(dbPath: string): SqliteInternalConnection {
	return openSqliteConnection(dbPath);
}

export function getSqliteEntityOrThrow(executor: SqliteExecutor, entityId: string) {
	const row = resolveSqliteEntity(executor, entityId);

	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return row;
}

export function resolveSqliteEntity(executor: SqliteExecutor, entityId: string, includeTombstone: boolean = false) {
	const livePredicate = includeTombstone ? undefined : eq(entities.tombstone, false);
	let row = executor.drizzle
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, entityId), livePredicate))
		.get();

	if (!row) {
		row = executor.drizzle
			.select()
			.from(entities)
			.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.reference, entityId), livePredicate))
			.get();
	}

	return row;
}