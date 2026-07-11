import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";

import {
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	ENTITY_KINDS,
	formatTenantDisplayName,
	RESERVED_SYSTEM_AUTHOR,
	STRUCTURAL_RELATION_TYPES
} from "./domain.js";
import { runMigrations } from "./migration-runner.js";
import { baselineV7Migration } from "./migrations/0000-baseline-v7.js";
import { historyEntriesMigration } from "./migrations/0001-history-entries.js";
import { historyVersionIndexNonUniqueMigration } from "./migrations/0002-history-version-index-non-unique.js";
import { projectMigrationsMigration } from "./migrations/0003-project-migrations.js";
import { backfillFullChainInvariantMigration } from "./migrations/0005-backfill-full-chain-invariant.js";
import { backfillHistorySeedMigration } from "./migrations/0006-backfill-history-seed.js";
import { backfillTenantCountersMigration } from "./migrations/0004-backfill-tenant-counters.js";
import { buildConsolidateLegacyTenantMigration } from "./migrations/0007-consolidate-legacy-tenant.js";

/**
 * The schema-shape migrations (ADR43) applied on every open, before any
 * tenant is resolved - baseline table creation plus the two forward DDL
 * tweaks and `project_migrations`' own table. Every statement is `IF NOT
 * EXISTS`-guarded, so re-running this list against an already-shaped
 * database (including ones that pre-date this runner and only have plain
 * tables, no ledger at all) is a safe no-op that just gets recorded, rather
 * than needing a separate "does this predate the old tool" detection
 * (ISS172 removed drizzle-kit and its `__drizzle_migrations` ledger
 * entirely - one ledgered runner is now the only migration mechanism).
 */
const BASELINE_MIGRATIONS = [
	baselineV7Migration,
	historyEntriesMigration,
	historyVersionIndexNonUniqueMigration,
	projectMigrationsMigration
];

export type DatabaseHandle = Database.Database & {
	tenantId: string;
	/**
	 * Which `project` entity this open belongs to (ISS166), for the
	 * well-known shared local tenant where one tenant can hold many
	 * projects (ISS63). Resolved once per open from
	 * `DatabaseLocationOptions.currentWorkingDirectory` via
	 * `resolveCurrentProjectId` - never re-resolved mid-session, matching
	 * `tenantId`'s own once-per-open lifetime.
	 */
	currentProjectId: string;
};

export type OpenDatabaseResult = {
	db: DatabaseHandle;
	dbPath: string;
};

export type DatabaseLocationOptions = {
	tenant?: string;
	currentWorkingDirectory?: string;
	skipTenantBootstrap?: boolean;
	/**
	 * Opts this one open out of `consolidateAllLegacyTenants` only, while
	 * still running every other bootstrap step (`ensureTenantCounters`,
	 * `ensureFullChainInvariant`, etc). Every non-well-known tenant is
	 * ordinary legacy debris under the current architecture (ISS63/ISS178) -
	 * this exists purely for tests that deliberately construct two or more
	 * named tenants coexisting in one shared db file to exercise admin
	 * operations (`listTenants`/`renameTenant`/`deleteTenant`) against that
	 * still-unmerged state. No production code path needs this.
	 */
	skipTenantConsolidation?: boolean;
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

/**
 * The one-time, all-tenants sweep migrations (ADR43) that retroactively fix
 * every tenant already present in the database file for the historical gap
 * left by `ensureFullChainInvariant`/`ensureTenantCounters`/`ensureHistorySeed`
 * only ever running for whichever tenant happened to be open. Ledgered via
 * `schema_migrations`, so this only ever runs once per database file. The
 * ongoing per-current-tenant calls to those three functions below are a
 * distinct, unaffected concern (bootstrapping brand-new tenants going
 * forward) and are not part of this list.
 */
const BOOTSTRAP_BACKFILL_MIGRATIONS = [
	backfillTenantCountersMigration,
	backfillFullChainInvariantMigration,
	backfillHistorySeedMigration
];

export function resolveDatabasePath(inputPath?: string, options?: DatabaseLocationOptions): string {
	if (inputPath) {
		return path.resolve(inputPath);
	}

	return path.join(resolveAgentIssuesHomeDirectory(), DATABASE_FILENAME);
}

export async function ensureDatabase(inputPath?: string, options?: DatabaseLocationOptions): Promise<OpenDatabaseResult> {
	const dbPath = resolveDatabasePath(inputPath, options);
	mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = new Database(dbPath) as DatabaseHandle;
	db.tenantId = resolveTenantSlug(options);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	await migrateDatabase(db);
	if (!inputPath && !options?.skipTenantBootstrap) {
		importLegacyTenantDataIfNeeded(db, options);
	}
	if (!options?.skipTenantBootstrap) {
		// Runs first, before any tenant becomes "current", so its "is there
		// any pre-existing data anywhere in this file" backup check sees the
		// database's true pre-sweep state (ADR43). A one-time, ledgered,
		// all-tenants fix for the historical gap left by the per-current-tenant
		// checks below only ever running for whichever tenant happened to be
		// open - never re-runs once applied.
		await runBootstrapBackfillMigrations(db, dbPath);
		// `ensureFullChainInvariant`/`ensureTenantCounters`/`ensureHistorySeed`
		// are onboarding logic for a tenant that has never been opened before -
		// not a migration, since a brand-new tenant created tomorrow still
		// needs this the moment it first appears. Gated behind one indexed
		// lookup (ISS179) so an already-bootstrapped tenant - every open after
		// its first - pays for none of these checks' underlying queries
		// (including `ensureHistorySeed`'s full entities/history_entries scan),
		// rather than re-deriving "has this already happened?" from live data
		// on every single CLI invocation forever.
		if (!isTenantBootstrapped(db)) {
			// Runs before ensureTenantCounters so its "does this tenant already
			// have data" backup check (tenantHasAnyRows) sees the tenant's true
			// pre-bootstrap state, not counter rows ensureTenantCounters is
			// about to seed.
			ensureFullChainInvariant(db, dbPath);
			ensureTenantCounters(db);
			// Runs after ensureFullChainInvariant so the PROJ0/EPIC0 sentinels
			// and any orphan-initiative attachment already exist and get
			// swept up as ordinary "entities lacking history" - no
			// special-casing needed.
			ensureHistorySeed(db);
		}
		// A brand-new `--tenant <name>` can appear at any later open (it's a
		// real, exposed CLI flag - see database.test.ts's "folds in every
		// outstanding legacy tenant" case), so this can never become a
		// once-ever migration without silently losing detection of it.
		// What made it slow wasn't running every open, though - it was
		// `findUnmigratedLegacyTenantIds` scanning a UNION across all six
		// potentially-large tenant-scoped tables just to answer "which
		// tenant ids exist?". Every tenant that has ever been onboarded
		// (this open's trio above, or the one-time historical backfill)
		// always has `counters` rows, and `counters` only ever grows with
		// tenant count (bounded, ~9 rows/tenant) - never with tracked-issue
		// volume - so `findUnmigratedLegacyTenantIds` now reads from
		// `counters` instead (ISS179), keeping this check cheap forever
		// regardless of how large entities/history/relations grow.
		if (!options?.skipTenantConsolidation) {
			await consolidateAllLegacyTenants(db, dbPath);
		}
	}

	db.currentProjectId = resolveCurrentProjectId(db, options?.currentWorkingDirectory);

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

/**
 * Whether the database file has any pre-existing rows at all, across every
 * tenant - used to decide whether the one-time bootstrap-backfill sweep
 * needs a pre-migration backup (ADR13/ADR20). A brand-new, genuinely empty
 * database has nothing worth protecting, mirroring `tenantHasAnyRows`'s same
 * "don't back up an empty tenant" reasoning but across the whole file.
 */
function databaseHasAnyData(db: DatabaseHandle): boolean {
	const row = db
		.prepare(
			`SELECT EXISTS(
				SELECT 1 FROM counters
				UNION SELECT 1 FROM entities
				UNION SELECT 1 FROM relations
				UNION SELECT 1 FROM contexts
				UNION SELECT 1 FROM context_terms
				UNION SELECT 1 FROM handoffs
				UNION SELECT 1 FROM history_entries
			) AS has_rows`
		)
		.get() as { has_rows: number };

	return row.has_rows === 1;
}

/**
 * Runs the one-time, ledgered, all-tenants bootstrap-backfill sweep
 * (ADR43). Only passes `dbPath` (triggering the runner's generic
 * pre-migration file backup) when the database already has real
 * pre-existing data to protect - a brand-new, empty database has nothing
 * worth backing up, matching the existing per-tenant backup behavior in
 * `ensureFullChainInvariant`.
 */
function runBootstrapBackfillMigrations(db: DatabaseHandle, dbPath: string): Promise<void> {
	return runMigrations(db, BOOTSTRAP_BACKFILL_MIGRATIONS, databaseHasAnyData(db) ? { dbPath } : undefined);
}

async function migrateDatabase(db: DatabaseHandle): Promise<void> {
	if (needsTenantSchemaMigration(db)) {
		await migrateCurrentDatabaseToTenantSchema(db);
	} else {
		await applyBaselineAndForwardMigrations(db);
	}
	ensureEntityBodyColumn(db);
	ensureEntityBodySourceColumn(db);
	upsertSchemaVersion(db, "7");
}

function applyBaselineAndForwardMigrations(db: DatabaseHandle): Promise<void> {
	return runMigrations(db, BASELINE_MIGRATIONS);
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

async function migrateCurrentDatabaseToTenantSchema(db: DatabaseHandle): Promise<void> {
	db.transaction(() => {
		renameTableIfExists(db, "counters", "legacy_counters");
		renameTableIfExists(db, "entities", "legacy_entities");
		renameTableIfExists(db, "relations", "legacy_relations");
		renameTableIfExists(db, "contexts", "legacy_contexts");
		renameTableIfExists(db, "context_terms", "legacy_context_terms");
		dropTableIfExists(db, "metadata");
	})();

	await applyBaselineAndForwardMigrations(db);

	db.transaction(() => {
		copyLegacyTablesIntoTenant(db, "main", db.tenantId, "legacy_");
		dropTableIfExists(db, "legacy_context_terms");
		dropTableIfExists(db, "legacy_contexts");
		dropTableIfExists(db, "legacy_relations");
		dropTableIfExists(db, "legacy_entities");
		dropTableIfExists(db, "legacy_counters");
	})();
}

/**
 * Whether the current tenant (`db.tenantId`) has already been through the
 * onboarding trio below at least once. `counters` is seeded the moment a
 * tenant is first onboarded (or retroactively by the one-time historical
 * backfill migration) and never removed while the tenant exists, so an
 * indexed prefix lookup on its `(tenant_id, kind)` primary key answers this
 * in O(1) - unlike `ensureFullChainInvariant`/`ensureHistorySeed`, which
 * would otherwise have to re-inspect this tenant's live entities/history
 * rows on every single open just to re-derive "has this already happened?"
 * (ISS179). A tenant, once bootstrapped, stays bootstrapped forever - this
 * is safe to treat as a permanent fact about `db.tenantId`, unlike the
 * legacy-tenant sweep below (a brand-new `--tenant` can still appear later).
 */
function isTenantBootstrapped(db: DatabaseHandle): boolean {
	return db.prepare(`SELECT 1 FROM counters WHERE tenant_id = ? LIMIT 1`).get(db.tenantId) !== undefined;
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
 * into a `project` under the currently-open tenant (ISS63). The automatic
 * sweep (`consolidateAllLegacyTenants`, run on every db file - custom
 * `--db` path included - whenever the open resolves to the well-known
 * tenant) already folds in every outstanding legacy tenant without needing
 * this command - it exists for the cases the sweep can't reach on its own:
 * an admin open with `skipTenantBootstrap: true` (every CLI admin command
 * uses this, to avoid racing the automatic sweep mid-command), an explicit
 * `--tenant` target other than the well-known tenant (the sweep never
 * merges into an arbitrary one-off tenant, only into the well-known one),
 * or wanting the
 * migration to happen right now rather than on the next ordinary open.
 * Idempotent: a `legacyTenantId` already folded in returns
 * `consolidated: false` with its existing project id rather than erroring
 * or duplicating work.
 */
export async function consolidateTenantIntoProject(
	db: DatabaseHandle,
	dbPath: string,
	legacyTenantId: string
): Promise<ConsolidateTenantResult> {
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

	const outcome = await migrateLegacyTenantIntoProject(db, dbPath, legacyTenantId);
	return { ...outcome, consolidated: true };
}

/**
 * Folds every pre-existing per-folder tenant left in this database file
 * (ADR7's original, incomplete migration - see ISS63) into its own
 * `project` entity under the well-known local tenant, so "one tenant per
 * folder" becomes "one project per folder, many projects per tenant" as
 * ADR7 always intended. Called by `ensureDatabase` on every open (custom
 * `--db` path or explicit `--tenant` included, ISS178) - the merge target
 * is always the well-known local tenant, never whichever tenant id this
 * particular open happened to request, so `db.tenantId` is temporarily
 * swapped to the well-known tenant for the duration of this sweep and
 * restored immediately after (the rest of THIS open still operates as
 * whatever tenant was actually requested). The tenant this open actually
 * requested is itself excluded from being swept - folding it away mid-open
 * would pull the ground out from under whatever this same command is about
 * to do with it; it becomes eligible on some LATER open instead, exactly
 * like any other not-yet-migrated tenant. Runs on EVERY OTHER not-yet-
 * migrated tenant found in the file, not only the one matching the current
 * workspace's cwd - a user upgrading from before ISS63 may have accumulated
 * many per-folder tenants over time, and should not have to `cd` into each
 * one in turn to have them folded in; the very next `agent-issues`
 * invocation from anywhere finishes the job for all of them. Idempotent via
 * `project_migrations`: a tenant already folded in is skipped on every
 * later open. A database with no outstanding legacy tenants (a genuinely
 * new install, or one fully migrated already) is a no-op - there is nothing
 * left to fold in.
 */
async function consolidateAllLegacyTenants(db: DatabaseHandle, dbPath: string): Promise<void> {
	const requestedTenantId = db.tenantId;
	const wellKnownTenantId = resolveWellKnownLocalTenantId();
	const legacyTenantIds = findUnmigratedLegacyTenantIds(db, wellKnownTenantId, requestedTenantId);

	db.tenantId = wellKnownTenantId;
	try {
		for (const legacyTenantId of legacyTenantIds) {
			await migrateLegacyTenantIntoProject(db, dbPath, legacyTenantId);
		}
	} finally {
		db.tenantId = requestedTenantId;
	}
}

/**
 * Every tenant id present in the shared db file other than the merge
 * target (`targetTenantId`, always the well-known tenant) and the tenant
 * this open actually requested (`excludeTenantId`, left untouched for the
 * duration of this open - see `consolidateAllLegacyTenants`), excluding
 * ones `project_migrations` already recorded as folded in. This local db
 * file only ever receives locally-originated tenant ids - sync with the
 * cloud API is push-only (see `pg-store.ts`), nothing pulls a foreign
 * tenant id back in - so any other tenant id found here is, by
 * construction, a legacy tenant left over from before ISS63 (a per-folder
 * tenant, or a previously-used `--tenant` name).
 *
 * Reads distinct tenant ids from `counters` rather than a UNION across
 * `entities`/`relations`/`contexts`/`context_terms`/`handoffs`/
 * `history_entries` (ISS179): every tenant that has ever had data written
 * under it also has `counters` rows (seeded by `ensureTenantCounters` the
 * moment it's first onboarded, or retroactively by the one-time historical
 * backfill migration for anything left behind before that check existed),
 * and `counters` only ever grows with tenant count, not with total tracked
 * data volume - keeping this check cheap regardless of how large this
 * database file's real content grows.
 */
function findUnmigratedLegacyTenantIds(db: DatabaseHandle, targetTenantId: string, excludeTenantId: string): string[] {
	const rows = db
		.prepare(
			`SELECT DISTINCT counters.tenant_id AS tenantId
			FROM counters
			WHERE counters.tenant_id != @targetTenantId
			AND counters.tenant_id != @excludeTenantId
			AND NOT EXISTS (
				SELECT 1 FROM project_migrations
				WHERE project_migrations.tenant_id = @targetTenantId
				AND project_migrations.legacy_tenant_id = counters.tenant_id
			)
			ORDER BY counters.tenant_id`
		)
		.all({ excludeTenantId, targetTenantId }) as Array<{ tenantId: string }>;

	return rows.map((row) => row.tenantId);
}

function getProjectMigration(db: DatabaseHandle, legacyTenantId: string): { projectId: string } | undefined {
	return db
		.prepare(`SELECT project_id AS projectId FROM project_migrations WHERE tenant_id = ? AND legacy_tenant_id = ?`)
		.get(db.tenantId, legacyTenantId) as { projectId: string } | undefined;
}

/**
 * Resolves which `project` entity the current invocation belongs to
 * (ISS166), so `context-store.ts`'s bare (no `--scope`) resolution can mean
 * "this workspace's own project" instead of always the tenant's one
 * literal "default". Looks up this workspace's legacy per-folder tenant id
 * (the exact same deterministic formula `consolidateAllLegacyTenants` used
 * to fold it in) in `project_migrations`; falls back to the tenant's
 * sentinel `DEFAULT_PROJECT_ID` when this workspace was never consolidated
 * - a fresh single-project tenant, or a workspace not yet folded in -
 * keeping that common case resolving exactly as before ISS166.
 */
export function resolveCurrentProjectId(db: DatabaseHandle, currentWorkingDirectory: string = process.cwd()): string {
	const legacyTenantId = resolveLegacyWorkspaceTenantId(currentWorkingDirectory);
	const migration = getProjectMigration(db, legacyTenantId);
	return migration?.projectId ?? DEFAULT_PROJECT_ID;
}

/**
 * Thin async wrapper (ISS180) delegating the actual copy-and-remap work to
 * `buildConsolidateLegacyTenantMigration`
 * (packages/core/src/migrations/0007-consolidate-legacy-tenant.ts), run
 * through the same ADR43 migration-runner every other migration in this
 * package uses, instead of a bespoke raw-`better-sqlite3` transaction. Its
 * ledger entry (`consolidate-legacy-tenant:<legacyTenantId>`, in the shared
 * `schema_migrations` table) makes re-running this for the same
 * `legacyTenantId` a no-op forever after the first successful run -
 * `consolidateTenantIntoProject`/`consolidateAllLegacyTenants` still also
 * check `getProjectMigration` first, purely to short-circuit before even
 * attempting a migration run and to report `consolidated: false` on repeat
 * calls, not because the migration itself needs that extra guard.
 */
async function migrateLegacyTenantIntoProject(
	db: DatabaseHandle,
	dbPath: string,
	legacyTenantId: string
): Promise<ConsolidateTenantResult> {
	const targetTenantId = db.tenantId;
	const projectTitle = formatTenantDisplayName(legacyTenantId) || legacyTenantId;

	await runMigrations(db, [buildConsolidateLegacyTenantMigration({ legacyTenantId, projectTitle, targetTenantId })], { dbPath });

	const migration = getProjectMigration(db, legacyTenantId);
	if (!migration) {
		throw new Error(`Consolidation migration for legacy tenant did not record a project migration: ${legacyTenantId}`);
	}

	return { consolidated: true, legacyTenantId, projectId: migration.projectId, projectTitle };
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