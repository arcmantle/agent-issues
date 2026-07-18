import {
	formatTenantDisplayName,
	type DeleteTenantResult,
	type RenameTenantResult,
	type TenantRecordCounts,
	type TenantSummary
} from "@agent-issues/core";
import { eq, sql } from "drizzle-orm";
import type { TenantExecutor as PoolClient } from "./connection.js";
import { contextTerms, contexts, counters, entities, historyEntries, relations } from "../schema.js";

import type { EntityRow, HistoryEntryRow, RelationRow } from "../features/entity-store/pg-entity-store.js";
import type { ContextRow, ContextTermRow } from "../features/context/pg-context-store.js";

type CounterRow = {
	kind: string;
	next_value: number;
};

async function getTenantRecordCounts(client: PoolClient, tenantId: string): Promise<TenantRecordCounts> {
	const result = await client.execute(sql`
		SELECT
			(SELECT COUNT(*) FROM entities WHERE tenant_id = ${tenantId}) AS entity_count,
			(SELECT COUNT(*) FROM relations WHERE tenant_id = ${tenantId}) AS relation_count,
			(SELECT COUNT(*) FROM contexts WHERE tenant_id = ${tenantId}) AS context_count,
			(SELECT COUNT(*) FROM context_terms WHERE tenant_id = ${tenantId}) AS context_term_count,
			(SELECT COUNT(*) FROM history_entries WHERE tenant_id = ${tenantId}) AS history_entry_count
	`);
	const row = result.rows[0] as {
		context_count: string;
		context_term_count: string;
		entity_count: string;
		history_entry_count: string;
		relation_count: string;
	};

	return {
		contexts: Number(row?.context_count ?? 0),
		contextTerms: Number(row?.context_term_count ?? 0),
		entities: Number(row?.entity_count ?? 0),
		historyEntries: Number(row?.history_entry_count ?? 0),
		relations: Number(row?.relation_count ?? 0)
	};
}

async function getTenantCounterCount(client: PoolClient, tenantId: string): Promise<number> {
	const [result] = await client.select({ count: sql<number>`count(*)` }).from(counters).where(eq(counters.tenantId, tenantId));
	return Number(result?.count ?? 0);
}

async function tenantHasAnyRows(client: PoolClient, tenantId: string): Promise<boolean> {
	const result = await client.execute(sql`
		SELECT EXISTS(
			SELECT 1 FROM counters WHERE tenant_id = ${tenantId}
			UNION ALL SELECT 1 FROM entities WHERE tenant_id = ${tenantId}
			UNION ALL SELECT 1 FROM relations WHERE tenant_id = ${tenantId}
			UNION ALL SELECT 1 FROM contexts WHERE tenant_id = ${tenantId}
			UNION ALL SELECT 1 FROM context_terms WHERE tenant_id = ${tenantId}
			UNION ALL SELECT 1 FROM history_entries WHERE tenant_id = ${tenantId}
		) AS has_rows
	`);
	const row = result.rows[0] as { has_rows: boolean } | undefined;
	return row?.has_rows ?? false;
}

// RLS (ADR9, the 0001 migration) scopes every query to whatever
// `app.tenant_id` is currently set to, so re-pointing it mid-transaction is
// how a tenant-administration method deliberately looks at (or writes) rows
// for a tenant other than the one `withTenantTransaction` opened for.
async function setSessionTenant(client: PoolClient, tenantId: string): Promise<void> {
	await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

// Tenant-administration methods only ever act on the calling store's own
// tenant (ADR9): a request authenticated for one tenant must never be able
// to delete or rename another tenant's data just by passing a different id.
// This also matches Postgres reality - RLS makes every query silently see
// zero rows for any tenant other than the store's own tenant, so without
// this guard a mismatched id would fail confusingly quiet instead of loud.
function requireOwnTenant(ownTenantId: string, requestedTenantId: string, operation: string): void {
	if (requestedTenantId !== ownTenantId) {
		throw new Error(`${operation} may only act on this store's own tenant (${ownTenantId}), not ${requestedTenantId}.`);
	}
}

export async function listTenants(client: PoolClient, ownTenantId: string): Promise<TenantSummary[]> {
	const counts = await getTenantRecordCounts(client, ownTenantId);
	const hasRows = Object.values(counts).some((count) => count > 0);

	if (!hasRows) {
		return [];
	}

	return [{ counts, displayName: formatTenantDisplayName(ownTenantId), id: ownTenantId }];
}

export async function deleteTenant(client: PoolClient, ownTenantId: string, tenantId: string): Promise<DeleteTenantResult> {
	requireOwnTenant(ownTenantId, tenantId, "deleteTenant");

	const counts = await getTenantRecordCounts(client, tenantId);

	await client.delete(historyEntries).where(eq(historyEntries.tenantId, tenantId));
	await client.delete(contextTerms).where(eq(contextTerms.tenantId, tenantId));
	await client.delete(relations).where(eq(relations.tenantId, tenantId));
	await client.delete(contexts).where(eq(contexts.tenantId, tenantId));
	await client.delete(entities).where(eq(entities.tenantId, tenantId));
	const deletedCounters = await client.delete(counters).where(eq(counters.tenantId, tenantId)).returning({ kind: counters.kind });
	const counterCount = deletedCounters.length;

	return {
		counters: counterCount,
		counts,
		displayName: formatTenantDisplayName(tenantId),
		removed: counterCount > 0 || Object.values(counts).some((count) => count > 0),
		tenantId
	};
}

export async function renameTenant(
	client: PoolClient,
	ownTenantId: string,
	previousTenantId: string,
	newTenantId: string
): Promise<RenameTenantResult> {
	requireOwnTenant(ownTenantId, previousTenantId, "renameTenant");

	if (previousTenantId === newTenantId) {
		throw new Error("Source and destination tenant ids are the same.");
	}

	// Briefly re-point RLS at the destination to answer "does it already have
	// rows?" - `previousTenantId`'s scope can never see that.
	await setSessionTenant(client, newTenantId);
	const targetHasRows = await tenantHasAnyRows(client, newTenantId);
	await setSessionTenant(client, previousTenantId);

	if (targetHasRows) {
		throw new Error(`Target tenant already exists: ${newTenantId}`);
	}

	const counts = await getTenantRecordCounts(client, previousTenantId);
	const counters = await getTenantCounterCount(client, previousTenantId);
	const renamed = counters > 0 || Object.values(counts).some((count) => count > 0);

	if (!renamed) {
		return {
			counters,
			counts,
			newDisplayName: formatTenantDisplayName(newTenantId),
			newTenantId,
			previousDisplayName: formatTenantDisplayName(previousTenantId),
			previousTenantId,
			renamed: false
		};
	}

	const entityRows = await client.query<EntityRow>(`SELECT * FROM entities WHERE tenant_id = $1`, [previousTenantId]);
	const relationRows = await client.query<RelationRow>(`SELECT * FROM relations WHERE tenant_id = $1`, [previousTenantId]);
	const contextRows = await client.query<ContextRow>(`SELECT * FROM contexts WHERE tenant_id = $1`, [previousTenantId]);
	const contextTermRows = await client.query<ContextTermRow & { context_key: string }>(
		`SELECT * FROM context_terms WHERE tenant_id = $1`,
		[previousTenantId]
	);
	const historyRows = await client.query<HistoryEntryRow>(`SELECT * FROM history_entries WHERE tenant_id = $1`, [previousTenantId]);
	const counterRows = await client.query<CounterRow>(`SELECT * FROM counters WHERE tenant_id = $1`, [previousTenantId]);

	// `history_entries.id` is a bare (non-tenant-scoped) primary key, so the
	// old rows must be gone before re-inserting the same ids under the new
	// tenant id - unlike every other table, whose primary key includes
	// tenant_id and so tolerates the copy-before-delete order.
	await client.query(`DELETE FROM history_entries WHERE tenant_id = $1`, [previousTenantId]);

	// Copy every row under the new tenant id (parent tables - entities,
	// contexts - before the tables that foreign-key to them), then delete the
	// old rows. A single cross-value `UPDATE ... SET tenant_id` cannot
	// satisfy RLS's USING (old value) and WITH CHECK (new value) in one
	// statement scoped to one session tenant id.
	await setSessionTenant(client, newTenantId);

	for (const row of entityRows.rows) {
		await client.query(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[newTenantId, row.id, row.kind, row.title, row.status, row.body, row.body_source, row.created_at, row.updated_at]
		);
	}

	for (const row of contextRows.rows) {
		await client.query(
			`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[newTenantId, row.key, row.scope_entity_id, row.title, row.summary, row.created_at, row.updated_at]
		);
	}

	for (const row of relationRows.rows) {
		await client.query(`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES ($1, $2, $3, $4, $5)`, [
			newTenantId,
			row.from_id,
			row.to_id,
			row.type,
			row.created_at
		]);
	}

	for (const row of contextTermRows.rows) {
		await client.query(
			`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[newTenantId, row.context_key, row.term, row.definition, row.avoid_terms, row.created_at, row.updated_at]
		);
	}

	for (const row of historyRows.rows) {
		await client.query(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			[
				row.id,
				newTenantId,
				row.entity_id,
				row.version,
				row.author,
				row.title,
				row.body,
				row.body_source,
				row.status,
				row.parent_id,
				row.created_at
			]
		);
	}

	for (const row of counterRows.rows) {
		await client.query(`INSERT INTO counters (tenant_id, kind, next_value) VALUES ($1, $2, $3)`, [newTenantId, row.kind, row.next_value]);
	}

	await setSessionTenant(client, previousTenantId);
	await client.query(`DELETE FROM context_terms WHERE tenant_id = $1`, [previousTenantId]);
	await client.query(`DELETE FROM relations WHERE tenant_id = $1`, [previousTenantId]);
	await client.query(`DELETE FROM contexts WHERE tenant_id = $1`, [previousTenantId]);
	await client.query(`DELETE FROM entities WHERE tenant_id = $1`, [previousTenantId]);
	await client.query(`DELETE FROM counters WHERE tenant_id = $1`, [previousTenantId]);

	return {
		counters,
		counts,
		newDisplayName: formatTenantDisplayName(newTenantId),
		newTenantId,
		previousDisplayName: formatTenantDisplayName(previousTenantId),
		previousTenantId,
		renamed: true
	};
}
