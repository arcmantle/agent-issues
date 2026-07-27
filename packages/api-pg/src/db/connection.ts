import { formatUnsupportedSourceProfile } from "@agent-issues/core";
import { finalBaselineMigration } from "../migrations/final-baseline.js";
import { transformLegacyPostgresV7 } from "../migrations/legacy-v7-direct.js";
import { schema } from "../schema.js";
import { runMigrationsWithClient } from "./migration-runner.js";
import { inspectPgSourceProfile } from "./source-profile.js";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
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

export type QueryExecutor = Pick<PoolClient, "query">;
export type TenantExecutor = NodePgDatabase<typeof schema> & QueryExecutor & {
	/**
	 * The tenant this transaction is scoped to (ADR9's `SET LOCAL
	 * app.tenant_id`), carried on the executor so the free functions below
	 * read it the same way local's free functions read `SqliteConnection.tenantId`
	 * instead of taking it as a parameter.
	 */
	tenantId: string;
	/**
	 * The client-resolved project identity this transaction is scoped to
	 * (ISS183), carried on the executor so the free functions below can read
	 * it the same way local's read it off `SqliteConnection`.
	 */
	projectIdentity?: string;
	/**
	 * The project every project-scoped read filters by - local's
	 * `SqliteConnection.currentProjectId`, resolved lazily here instead of
	 * eagerly at open. Lazy because cloud, unlike a local CLI invocation,
	 * serves callers that legitimately have no project: project discovery
	 * (which lists the projects you would pick from), tenant administration,
	 * and whole-tenant synchronize. Resolving eagerly would make those fail
	 * in exactly the multi-project tenants they exist for.
	 */
	currentProjectId?: Promise<string>;
};

export function createPgPool(options: PgConnectionOptions): Pool {
	return new Pool({ connectionString: options.connectionString });
}

/** Runs pending ADR43-runner migrations (schema + RLS policies) against the pool's target database. */
export async function migratePgDatabase(pool: Pool): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext(current_schema()))");
		const sourceProfile = await inspectPgSourceProfile(client, [finalBaselineMigration.id, "legacy-v7-direct"]);
		if (!sourceProfile.supported) {
			throw new Error(formatUnsupportedSourceProfile(sourceProfile));
		}
		if (sourceProfile.profile === "empty") {
			await runMigrationsWithClient(client, [finalBaselineMigration], { transactionIsManagedByCaller: true });
		} else if (sourceProfile.profile === "legacy-postgres-v7") {
			await transformLegacyPostgresV7(client);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
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
	fn: (executor: TenantExecutor) => Promise<T>,
	projectIdentity?: string
): Promise<T> {
	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
		const executor: TenantExecutor = Object.assign(drizzle(client, { schema }), {
			query: client.query.bind(client),
			tenantId,
			projectIdentity
		});
		const result = await fn(executor);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
