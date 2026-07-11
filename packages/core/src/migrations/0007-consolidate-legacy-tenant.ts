import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	ENTITY_KINDS,
	ID_PREFIX,
	RESERVED_SYSTEM_AUTHOR,
	type EntityKind
} from "../domain.js";
import type { Migration, MigrationConn } from "../migration-engine.js";

type LegacyEntityRow = {
	id: string;
	kind: EntityKind;
	title: string;
	status: string;
	body: string;
	body_source: string;
	created_at: string;
	updated_at: string;
};

type LegacyRelationRow = { from_id: string; to_id: string; type: string; created_at: string };
type LegacyHistoryRow = { id: string; entity_id: string; parent_id: string | null };
type LegacyContextRow = {
	key: string;
	scope_entity_id: string | null;
	title: string;
	summary: string;
	created_at: string;
	updated_at: string;
};
type LegacyContextTermRow = {
	context_key: string;
	term: string;
	definition: string;
	avoid_terms: string;
	created_at: string;
	updated_at: string;
};
type LegacyHandoffRow = {
	id: string;
	entity_id: string;
	initiative_id: string | null;
	summary: string;
	body: string;
	created_at: string;
};

/**
 * The target tenant's own counters may never have been seeded yet (the
 * explicit `consolidate-tenant` admin command opens with
 * `skipTenantBootstrap: true`, ISS175, precisely to avoid racing the
 * automatic sweep mid-command) - `mintEntityId`/`mintHandoffId` below need
 * them to already exist. Idempotent (`ON CONFLICT ... DO NOTHING`) and cheap,
 * so always safe to run unconditionally at the top of this migration.
 */
async function ensureTargetTenantCounters(conn: MigrationConn, targetTenantId: string): Promise<void> {
	for (const kind of ENTITY_KINDS) {
		await conn.run(sql`
			INSERT INTO counters (tenant_id, kind, next_value) VALUES (${targetTenantId}, ${kind}, 1)
			ON CONFLICT (tenant_id, kind) DO NOTHING
		`);
	}
	await conn.run(sql`
		INSERT INTO counters (tenant_id, kind, next_value) VALUES (${targetTenantId}, 'handoff', 1)
		ON CONFLICT (tenant_id, kind) DO NOTHING
	`);
}

async function mintEntityId(conn: MigrationConn, targetTenantId: string, kind: EntityKind): Promise<string> {
	const rows = await conn.all<{ next_value: number }>(sql`
		SELECT next_value FROM counters WHERE tenant_id = ${targetTenantId} AND kind = ${kind}
	`);
	const row = rows[0];
	if (!row) {
		throw new Error(`Counter missing for entity kind: ${kind}`);
	}

	await conn.run(sql`UPDATE counters SET next_value = next_value + 1 WHERE tenant_id = ${targetTenantId} AND kind = ${kind}`);
	return `${ID_PREFIX[kind]}${row.next_value}`;
}

async function mintHandoffId(conn: MigrationConn, targetTenantId: string): Promise<string> {
	const rows = await conn.all<{ next_value: number }>(sql`
		SELECT next_value FROM counters WHERE tenant_id = ${targetTenantId} AND kind = 'handoff'
	`);
	const row = rows[0];
	if (!row) {
		throw new Error("Counter missing for handoffs.");
	}

	await conn.run(sql`UPDATE counters SET next_value = next_value + 1 WHERE tenant_id = ${targetTenantId} AND kind = 'handoff'`);
	return `HO${row.next_value}`;
}

async function insertMigratedEntity(
	conn: MigrationConn,
	targetTenantId: string,
	entity: { id: string; kind: string; title: string; status: string; body: string; bodySource: string; createdAt: string; updatedAt: string }
): Promise<void> {
	await conn.run(sql`
		INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		VALUES (${targetTenantId}, ${entity.id}, ${entity.kind}, ${entity.title}, ${entity.status}, ${entity.body}, ${entity.bodySource}, ${entity.createdAt}, ${entity.updatedAt})
	`);
}

async function insertMigratedRelation(
	conn: MigrationConn,
	targetTenantId: string,
	fromId: string,
	toId: string,
	type: string,
	createdAt: string
): Promise<void> {
	await conn.run(sql`
		INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
		VALUES (${targetTenantId}, ${fromId}, ${toId}, ${type}, ${createdAt})
		ON CONFLICT (tenant_id, from_id, to_id, type) DO NOTHING
	`);
}

/**
 * Appends one more history version (next after whatever version, if any,
 * `entity.id` already has - including a legacy sentinel's own history just
 * relocated onto this same id) recording the migration's own final facts.
 * Left unrecorded, a legacy tenant's stale relocated "Default Project"
 * history would be the only history this project/epic has, so
 * `synchronize`'s history-is-truth reconciliation would recompute and
 * overwrite entities.title right back to the stale generic title on the very
 * first sync (the real bug fixed in commit `fb45060`).
 */
async function appendMigratedSentinelHistoryEntry(
	conn: MigrationConn,
	targetTenantId: string,
	entity: { id: string; title: string; body: string; bodySource: string; status: string; parentId: string | null; createdAt: string }
): Promise<void> {
	const rows = await conn.all<{ max_version: number | null }>(sql`
		SELECT MAX(version) AS max_version FROM history_entries WHERE tenant_id = ${targetTenantId} AND entity_id = ${entity.id}
	`);
	const version = (rows[0]?.max_version ?? 0) + 1;

	await conn.run(sql`
		INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
		VALUES (${randomUUID()}, ${targetTenantId}, ${entity.id}, ${version}, ${RESERVED_SYSTEM_AUTHOR}, ${entity.title}, ${entity.body}, ${entity.bodySource}, ${entity.status}, ${entity.parentId}, ${entity.createdAt})
	`);
}

/**
 * Builds a `Migration` (ISS180) that folds one legacy per-folder tenant's
 * full data set into a freshly-minted `project` entity under `targetTenantId`
 * - the actual copy/remap step ported line-for-line from the pre-ISS180
 * `migrateLegacyTenantIntoProject` (a raw `better-sqlite3` function gated
 * from the outside by the bespoke `project_migrations` ledger) into this
 * package's shared `MigrationConn`/ledger machinery (ADR43).
 *
 * Unlike the fixed migrations in `./index.ts` (schema-shape and one-time
 * global backfills, always run in the same static order for every database),
 * this one is dynamically parameterized: `database.ts`'s
 * `consolidateAllLegacyTenants` discovers which legacy tenant ids are still
 * outstanding on every open (a brand-new `--tenant <name>` can appear at any
 * time - it is a real, exposed CLI flag) and builds one of these per
 * discovered id, embedding that id into the migration's own `id` so the
 * SAME `schema_migrations` ledger the rest of the runner already uses
 * naturally makes each legacy tenant's consolidation run at most once ever,
 * without a second, bespoke ledger table.
 */
export function buildConsolidateLegacyTenantMigration(params: {
	legacyTenantId: string;
	targetTenantId: string;
	projectTitle: string;
}): Migration {
	const { legacyTenantId, targetTenantId, projectTitle } = params;

	return {
		id: `consolidate-legacy-tenant:${legacyTenantId}`,
		up: async (conn) => {
			// Mirrors the pre-ISS180 function's own `defer_foreign_keys = ON`:
			// automatically turned back off by SQLite at this migration's own
			// COMMIT (issued by the runner's transaction boundary), so it only
			// ever applies to this one migration.
			await conn.run(sql`PRAGMA defer_foreign_keys = ON`);
			await ensureTargetTenantCounters(conn, targetTenantId);

			const now = new Date().toISOString();
			const idMap = new Map<string, string>();
			const projectId = await mintEntityId(conn, targetTenantId, "project");
			const epicId = await mintEntityId(conn, targetTenantId, "epic");
			idMap.set(DEFAULT_PROJECT_ID, projectId);
			idMap.set(DEFAULT_EPIC_ID, epicId);

			const legacyEntities = await conn.all<LegacyEntityRow>(sql`SELECT * FROM entities WHERE tenant_id = ${legacyTenantId}`);
			for (const entity of legacyEntities) {
				if (entity.id === DEFAULT_PROJECT_ID || entity.id === DEFAULT_EPIC_ID) {
					continue;
				}

				idMap.set(entity.id, await mintEntityId(conn, targetTenantId, entity.kind));
			}

			await insertMigratedEntity(conn, targetTenantId, {
				body: "",
				bodySource: "generated",
				createdAt: now,
				id: projectId,
				kind: "project",
				status: "active",
				title: projectTitle,
				updatedAt: now
			});
			await insertMigratedEntity(conn, targetTenantId, {
				body: "",
				bodySource: "generated",
				createdAt: now,
				id: epicId,
				kind: "epic",
				status: "active",
				title: DEFAULT_EPIC_TITLE,
				updatedAt: now
			});
			await insertMigratedRelation(conn, targetTenantId, projectId, epicId, "contains", now);

			for (const entity of legacyEntities) {
				if (entity.id === DEFAULT_PROJECT_ID || entity.id === DEFAULT_EPIC_ID) {
					continue;
				}

				await insertMigratedEntity(conn, targetTenantId, {
					body: entity.body,
					bodySource: entity.body_source,
					createdAt: entity.created_at,
					id: idMap.get(entity.id) as string,
					kind: entity.kind,
					status: entity.status,
					title: entity.title,
					updatedAt: entity.updated_at
				});
			}

			const legacyRelations = await conn.all<LegacyRelationRow>(sql`SELECT * FROM relations WHERE tenant_id = ${legacyTenantId}`);
			for (const relation of legacyRelations) {
				const fromId = idMap.get(relation.from_id);
				const toId = idMap.get(relation.to_id);
				if (!fromId || !toId) {
					continue;
				}

				await insertMigratedRelation(conn, targetTenantId, fromId, toId, relation.type, relation.created_at);
			}

			// Any initiative that had no incoming 'contains' relation in the
			// legacy tenant (predates ISS34, or was created before its own
			// EPIC0 existed) attaches to this project's freshly-minted epic.
			for (const entity of legacyEntities) {
				if (entity.kind !== "initiative") {
					continue;
				}

				const newId = idMap.get(entity.id) as string;
				const hasIncomingContains = await conn.all(sql`
					SELECT 1 FROM relations WHERE tenant_id = ${targetTenantId} AND to_id = ${newId} AND type = 'contains'
				`);
				if (hasIncomingContains.length === 0) {
					await insertMigratedRelation(conn, targetTenantId, epicId, newId, "contains", now);
				}
			}

			// history_entries.id is a global PK (not tenant-scoped, ISS57/ADR16),
			// so these rows are relocated in place via UPDATE rather than copied
			// via INSERT: an INSERT with the same id would collide with the
			// still-present original row (not yet removed - that happens via
			// the DELETEs at the end of this migration).
			const legacyHistory = await conn.all<LegacyHistoryRow>(sql`
				SELECT id, entity_id, parent_id FROM history_entries WHERE tenant_id = ${legacyTenantId}
			`);
			for (const entry of legacyHistory) {
				const newEntityId = idMap.get(entry.entity_id) ?? entry.entity_id;
				const newParentId = entry.parent_id ? (idMap.get(entry.parent_id) ?? null) : null;
				await conn.run(sql`
					UPDATE history_entries SET tenant_id = ${targetTenantId}, entity_id = ${newEntityId}, parent_id = ${newParentId}
					WHERE id = ${entry.id}
				`);
			}

			// A legacy tenant that already had its own PROJ0/EPIC0 sentinel
			// relocates that sentinel's OWN history above - stale content from
			// when it was still generically titled "Default Project"/"Default
			// Epic". Appending one more version, unconditionally, keeps
			// entities and history consistent regardless of whether the legacy
			// tenant had a sentinel (with stale history to relocate) or not.
			await appendMigratedSentinelHistoryEntry(conn, targetTenantId, {
				body: "",
				bodySource: "generated",
				createdAt: now,
				id: projectId,
				parentId: null,
				status: "active",
				title: projectTitle
			});
			await appendMigratedSentinelHistoryEntry(conn, targetTenantId, {
				body: "",
				bodySource: "generated",
				createdAt: now,
				id: epicId,
				parentId: projectId,
				status: "active",
				title: DEFAULT_EPIC_TITLE
			});

			// Contexts: an initiative-scoped context's key is that initiative's
			// own id (remapped like any other entity reference); the tenant-wide
			// "default"/shared context has no entity to key off, so it is
			// namespaced by the new project id instead - each project keeps its
			// own shared glossary rather than colliding on the literal "default"
			// key with every other project now sharing this tenant.
			const legacyContexts = await conn.all<LegacyContextRow>(sql`SELECT * FROM contexts WHERE tenant_id = ${legacyTenantId}`);
			const contextKeyMap = new Map<string, string>();
			for (const context of legacyContexts) {
				const isDefaultContext = context.scope_entity_id === null;
				const newScopeEntityId = isDefaultContext ? null : (idMap.get(context.scope_entity_id as string) ?? null);
				const newKey = isDefaultContext ? `default:${projectId}` : (newScopeEntityId ?? context.key);
				contextKeyMap.set(context.key, newKey);

				await conn.run(sql`
					INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
					VALUES (${targetTenantId}, ${newKey}, ${newScopeEntityId}, ${context.title}, ${context.summary}, ${context.created_at}, ${context.updated_at})
				`);
			}

			const legacyTerms = await conn.all<LegacyContextTermRow>(sql`SELECT * FROM context_terms WHERE tenant_id = ${legacyTenantId}`);
			for (const term of legacyTerms) {
				await conn.run(sql`
					INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
					VALUES (${targetTenantId}, ${contextKeyMap.get(term.context_key) ?? term.context_key}, ${term.term}, ${term.definition}, ${term.avoid_terms}, ${term.created_at}, ${term.updated_at})
				`);
			}

			const legacyHandoffs = await conn.all<LegacyHandoffRow>(sql`SELECT * FROM handoffs WHERE tenant_id = ${legacyTenantId}`);
			for (const handoff of legacyHandoffs) {
				const newHandoffId = await mintHandoffId(conn, targetTenantId);
				await conn.run(sql`
					INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
					VALUES (
						${targetTenantId}, ${newHandoffId}, ${idMap.get(handoff.entity_id) ?? handoff.entity_id},
						${handoff.initiative_id ? (idMap.get(handoff.initiative_id) ?? null) : null},
						${handoff.summary}, ${handoff.body}, ${handoff.created_at}
					)
				`);
			}

			await conn.run(sql`
				INSERT INTO project_migrations (tenant_id, legacy_tenant_id, project_id, created_at)
				VALUES (${targetTenantId}, ${legacyTenantId}, ${projectId}, ${now})
			`);

			// Wipe the legacy tenant's now-emptied-of-meaning rows, in FK-safe
			// order (mirrors `database.ts`'s `deleteTenant`). History was
			// already relocated above (its rows now carry `targetTenantId`), so
			// this DELETE cannot touch them.
			await conn.run(sql`DELETE FROM handoffs WHERE tenant_id = ${legacyTenantId}`);
			await conn.run(sql`DELETE FROM history_entries WHERE tenant_id = ${legacyTenantId}`);
			await conn.run(sql`DELETE FROM context_terms WHERE tenant_id = ${legacyTenantId}`);
			await conn.run(sql`DELETE FROM relations WHERE tenant_id = ${legacyTenantId}`);
			await conn.run(sql`DELETE FROM contexts WHERE tenant_id = ${legacyTenantId}`);
			await conn.run(sql`DELETE FROM entities WHERE tenant_id = ${legacyTenantId}`);
			await conn.run(sql`DELETE FROM counters WHERE tenant_id = ${legacyTenantId}`);
		}
	};
}
