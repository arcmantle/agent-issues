import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";

import {
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	ENTITY_KINDS,
	ID_PREFIX,
	RESERVED_SYSTEM_AUTHOR,
	STRUCTURAL_RELATION_TYPES,
	type EntityKind
} from "./domain.js";

const MIGRATIONS_FOLDER = path.join(import.meta.dirname, "..", "drizzle");

export type DatabaseHandle = Database.Database & {
	tenantId: string;
};

export type OpenDatabaseResult = {
	db: DatabaseHandle;
	dbPath: string;
};

export type DatabaseLocationOptions = {
	tenant?: string;
	currentWorkingDirectory?: string;
	skipTenantBootstrap?: boolean;
};

export type TenantRecordCounts = {
	entities: number;
	relations: number;
	contexts: number;
	contextTerms: number;
	handoffs: number;
	historyEntries: number;
};

export type TenantSummary = {
	id: string;
	displayName: string;
	counts: TenantRecordCounts;
};

export type DeleteTenantResult = {
	tenantId: string;
	displayName: string;
	removed: boolean;
	counts: TenantRecordCounts;
	counters: number;
};

export type RenameTenantResult = {
	previousTenantId: string;
	previousDisplayName: string;
	newTenantId: string;
	newDisplayName: string;
	renamed: boolean;
	counts: TenantRecordCounts;
	counters: number;
};

const AGENT_ISSUES_DIRECTORY = ".agent-issues";
const LEGACY_TENANTS_DIRECTORY = "tenants";
const DATABASE_FILENAME = "agent-issues.db";

export function resolveDatabasePath(inputPath?: string, options?: DatabaseLocationOptions): string {
	if (inputPath) {
		return path.resolve(inputPath);
	}

	return path.join(resolveAgentIssuesHomeDirectory(), DATABASE_FILENAME);
}

export function ensureDatabase(inputPath?: string, options?: DatabaseLocationOptions): OpenDatabaseResult {
	const dbPath = resolveDatabasePath(inputPath, options);
	mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = new Database(dbPath) as DatabaseHandle;
	db.tenantId = resolveTenantSlug(options);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	migrateDatabase(db);
	if (!inputPath && !options?.skipTenantBootstrap) {
		importLegacyTenantDataIfNeeded(db, options);
	}
	if (!options?.skipTenantBootstrap) {
		// Runs before ensureTenantCounters so its "does this tenant already have
		// data" backup check (tenantHasAnyRows) sees the tenant's true pre-bootstrap
		// state, not counter rows that ensureTenantCounters is about to seed.
		ensureFullChainInvariant(db, dbPath);
		ensureTenantCounters(db);
		// Runs after ensureTenantCounters (needs its per-kind counters to mint
		// fresh ids) and only for the real default db file resolved with no
		// explicit --tenant (ISS63) - never for a custom --db path or an
		// explicitly-named tenant (tests, cloud-scoped tenants, fixtures).
		// Sweeps EVERY not-yet-migrated tenant left in the shared db file, not
		// just the one matching the current cwd - a plug-and-play upgrade for
		// anyone already using the system needs to fold in every workspace
		// they've ever opened here, on the very next open of any of them, not
		// only the one they happen to be standing in right now.
		if (!inputPath && !options?.tenant) {
			consolidateAllLegacyTenants(db, dbPath);
		}
		// Runs after ensureFullChainInvariant (and consolidation) so the
		// PROJ0/EPIC0 sentinels, any orphan-initiative attachment, and any
		// freshly-minted per-workspace project/epic already exist and get
		// swept up as ordinary "entities lacking history" - no special-casing
		// needed.
		ensureHistorySeed(db);
	}

	return { db, dbPath };
}

export function resolveAgentIssuesHomeDirectory(): string {
	return path.join(homedir(), AGENT_ISSUES_DIRECTORY);
}

export function resolveTenantDirectory(options?: DatabaseLocationOptions): string {
	const requestedTenant = options?.tenant?.trim();
	const slug = requestedTenant
		? resolveTenantSlug(options)
		: resolveLegacyWorkspaceTenantId(options?.currentWorkingDirectory ?? process.cwd());
	return path.join(resolveAgentIssuesHomeDirectory(), LEGACY_TENANTS_DIRECTORY, slug);
}

export function resolveLegacyDatabasePath(options?: DatabaseLocationOptions): string {
	return path.join(resolveTenantRootPath(options?.currentWorkingDirectory ?? process.cwd()), AGENT_ISSUES_DIRECTORY, DATABASE_FILENAME);
}

export function resolveTenantSlug(options?: DatabaseLocationOptions): string {
	const requestedTenant = options?.tenant?.trim();
	if (requestedTenant) {
		const sanitizedTenant = sanitizePathSegment(requestedTenant);
		if (sanitizedTenant.length === 0) {
			throw new Error(`Invalid tenant name: ${requestedTenant}`);
		}

		return sanitizedTenant;
	}

	return resolveWellKnownLocalTenantId();
}

/**
 * The shared, well-known local tenant (ISS63, correcting ADR7/ISS34's
 * incomplete migration of ADR7's decision). Every workspace on this machine
 * defaults into this ONE user-scoped tenant instead of minting its own
 * tenant per folder; each previously-independent workspace becomes a
 * `project` entity under it (see `consolidateAllLegacyTenants`).
 * Scoped per OS user, not global, so multiple accounts sharing a machine
 * never collide.
 */
export function resolveWellKnownLocalTenantId(): string {
	const sanitizedUsername = sanitizePathSegment(resolveOsUsername()) || "user";
	return `local-${sanitizedUsername}`;
}

function resolveOsUsername(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "user";
	}
}

/**
 * The pre-ISS63 per-workspace tenant formula (ADR7's original, incomplete
 * migration): one tenant minted per folder, named from the folder's own
 * name plus a path hash. Kept only to locate a workspace's old
 * per-tenant-directory database file (the even-older one-database-per-tenant
 * layout, see `resolveTenantDirectory`) so its data can be imported into the
 * shared database under this same id - once there, `consolidateAllLegacyTenants`
 * finds and folds it into a `project` on the next open from anywhere, not
 * only from this workspace's own folder.
 */
export function resolveLegacyWorkspaceTenantId(currentWorkingDirectory: string): string {
	const workspacePath = resolveTenantRootPath(currentWorkingDirectory);
	const workspaceName = sanitizePathSegment(path.basename(workspacePath)) || "workspace";
	const workspaceHash = createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
	return `${workspaceName}-${workspaceHash}`;
}

export function listTenants(db: Database.Database): TenantSummary[] {
	const rows = db
		.prepare(
			`WITH tenant_ids AS (
				SELECT tenant_id FROM entities
				UNION
				SELECT tenant_id FROM relations
				UNION
				SELECT tenant_id FROM contexts
				UNION
				SELECT tenant_id FROM context_terms
				UNION
				SELECT tenant_id FROM handoffs
				UNION
				SELECT tenant_id FROM history_entries
			)
			SELECT tenant_ids.tenant_id,
				COALESCE(entity_counts.entity_count, 0) AS entity_count,
				COALESCE(relation_counts.relation_count, 0) AS relation_count,
				COALESCE(context_counts.context_count, 0) AS context_count,
				COALESCE(context_term_counts.context_term_count, 0) AS context_term_count,
				COALESCE(handoff_counts.handoff_count, 0) AS handoff_count,
				COALESCE(history_entry_counts.history_entry_count, 0) AS history_entry_count
			FROM tenant_ids
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS entity_count
				FROM entities
				GROUP BY tenant_id
			) AS entity_counts ON entity_counts.tenant_id = tenant_ids.tenant_id
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS relation_count
				FROM relations
				GROUP BY tenant_id
			) AS relation_counts ON relation_counts.tenant_id = tenant_ids.tenant_id
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS context_count
				FROM contexts
				GROUP BY tenant_id
			) AS context_counts ON context_counts.tenant_id = tenant_ids.tenant_id
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS context_term_count
				FROM context_terms
				GROUP BY tenant_id
			) AS context_term_counts ON context_term_counts.tenant_id = tenant_ids.tenant_id
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS handoff_count
				FROM handoffs
				GROUP BY tenant_id
			) AS handoff_counts ON handoff_counts.tenant_id = tenant_ids.tenant_id
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS history_entry_count
				FROM history_entries
				GROUP BY tenant_id
			) AS history_entry_counts ON history_entry_counts.tenant_id = tenant_ids.tenant_id
			ORDER BY tenant_ids.tenant_id`
		)
		.all() as Array<{
			tenant_id: string;
			entity_count: number;
			relation_count: number;
			context_count: number;
			context_term_count: number;
			handoff_count: number;
			history_entry_count: number;
		}>;

	return rows.map((row) => ({
		counts: {
			contexts: row.context_count,
			contextTerms: row.context_term_count,
			entities: row.entity_count,
			handoffs: row.handoff_count,
			historyEntries: row.history_entry_count,
			relations: row.relation_count
		},
		displayName: formatTenantDisplayName(row.tenant_id),
		id: row.tenant_id
	}));
}

export function deleteTenant(db: Database.Database, tenantId: string): DeleteTenantResult {
	const counts = getTenantRecordCounts(db, tenantId);
	const deleteHandoffs = db.prepare(`DELETE FROM handoffs WHERE tenant_id = ?`);
	const deleteHistoryEntries = db.prepare(`DELETE FROM history_entries WHERE tenant_id = ?`);
	const deleteContextTerms = db.prepare(`DELETE FROM context_terms WHERE tenant_id = ?`);
	const deleteRelations = db.prepare(`DELETE FROM relations WHERE tenant_id = ?`);
	const deleteContexts = db.prepare(`DELETE FROM contexts WHERE tenant_id = ?`);
	const deleteEntities = db.prepare(`DELETE FROM entities WHERE tenant_id = ?`);
	const deleteCounters = db.prepare(`DELETE FROM counters WHERE tenant_id = ?`);

	const counters = db.transaction(() => {
		deleteHandoffs.run(tenantId);
		deleteHistoryEntries.run(tenantId);
		deleteContextTerms.run(tenantId);
		deleteRelations.run(tenantId);
		deleteContexts.run(tenantId);
		deleteEntities.run(tenantId);
		return deleteCounters.run(tenantId).changes;
	})();

	return {
		counts,
		counters,
		displayName: formatTenantDisplayName(tenantId),
		removed: counters > 0 || Object.values(counts).some((count) => count > 0),
		tenantId
	};
}

export function renameTenant(db: Database.Database, previousTenantId: string, newTenantId: string): RenameTenantResult {
	if (previousTenantId === newTenantId) {
		throw new Error("Source and destination tenant ids are the same.");
	}

	if (tenantHasAnyRows(db, newTenantId)) {
		throw new Error(`Target tenant already exists: ${newTenantId}`);
	}

	const counts = getTenantRecordCounts(db, previousTenantId);
	const counters = getTenantCounterCount(db, previousTenantId);
	const renamed = counters > 0 || Object.values(counts).some((count) => count > 0);

	if (!renamed) {
		return {
			counts,
			counters,
			newDisplayName: formatTenantDisplayName(newTenantId),
			newTenantId,
			previousDisplayName: formatTenantDisplayName(previousTenantId),
			previousTenantId,
			renamed: false
		};
	}

	const renameCounters = db.prepare(`UPDATE counters SET tenant_id = ? WHERE tenant_id = ?`);
	const renameEntities = db.prepare(`UPDATE entities SET tenant_id = ? WHERE tenant_id = ?`);
	const renameRelations = db.prepare(`UPDATE relations SET tenant_id = ? WHERE tenant_id = ?`);
	const renameContexts = db.prepare(`UPDATE contexts SET tenant_id = ? WHERE tenant_id = ?`);
	const renameContextTerms = db.prepare(`UPDATE context_terms SET tenant_id = ? WHERE tenant_id = ?`);
	const renameHandoffs = db.prepare(`UPDATE handoffs SET tenant_id = ? WHERE tenant_id = ?`);
	const renameHistoryEntries = db.prepare(`UPDATE history_entries SET tenant_id = ? WHERE tenant_id = ?`);

	db.pragma("defer_foreign_keys = ON");
	try {
		db.transaction(() => {
			renameCounters.run(newTenantId, previousTenantId);
			renameEntities.run(newTenantId, previousTenantId);
			renameRelations.run(newTenantId, previousTenantId);
			renameContexts.run(newTenantId, previousTenantId);
			renameContextTerms.run(newTenantId, previousTenantId);
			renameHandoffs.run(newTenantId, previousTenantId);
			renameHistoryEntries.run(newTenantId, previousTenantId);
		})();
	} finally {
		db.pragma("defer_foreign_keys = OFF");
	}

	return {
		counts,
		counters,
		newDisplayName: formatTenantDisplayName(newTenantId),
		newTenantId,
		previousDisplayName: formatTenantDisplayName(previousTenantId),
		previousTenantId,
		renamed: true
	};
}

export function resolveTenantRootPath(currentWorkingDirectory: string): string {
	const resolvedWorkingDirectory = path.resolve(currentWorkingDirectory);
	let candidatePath = resolvedWorkingDirectory;

	while (true) {
		if (existsSync(path.join(candidatePath, "pnpm-workspace.yaml"))) {
			return candidatePath;
		}

		if (existsSync(path.join(candidatePath, ".git"))) {
			return candidatePath;
		}

		const parentPath = path.dirname(candidatePath);
		if (parentPath === candidatePath) {
			break;
		}

		candidatePath = parentPath;
	}

	candidatePath = resolvedWorkingDirectory;
	while (true) {
		if (existsSync(path.join(candidatePath, "package.json"))) {
			return candidatePath;
		}

		const parentPath = path.dirname(candidatePath);
		if (parentPath === candidatePath) {
			return resolvedWorkingDirectory;
		}

		candidatePath = parentPath;
	}
}

export function sanitizePathSegment(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function formatTenantDisplayName(tenantId: string): string {
	const withoutHashSuffix = tenantId.replace(/-[0-9a-f]{12}$/i, "");
	return withoutHashSuffix
		.split(/[-_]+/)
		.filter((segment) => segment.length > 0)
		.map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
		.join(" ");
}

function getTenantRecordCounts(db: Database.Database, tenantId: string): TenantRecordCounts {
	const row = db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM entities WHERE tenant_id = @tenantId) AS entity_count,
				(SELECT COUNT(*) FROM relations WHERE tenant_id = @tenantId) AS relation_count,
				(SELECT COUNT(*) FROM contexts WHERE tenant_id = @tenantId) AS context_count,
				(SELECT COUNT(*) FROM context_terms WHERE tenant_id = @tenantId) AS context_term_count,
				(SELECT COUNT(*) FROM handoffs WHERE tenant_id = @tenantId) AS handoff_count,
				(SELECT COUNT(*) FROM history_entries WHERE tenant_id = @tenantId) AS history_entry_count`
		)
		.get({ tenantId }) as {
			entity_count: number;
			relation_count: number;
			context_count: number;
			context_term_count: number;
			handoff_count: number;
			history_entry_count: number;
		};

	return {
		contexts: row.context_count,
		contextTerms: row.context_term_count,
		entities: row.entity_count,
		handoffs: row.handoff_count,
		historyEntries: row.history_entry_count,
		relations: row.relation_count
	};
}

function getTenantCounterCount(db: Database.Database, tenantId: string): number {
	const row = db.prepare(`SELECT COUNT(*) AS counter_count FROM counters WHERE tenant_id = ?`).get(tenantId) as {
		counter_count: number;
	};

	return row.counter_count;
}

function tenantHasAnyRows(db: Database.Database, tenantId: string): boolean {
	const row = db
		.prepare(
			`SELECT EXISTS(
				SELECT 1 FROM counters WHERE tenant_id = @tenantId
				UNION SELECT 1 FROM entities WHERE tenant_id = @tenantId
				UNION SELECT 1 FROM relations WHERE tenant_id = @tenantId
				UNION SELECT 1 FROM contexts WHERE tenant_id = @tenantId
				UNION SELECT 1 FROM context_terms WHERE tenant_id = @tenantId
				UNION SELECT 1 FROM handoffs WHERE tenant_id = @tenantId
			) AS has_rows`
		)
		.get({ tenantId }) as { has_rows: number };

	return row.has_rows === 1;
}

function migrateDatabase(db: DatabaseHandle): void {
	if (needsTenantSchemaMigration(db)) {
		migrateCurrentDatabaseToTenantSchema(db);
	} else {
		applyBaselineAndForwardMigrations(db);
	}
	ensureEntityBodyColumn(db);
	ensureEntityBodySourceColumn(db);
	upsertSchemaVersion(db, "7");
}

function applyBaselineAndForwardMigrations(db: DatabaseHandle): void {
	if (databasePredatesDrizzle(db)) {
		seedDrizzleBaseline(db);
	}

	migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER });
}

function databasePredatesDrizzle(db: DatabaseHandle): boolean {
	return tableExists(db, "entities") && !tableExists(db, "__drizzle_migrations");
}

function seedDrizzleBaseline(db: DatabaseHandle): void {
	const [baseline] = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
	if (!baseline) {
		throw new Error("Missing Drizzle baseline migration.");
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS __drizzle_migrations (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`);

	const recorded = db.prepare(`SELECT COUNT(*) AS count FROM __drizzle_migrations`).get() as { count: number };
	if (recorded.count === 0) {
		db.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`).run(baseline.hash, baseline.folderMillis);
	}
}

function ensureEntityBodyColumn(db: DatabaseHandle): void {
	if (tableExists(db, "entities") && !tableHasColumn(db, "entities", "body")) {
		db.exec(`ALTER TABLE entities ADD COLUMN body TEXT NOT NULL DEFAULT ''`);
	}
}

function ensureEntityBodySourceColumn(db: DatabaseHandle): void {
	if (tableExists(db, "entities") && !tableHasColumn(db, "entities", "body_source")) {
		db.exec(`ALTER TABLE entities ADD COLUMN body_source TEXT NOT NULL DEFAULT 'authored'`);
	}
}

function needsTenantSchemaMigration(db: DatabaseHandle): boolean {
	if (!tableExists(db, "entities")) {
		return false;
	}

	return !tableHasColumn(db, "entities", "tenant_id");
}

function migrateCurrentDatabaseToTenantSchema(db: DatabaseHandle): void {
	db.transaction(() => {
		renameTableIfExists(db, "counters", "legacy_counters");
		renameTableIfExists(db, "entities", "legacy_entities");
		renameTableIfExists(db, "relations", "legacy_relations");
		renameTableIfExists(db, "contexts", "legacy_contexts");
		renameTableIfExists(db, "context_terms", "legacy_context_terms");
		dropTableIfExists(db, "metadata");
	})();

	applyBaselineAndForwardMigrations(db);

	db.transaction(() => {
		copyLegacyTablesIntoTenant(db, "main", db.tenantId, "legacy_");
		dropTableIfExists(db, "legacy_context_terms");
		dropTableIfExists(db, "legacy_contexts");
		dropTableIfExists(db, "legacy_relations");
		dropTableIfExists(db, "legacy_entities");
		dropTableIfExists(db, "legacy_counters");
	})();
}

function ensureTenantCounters(db: DatabaseHandle): void {
	const insertCounter = db.prepare(`
		INSERT INTO counters (tenant_id, kind, next_value)
		VALUES (@tenantId, @kind, 1)
		ON CONFLICT(tenant_id, kind) DO NOTHING
	`);

	for (const kind of ENTITY_KINDS) {
		insertCounter.run({ tenantId: db.tenantId, kind });
	}

	insertCounter.run({ tenantId: db.tenantId, kind: "handoff" });
}

// Structural relation types are a fixed, code-controlled constant (never
// user input), so inlining them into the SQL text below is safe and keeps
// this query automatically in sync with domain.ts's canonical list.
const STRUCTURAL_TYPES_SQL_LIST = STRUCTURAL_RELATION_TYPES.map((type) => `'${type}'`).join(", ");

/**
 * Backfills a synthetic version-1 history entry (ADR8) for every entity that
 * predates append-only history (ISS35) or was inserted outside `createEntity`
 * (the PROJ0/EPIC0 sentinels), so `listEntityHistory` always has at least one
 * row regardless of when an entity was created. Idempotent: only entities
 * with zero history rows are seeded. Uses each entity's own current facts,
 * its structural parent (if any), and its `updated_at` as the seed's
 * `created_at` (its last known-true state), with RESERVED_SYSTEM_AUTHOR since
 * the real original author was never captured for pre-history data.
 */
function ensureHistorySeed(db: DatabaseHandle): void {
	const unseeded = db
		.prepare(
			`SELECT id, title, body, body_source, status, updated_at FROM entities
			 WHERE tenant_id = @tenantId
			   AND id NOT IN (SELECT entity_id FROM history_entries WHERE tenant_id = @tenantId)`
		)
		.all({ tenantId: db.tenantId }) as Array<{
			id: string;
			title: string;
			body: string;
			body_source: string;
			status: string;
			updated_at: string;
		}>;

	if (unseeded.length === 0) {
		return;
	}

	const getParentId = db.prepare(
		`SELECT from_id FROM relations
		 WHERE tenant_id = @tenantId AND to_id = @entityId AND type IN (${STRUCTURAL_TYPES_SQL_LIST})
		 LIMIT 1`
	);

	const insertHistoryEntry = db.prepare(
		`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
		 VALUES (@id, @tenantId, @entityId, 1, @author, @title, @body, @bodySource, @status, @parentId, @createdAt)`
	);

	for (const entity of unseeded) {
		const parent = getParentId.get({ tenantId: db.tenantId, entityId: entity.id }) as { from_id: string } | undefined;

		insertHistoryEntry.run({
			id: randomUUID(),
			tenantId: db.tenantId,
			entityId: entity.id,
			author: RESERVED_SYSTEM_AUTHOR,
			title: entity.title,
			body: entity.body,
			bodySource: entity.body_source,
			status: entity.status,
			parentId: parent?.from_id ?? null,
			createdAt: entity.updated_at
		});
	}
}

/**
 * Synthesizes the tenant's sentinel default project/epic and attaches any
 * parentless initiative to them, so every initiative always resolves a
 * complete tenant>project>epic>initiative chain (the "full-chain invariant",
 * ADR7). Idempotent on every open, mirroring `ensureTenantCounters`. Backs up
 * the database file the first time this runs against a tenant that already
 * has data (ADR20) — a fresh, empty tenant has nothing worth protecting.
 */
function ensureFullChainInvariant(db: DatabaseHandle, dbPath: string): void {
	if (!entityExists(db, DEFAULT_PROJECT_ID) && tenantHasAnyRows(db, db.tenantId)) {
		backupDatabaseFile(db, dbPath);
	}

	const now = new Date().toISOString();
	insertSentinelEntity(db, DEFAULT_PROJECT_ID, "project", DEFAULT_PROJECT_TITLE, now);
	insertSentinelEntity(db, DEFAULT_EPIC_ID, "epic", DEFAULT_EPIC_TITLE, now);
	insertSentinelRelation(db, DEFAULT_PROJECT_ID, DEFAULT_EPIC_ID, now);
	attachOrphanInitiativesToDefaultEpic(db, now);
}

function entityExists(db: DatabaseHandle, entityId: string): boolean {
	return db.prepare(`SELECT 1 FROM entities WHERE tenant_id = ? AND id = ?`).get(db.tenantId, entityId) !== undefined;
}

function insertSentinelEntity(db: DatabaseHandle, id: string, kind: string, title: string, now: string): void {
	db.prepare(
		`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		 VALUES (@tenantId, @id, @kind, @title, 'active', '', 'generated', @now, @now)
		 ON CONFLICT (tenant_id, id) DO NOTHING`
	).run({ tenantId: db.tenantId, id, kind, title, now });
}

function insertSentinelRelation(db: DatabaseHandle, fromId: string, toId: string, now: string): void {
	db.prepare(
		`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
		 VALUES (@tenantId, @fromId, @toId, 'contains', @now)
		 ON CONFLICT (tenant_id, from_id, to_id, type) DO NOTHING`
	).run({ tenantId: db.tenantId, fromId, toId, now });
}

function attachOrphanInitiativesToDefaultEpic(db: DatabaseHandle, now: string): void {
	const orphanInitiatives = db
		.prepare(
			`SELECT id FROM entities
			 WHERE tenant_id = @tenantId AND kind = 'initiative'
			   AND id NOT IN (
			     SELECT to_id FROM relations WHERE tenant_id = @tenantId AND type = 'contains'
			   )`
		)
		.all({ tenantId: db.tenantId }) as Array<{ id: string }>;

	for (const { id } of orphanInitiatives) {
		insertSentinelRelation(db, DEFAULT_EPIC_ID, id, now);
	}
}

export type ConsolidateTenantResult = {
	legacyTenantId: string;
	projectId: string;
	projectTitle: string;
	consolidated: boolean;
};

/**
 * Explicit admin path for folding a specific, already-known legacy tenant
 * into a `project` under the well-known local tenant (ISS63). The automatic
 * sweep (`consolidateAllLegacyTenants`, run on every default-tenant open)
 * already folds in every outstanding legacy tenant in the shared db file
 * without needing this command - it exists for the remaining cases the
 * sweep can't reach on its own: a custom `--db` path (bypasses the sweep
 * entirely, since it only runs for the real default db file), or wanting
 * the migration to happen right now rather than on the next ordinary open.
 * Idempotent: a `legacyTenantId` already folded in returns
 * `consolidated: false` with its existing project id rather than erroring
 * or duplicating work.
 */
export function consolidateTenantIntoProject(db: DatabaseHandle, dbPath: string, legacyTenantId: string): ConsolidateTenantResult {
	if (legacyTenantId === db.tenantId) {
		throw new Error(`Cannot consolidate a tenant into itself: ${legacyTenantId}`);
	}

	const existing = getProjectMigration(db, legacyTenantId);
	if (existing) {
		return { legacyTenantId, projectId: existing.projectId, projectTitle: formatTenantDisplayName(legacyTenantId), consolidated: false };
	}

	if (!tenantHasAnyRows(db, legacyTenantId)) {
		throw new Error(`Tenant not found or has no data to consolidate: ${legacyTenantId}`);
	}

	const outcome = migrateLegacyTenantIntoProject(db, dbPath, legacyTenantId);
	return { ...outcome, consolidated: true };
}

/**
 * Folds every pre-existing per-folder tenant left in this database file
 * (ADR7's original, incomplete migration - see ISS63) into its own
 * `project` entity under the shared well-known local tenant, so "one tenant
 * per folder" becomes "one project per folder, many projects per tenant" as
 * ADR7 always intended. Runs on EVERY not-yet-migrated tenant found in the
 * file, not only the one matching the current workspace's cwd - a user
 * upgrading from before ISS63 may have accumulated many per-folder tenants
 * over time, and should not have to `cd` into each one in turn to have them
 * folded in; the very next `agent-issues` invocation from anywhere finishes
 * the job for all of them. Idempotent via `project_migrations`: a tenant
 * already folded in is skipped on every later open. A database with no
 * outstanding legacy tenants (a genuinely new install, or one fully
 * migrated already) is a no-op - there is nothing left to fold in.
 */
function consolidateAllLegacyTenants(db: DatabaseHandle, dbPath: string): void {
	for (const legacyTenantId of findUnmigratedLegacyTenantIds(db)) {
		migrateLegacyTenantIntoProject(db, dbPath, legacyTenantId);
	}
}

/**
 * Every tenant id present in the shared db file other than the well-known
 * tenant itself, excluding ones `project_migrations` already recorded as
 * folded in. This local db file only ever receives locally-originated
 * tenant ids - sync with the cloud API is push-only (see `pg-store.ts`),
 * nothing pulls a foreign tenant id back in - so any other tenant id found
 * here is, by construction, a legacy per-folder tenant left over from
 * before ISS63.
 */
function findUnmigratedLegacyTenantIds(db: DatabaseHandle): string[] {
	const rows = db
		.prepare(
			`WITH tenant_ids AS (
				SELECT tenant_id FROM entities
				UNION SELECT tenant_id FROM relations
				UNION SELECT tenant_id FROM contexts
				UNION SELECT tenant_id FROM context_terms
				UNION SELECT tenant_id FROM handoffs
				UNION SELECT tenant_id FROM history_entries
			)
			SELECT tenant_ids.tenant_id AS tenantId
			FROM tenant_ids
			WHERE tenant_ids.tenant_id != @wellKnownTenantId
			AND NOT EXISTS (
				SELECT 1 FROM project_migrations
				WHERE project_migrations.tenant_id = @wellKnownTenantId
				AND project_migrations.legacy_tenant_id = tenant_ids.tenant_id
			)
			ORDER BY tenant_ids.tenant_id`
		)
		.all({ wellKnownTenantId: db.tenantId }) as Array<{ tenantId: string }>;

	return rows.map((row) => row.tenantId);
}

function getProjectMigration(db: DatabaseHandle, legacyTenantId: string): { projectId: string } | undefined {
	return db
		.prepare(`SELECT project_id AS projectId FROM project_migrations WHERE tenant_id = ? AND legacy_tenant_id = ?`)
		.get(db.tenantId, legacyTenantId) as { projectId: string } | undefined;
}

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

/**
 * The actual copy-and-remap step, shared by the automatic sweep
 * (`consolidateAllLegacyTenants`) and the explicit `consolidate-tenant`
 * admin command. Every entity/relation/context/context-term/handoff from
 * `legacyTenantId` is copied in with a freshly-minted id under the
 * well-known tenant's own per-kind counters — ids are unique only within a
 * tenant, so two independent legacy tenants can both have had their own
 * INIT1/ISS1/etc, and would collide if copied verbatim. History entries
 * keep their existing id (already a random UUID, globally unique) with
 * only their entity_id/parent_id remapped. The legacy tenant's own
 * PROJ0/EPIC0 sentinel (if it has one — older data predating ISS34 may
 * not) is replaced by a freshly-minted project/epic pair titled from the
 * legacy tenant id, rather than carried over as another generic "Default
 * Project". NOT idempotent on its own; callers must check
 * `getProjectMigration` first.
 */
function migrateLegacyTenantIntoProject(db: DatabaseHandle, dbPath: string, legacyTenantId: string): ConsolidateTenantResult {
	backupDatabaseFile(db, dbPath);

	const now = new Date().toISOString();
	const projectTitle = formatTenantDisplayName(legacyTenantId) || legacyTenantId;
	let projectId = "";

	db.pragma("defer_foreign_keys = ON");
	try {
		db.transaction(() => {
			const idMap = new Map<string, string>();
			projectId = mintEntityId(db, "project");
			const epicId = mintEntityId(db, "epic");
			idMap.set(DEFAULT_PROJECT_ID, projectId);
			idMap.set(DEFAULT_EPIC_ID, epicId);

			const legacyEntities = db.prepare(`SELECT * FROM entities WHERE tenant_id = ?`).all(legacyTenantId) as LegacyEntityRow[];
			for (const entity of legacyEntities) {
				if (entity.id === DEFAULT_PROJECT_ID || entity.id === DEFAULT_EPIC_ID) {
					continue;
				}
				idMap.set(entity.id, mintEntityId(db, entity.kind));
			}

			insertMigratedEntity(db, {
				id: projectId,
				kind: "project",
				title: projectTitle,
				status: "active",
				body: "",
				bodySource: "generated",
				createdAt: now,
				updatedAt: now
			});
			insertMigratedEntity(db, {
				id: epicId,
				kind: "epic",
				title: DEFAULT_EPIC_TITLE,
				status: "active",
				body: "",
				bodySource: "generated",
				createdAt: now,
				updatedAt: now
			});
			insertMigratedRelation(db, projectId, epicId, "contains", now);

			for (const entity of legacyEntities) {
				if (entity.id === DEFAULT_PROJECT_ID || entity.id === DEFAULT_EPIC_ID) {
					continue;
				}
				insertMigratedEntity(db, {
					id: idMap.get(entity.id) as string,
					kind: entity.kind,
					title: entity.title,
					status: entity.status,
					body: entity.body,
					bodySource: entity.body_source,
					createdAt: entity.created_at,
					updatedAt: entity.updated_at
				});
			}

			const legacyRelations = db.prepare(`SELECT * FROM relations WHERE tenant_id = ?`).all(legacyTenantId) as Array<{
				from_id: string;
				to_id: string;
				type: string;
				created_at: string;
			}>;
			for (const relation of legacyRelations) {
				const fromId = idMap.get(relation.from_id);
				const toId = idMap.get(relation.to_id);
				if (!fromId || !toId) {
					continue;
				}
				insertMigratedRelation(db, fromId, toId, relation.type, relation.created_at);
			}

			// Any initiative that had no incoming 'contains' relation in the
			// legacy tenant (predates ISS34, or was created before its own
			// EPIC0 existed) attaches to this project's freshly-minted epic,
			// mirroring attachOrphanInitiativesToDefaultEpic's per-tenant logic.
			const hasIncomingContains = db.prepare(
				`SELECT 1 FROM relations WHERE tenant_id = @tenantId AND to_id = @id AND type = 'contains'`
			);
			for (const entity of legacyEntities) {
				if (entity.kind !== "initiative") {
					continue;
				}
				const newId = idMap.get(entity.id) as string;
				if (!hasIncomingContains.get({ tenantId: db.tenantId, id: newId })) {
					insertMigratedRelation(db, epicId, newId, "contains", now);
				}
			}

			// history_entries.id is a global PK (not tenant-scoped, ISS57/ADR16 -
			// only the id itself is unique, never tenant_id+id), so these rows are
			// relocated in place via UPDATE rather than copied via INSERT: an
			// INSERT with the same id would collide with the still-present
			// original row (not yet removed - that happens via deleteTenant at
			// the end of this transaction).
			const legacyHistory = db.prepare(`SELECT * FROM history_entries WHERE tenant_id = ?`).all(legacyTenantId) as Array<{
				id: string;
				entity_id: string;
				parent_id: string | null;
			}>;
			const relocateHistory = db.prepare(
				`UPDATE history_entries SET tenant_id = @tenantId, entity_id = @entityId, parent_id = @parentId WHERE id = @id`
			);
			for (const entry of legacyHistory) {
				relocateHistory.run({
					id: entry.id,
					tenantId: db.tenantId,
					entityId: idMap.get(entry.entity_id) ?? entry.entity_id,
					parentId: entry.parent_id ? (idMap.get(entry.parent_id) ?? null) : null
				});
			}

			// Contexts: an initiative-scoped context's key is that initiative's
			// own id (remapped like any other entity reference); the tenant-wide
			// "default"/shared context has no entity to key off, so it is
			// namespaced by the new project id instead - each project keeps its
			// own shared glossary rather than colliding on the literal "default"
			// key with every other project now sharing this tenant. NOTE: bare
			// `context show`/`context set` (no --scope) still always resolves the
			// literal "default" key (context-store.ts's DEFAULT_CONTEXT_KEY),
			// which is not yet project-aware - this preserves the migrated data
			// without losing it, but reaching it again through the CLI needs a
			// follow-up to make default-context resolution project-scoped.
			const legacyContexts = db.prepare(`SELECT * FROM contexts WHERE tenant_id = ?`).all(legacyTenantId) as Array<{
				key: string;
				scope_entity_id: string | null;
				title: string;
				summary: string;
				created_at: string;
				updated_at: string;
			}>;
			const insertContext = db.prepare(
				`INSERT INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
				 VALUES (@tenantId, @key, @scopeEntityId, @title, @summary, @createdAt, @updatedAt)`
			);
			const contextKeyMap = new Map<string, string>();
			for (const context of legacyContexts) {
				const isDefaultContext = context.scope_entity_id === null;
				const newScopeEntityId = isDefaultContext ? null : (idMap.get(context.scope_entity_id as string) ?? null);
				const newKey = isDefaultContext ? `default:${projectId}` : (newScopeEntityId ?? context.key);
				contextKeyMap.set(context.key, newKey);
				insertContext.run({
					tenantId: db.tenantId,
					key: newKey,
					scopeEntityId: newScopeEntityId,
					title: context.title,
					summary: context.summary,
					createdAt: context.created_at,
					updatedAt: context.updated_at
				});
			}

			const legacyTerms = db.prepare(`SELECT * FROM context_terms WHERE tenant_id = ?`).all(legacyTenantId) as Array<{
				context_key: string;
				term: string;
				definition: string;
				avoid_terms: string;
				created_at: string;
				updated_at: string;
			}>;
			const insertTerm = db.prepare(
				`INSERT INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
				 VALUES (@tenantId, @contextKey, @term, @definition, @avoidTerms, @createdAt, @updatedAt)`
			);
			for (const term of legacyTerms) {
				insertTerm.run({
					tenantId: db.tenantId,
					contextKey: contextKeyMap.get(term.context_key) ?? term.context_key,
					term: term.term,
					definition: term.definition,
					avoidTerms: term.avoid_terms,
					createdAt: term.created_at,
					updatedAt: term.updated_at
				});
			}

			const legacyHandoffs = db.prepare(`SELECT * FROM handoffs WHERE tenant_id = ?`).all(legacyTenantId) as Array<{
				id: string;
				entity_id: string;
				initiative_id: string | null;
				summary: string;
				body: string;
				created_at: string;
			}>;
			const insertHandoff = db.prepare(
				`INSERT INTO handoffs (tenant_id, id, entity_id, initiative_id, summary, body, created_at)
				 VALUES (@tenantId, @id, @entityId, @initiativeId, @summary, @body, @createdAt)`
			);
			for (const handoff of legacyHandoffs) {
				insertHandoff.run({
					tenantId: db.tenantId,
					id: mintHandoffId(db),
					entityId: idMap.get(handoff.entity_id) ?? handoff.entity_id,
					initiativeId: handoff.initiative_id ? (idMap.get(handoff.initiative_id) ?? null) : null,
					summary: handoff.summary,
					body: handoff.body,
					createdAt: handoff.created_at
				});
			}

			db.prepare(
				`INSERT INTO project_migrations (tenant_id, legacy_tenant_id, project_id, created_at)
				 VALUES (@tenantId, @legacyTenantId, @projectId, @now)`
			).run({ tenantId: db.tenantId, legacyTenantId, projectId, now });

			deleteTenant(db, legacyTenantId);
		})();
	} finally {
		db.pragma("defer_foreign_keys = OFF");
	}

	return { legacyTenantId, projectId, projectTitle, consolidated: true };
}

function mintEntityId(db: DatabaseHandle, kind: EntityKind): string {
	const row = db.prepare(`SELECT next_value FROM counters WHERE tenant_id = ? AND kind = ?`).get(db.tenantId, kind) as
		| { next_value: number }
		| undefined;

	if (!row) {
		throw new Error(`Counter missing for entity kind: ${kind}`);
	}

	db.prepare(`UPDATE counters SET next_value = next_value + 1 WHERE tenant_id = ? AND kind = ?`).run(db.tenantId, kind);
	return `${ID_PREFIX[kind]}${row.next_value}`;
}

function mintHandoffId(db: DatabaseHandle): string {
	const row = db.prepare(`SELECT next_value FROM counters WHERE tenant_id = ? AND kind = 'handoff'`).get(db.tenantId) as
		| { next_value: number }
		| undefined;

	if (!row) {
		throw new Error("Counter missing for handoffs.");
	}

	db.prepare(`UPDATE counters SET next_value = next_value + 1 WHERE tenant_id = ? AND kind = 'handoff'`).run(db.tenantId);
	return `HO${row.next_value}`;
}

function insertMigratedEntity(
	db: DatabaseHandle,
	entity: {
		id: string;
		kind: string;
		title: string;
		status: string;
		body: string;
		bodySource: string;
		createdAt: string;
		updatedAt: string;
	}
): void {
	db.prepare(
		`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		 VALUES (@tenantId, @id, @kind, @title, @status, @body, @bodySource, @createdAt, @updatedAt)`
	).run({ tenantId: db.tenantId, ...entity });
}

function insertMigratedRelation(db: DatabaseHandle, fromId: string, toId: string, type: string, createdAt: string): void {
	db.prepare(
		`INSERT OR IGNORE INTO relations (tenant_id, from_id, to_id, type, created_at)
		 VALUES (@tenantId, @fromId, @toId, @type, @createdAt)`
	).run({ tenantId: db.tenantId, fromId, toId, type, createdAt });
}

function backupDatabaseFile(db: DatabaseHandle, dbPath: string): void {
	db.pragma("wal_checkpoint(TRUNCATE)");

	// Co-located with the actual database file rather than a fixed home-directory
	// path, so this respects an explicit --path/dbPath choice (and keeps tests
	// that use a temp dbPath from writing into the real user home directory).
	const backupsDirectory = path.join(path.dirname(dbPath), "backups");
	mkdirSync(backupsDirectory, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = path.join(backupsDirectory, `${path.basename(dbPath, ".db")}-${db.tenantId}-${timestamp}.db`);
	copyFileSync(dbPath, backupPath);
}

function importLegacyTenantDataIfNeeded(db: DatabaseHandle, options?: DatabaseLocationOptions): void {
	if (tenantHasData(db)) {
		return;
	}

	const candidatePaths = [
		path.join(resolveTenantDirectory(options), DATABASE_FILENAME),
		resolveLegacyDatabasePath(options)
	].filter((candidatePath, index, allPaths) => allPaths.indexOf(candidatePath) === index && existsSync(candidatePath));

	for (const candidatePath of candidatePaths) {
		if (candidatePath === resolveDatabasePath(undefined, options)) {
			continue;
		}

		if (importTenantDataFromExternalDatabase(db, candidatePath)) {
			return;
		}
	}
}

function tenantHasData(db: DatabaseHandle): boolean {
	const row = db
		.prepare(
			`SELECT EXISTS(SELECT 1 FROM entities WHERE tenant_id = @tenantId LIMIT 1) AS has_entities,
			        EXISTS(SELECT 1 FROM contexts WHERE tenant_id = @tenantId LIMIT 1) AS has_contexts`
		)
		.get({ tenantId: db.tenantId }) as { has_entities: number; has_contexts: number };

	return row.has_entities === 1 || row.has_contexts === 1;
}

function importTenantDataFromExternalDatabase(db: DatabaseHandle, sourcePath: string): boolean {
	const importAlias = "legacy_import";
	db.prepare(`ATTACH DATABASE ? AS ${importAlias}`).run(sourcePath);

	try {
		if (!attachedTableExists(db, importAlias, "entities")) {
			return false;
		}

		db.transaction(() => {
			copyLegacyTablesIntoTenant(db, importAlias, db.tenantId);
		})();
		return true;
	} finally {
		db.exec(`DETACH DATABASE ${importAlias}`);
	}
}

function copyLegacyTablesIntoTenant(
	db: DatabaseHandle,
	schemaName: string,
	tenantId: string,
	tablePrefix = ""
): void {
	const countersTable = `${schemaName}.${tablePrefix}counters`;
	const entitiesTable = `${schemaName}.${tablePrefix}entities`;
	const relationsTable = `${schemaName}.${tablePrefix}relations`;
	const contextsTable = `${schemaName}.${tablePrefix}contexts`;
	const contextTermsTable = `${schemaName}.${tablePrefix}context_terms`;
	const hasContextsScopeColumn = attachedTableHasColumn(db, schemaName, `${tablePrefix}contexts`, "scope_entity_id");

	if (attachedTableExists(db, schemaName, `${tablePrefix}counters`)) {
		db.prepare(
			`INSERT OR IGNORE INTO counters (tenant_id, kind, next_value)
			 VALUES (@tenantId, @kind, @nextValue)`
		);

		db.prepare(
			`INSERT OR IGNORE INTO counters (tenant_id, kind, next_value)
			 SELECT @tenantId, kind, next_value
			 FROM ${countersTable}`
		).run({ tenantId });
	}

	if (attachedTableExists(db, schemaName, `${tablePrefix}entities`)) {
		db.prepare(
			`INSERT OR IGNORE INTO entities (tenant_id, id, kind, title, status, created_at, updated_at)
			 SELECT @tenantId, id, kind, title, status, created_at, updated_at
			 FROM ${entitiesTable}`
		).run({ tenantId });
	}

	if (attachedTableExists(db, schemaName, `${tablePrefix}relations`)) {
		db.prepare(
			`INSERT OR IGNORE INTO relations (tenant_id, from_id, to_id, type, created_at)
			 SELECT @tenantId, from_id, to_id, type, created_at
			 FROM ${relationsTable}`
		).run({ tenantId });
	}

	if (attachedTableExists(db, schemaName, `${tablePrefix}contexts`)) {
		db.prepare(
			`INSERT OR IGNORE INTO contexts (tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
			 SELECT @tenantId,
			        key,
			        ${hasContextsScopeColumn ? "scope_entity_id" : "NULL"},
			        title,
			        summary,
			        created_at,
			        updated_at
			 FROM ${contextsTable}`
		).run({ tenantId });
	}

	if (attachedTableExists(db, schemaName, `${tablePrefix}context_terms`)) {
		db.prepare(
			`INSERT OR IGNORE INTO context_terms (tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
			 SELECT @tenantId, context_key, term, definition, avoid_terms, created_at, updated_at
			 FROM ${contextTermsTable}`
		).run({ tenantId });
	}
}

function upsertSchemaVersion(db: DatabaseHandle, version: string): void {
	db.prepare(
		`INSERT INTO metadata (key, value)
		 VALUES ('schema_version', @version)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
	).run({ version });
}

function tableExists(db: DatabaseHandle, tableName: string): boolean {
	const row = db
		.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get(tableName) as { 1: number } | undefined;
	return Boolean(row);
}

function attachedTableExists(db: DatabaseHandle, schemaName: string, tableName: string): boolean {
	const row = db
		.prepare(`SELECT 1 FROM ${schemaName}.sqlite_master WHERE type = 'table' AND name = ?`)
		.get(tableName) as { 1: number } | undefined;
	return Boolean(row);
}

function tableHasColumn(db: DatabaseHandle, tableName: string, columnName: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
	return columns.some((column) => column.name === columnName);
}

function attachedTableHasColumn(db: DatabaseHandle, schemaName: string, tableName: string, columnName: string): boolean {
	if (!attachedTableExists(db, schemaName, tableName)) {
		return false;
	}

	const columns = db.prepare(`PRAGMA ${schemaName}.table_info(${tableName})`).all() as Array<{ name: string }>;
	return columns.some((column) => column.name === columnName);
}

function renameTableIfExists(db: DatabaseHandle, tableName: string, nextTableName: string): void {
	if (!tableExists(db, tableName)) {
		return;
	}

	db.exec(`ALTER TABLE ${tableName} RENAME TO ${nextTableName}`);
}

function dropTableIfExists(db: DatabaseHandle, tableName: string): void {
	if (!tableExists(db, tableName)) {
		return;
	}

	db.exec(`DROP TABLE ${tableName}`);
}