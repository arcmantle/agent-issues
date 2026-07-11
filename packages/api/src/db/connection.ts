import { migrations } from "../migrations/index.js";
import { runMigrations } from "./migration-runner.js";
import { Pool, type PoolClient } from "pg";

export type PgConnectionOptions = {
	/**
	 * Plain Postgres connection string (ADR21): `postgres://user:pass@host:port/db`.
	 * Used for local development against docker-compose Postgres today; a
	 * production deployment supplies an Azure Managed Identity-derived
	 * connection string the same way (ADR12's "pure deployment/infra
	 * config" framing) - no application-code branching between the two.
	 */
	connectionString: string;
};

export function createPgPool(options: PgConnectionOptions): Pool {
	return new Pool({ connectionString: options.connectionString });
}

/** Runs pending ADR43-runner migrations (schema + RLS policies) against the pool's target database. */
export async function migratePgDatabase(pool: Pool): Promise<void> {
	await runMigrations(pool, migrations);
}

/**
 * The single place `SET LOCAL app.tenant_id` is applied (ADR9, ADR13): opens
 * a transaction, scopes it to `tenantId` for RLS, runs `fn`, then commits.
 * Every `PgStore` operation goes through this so tenant isolation can never
 * be forgotten on any individual query path.
 */
export async function withTenantTransaction<T>(
	pool: Pool,
	tenantId: string,
	fn: (client: PoolClient) => Promise<T>
): Promise<T> {
	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
