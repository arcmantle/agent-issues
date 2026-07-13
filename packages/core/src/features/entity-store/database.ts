import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
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
import { runMigrations } from "../migrations/migration-runner.js";
import { baselineV7Migration } from "../migrations/versions/0000-baseline-v7.js";
import { backfillTenantBootstrapMigration } from "../migrations/versions/0004-backfill-tenant-bootstrap.js";
import { buildConsolidateLegacyTenantsBackfillMigration } from "../migrations/versions/0008-consolidate-legacy-tenants-backfill.js";
import { resolveWellKnownLocalTenantId, sanitizePathSegment } from "../../utilities/tenant-identity.js";

export { resolveWellKnownLocalTenantId, sanitizePathSegment };

/**
 * The schema-shape migration (ADR43) applied on every open, before any
 * tenant is resolved - full baseline table creation, including
 * `history_entries` and `project_migrations`. Every statement is `IF NOT
 * EXISTS`-guarded, so re-running this against an already-shaped database
 * (including ones that pre-date this runner and only have plain tables, no
 * ledger at all) is a safe no-op that just gets recorded, rather than
 * needing a separate "does this predate the old tool" detection (ISS172
 * removed drizzle-kit and its `__drizzle_migrations` ledger entirely - one
 * ledgered runner is now the only migration mechanism).
 */
const BASELINE_MIGRATIONS = [baselineV7Migration];

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
	/**
	 * Opts this one open out of the one-time legacy-tenant backfill
	 * migration (`buildConsolidateLegacyTenantsBackfillMigration`, ISS181)
	 * only, while still running every other bootstrap step
	 * (`ensureTenantCounters`, `ensureFullChainInvariant`, etc). Every
	 * non-well-known tenant present the FIRST time that migration ever runs
	 * is ordinary legacy debris under the current architecture
	 * (ISS63/ISS178) - this exists purely for tests that deliberately
	 * construct two or more named tenants coexisting in one shared db file
	 * to exercise admin operations (`listTenants`/`renameTenant`/
	 * `deleteTenant`) against that still-unmerged state. No production code
	 * path needs this.
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
 * The one-time, all-tenants sweep migration (ADR43) that retroactively fixes
 * every tenant already present in the database file for the historical gap
 * left by `ensureFullChainInvariant`/`ensureTenantCounters`/`ensureHistorySeed`
 * only ever running for whichever tenant happened to be open. Ledgered via
 * `schema_migrations`, so this only ever runs once per database file. The
 * ongoing per-current-tenant calls to those three functions below are a
 * distinct, unaffected concern (bootstrapping brand-new tenants going
 * forward) and are not part of this list.
 *
 * The one-time legacy-tenant fold-in
 * (`buildConsolidateLegacyTenantsBackfillMigration`, ISS181) is a SEPARATE,
 * later call in `ensureDatabase` - not part of this array - because it must
 * run AFTER the per-current-tenant trio below, not alongside this migration:
 * folding in the first legacy tenant seeds the well-known tenant's own
 * counters as a side effect (so its freshly-minted project can mint ids),
 * which would otherwise trick `isTenantBootstrapped` into skipping the
 * well-known tenant's OWN PROJ0/EPIC0 sentinel if it ran any earlier.
 */
const BOOTSTRAP_BACKFILL_MIGRATIONS = [backfillTenantBootstrapMigration];

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
	if (!inputPath) {
		importLegacyTenantDataIfNeeded(db, options);
	}
	// Captured once, before any bootstrap step below writes anything - both
	// this open's per-current-tenant trio and the one-time legacy-tenant
	// fold-in migration need this SAME "did the file already have real
	// content before this open touched it at all" answer for their own
	// backup-only-when-worth-protecting checks; a truly brand-new, empty
	// database has nothing worth backing up no matter which of those steps
	// ends up running first.
	const hadPreExistingData = databaseHasAnyData(db);
	// Runs first, before any tenant becomes "current", so its "is there
	// any pre-existing data anywhere in this file" backup check sees the
	// database's true pre-sweep state (ADR43). One-time, ledgered,
	// all-tenants fix for the historical gap left by the per-current-tenant
	// checks below only ever running for whichever tenant happened to be
	// open - never re-runs once applied.
	await runBootstrapBackfillMigrations(db, dbPath, hadPreExistingData);
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
	// Runs AFTER the per-current-tenant trio above, not folded into
	// `runBootstrapBackfillMigrations` - this migration's own
	// `consolidateLegacyTenantData` seeds the target tenant's counters
	// as a side effect of folding in its first legacy tenant (so a
	// freshly-minted project can mint ids), which would otherwise trick
	// `isTenantBootstrapped` into skipping the well-known tenant's OWN
	// PROJ0/EPIC0 sentinel above if this ran any earlier. One-time,
	// ledgered (ISS181): never re-run once applied, regardless of which
	// tenant this or any later open excludes. Only passes `dbPath` (and
	// so only triggers the runner's pre-migration backup) when the file
	// already had real pre-existing data BEFORE this open began - a
	// brand-new, empty database has nothing worth backing up.
	if (!options?.skipTenantConsolidation) {
		await runMigrations(
			db,
			[buildConsolidateLegacyTenantsBackfillMigration({ excludeTenantId: db.tenantId })],
			hadPreExistingData ? { dbPath } : undefined
		);
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
 * The pre-ISS63 per-workspace tenant formula (ADR7's original, incomplete
 * migration): one tenant minted per folder, named from the folder's own
 * name plus a path hash. Kept only to locate a workspace's old
 * per-tenant-directory database file (the even-older one-database-per-tenant
 * layout, see `resolveTenantDirectory`) so its data can be imported into the
 * shared database under this same id - once there, the one-time historical
 * fold-in migration (`buildConsolidateLegacyTenantsBackfillMigration`,
 * ISS181) finds and folds it into a `project` the next time it runs
 * (only once, ever, per database file - not from every later open).
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
 * pre-migration file backup) when `hadPreExistingData` is true - a
 * brand-new, empty database has nothing worth backing up, matching the
 * existing per-tenant backup behavior in `ensureFullChainInvariant`.
 * Takes `hadPreExistingData` as a parameter (computed once by the caller,
 * before any bootstrap step runs) rather than recomputing
 * `databaseHasAnyData` itself, so it shares the exact same "before this
 * open touched anything" snapshot with the one-time legacy-tenant fold-in
 * migration that runs later in the same open (ISS181) - by the time that
 * later migration runs, the per-current-tenant trio below has already
 * written this tenant's own PROJ0/EPIC0/counters, which would make a
 * freshly re-computed `databaseHasAnyData` always true even for a
 * genuinely brand-new install.
 */
function runBootstrapBackfillMigrations(db: DatabaseHandle, dbPath: string, hadPreExistingData: boolean): Promise<void> {
	return runMigrations(db, BOOTSTRAP_BACKFILL_MIGRATIONS, hadPreExistingData ? { dbPath } : undefined);
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
 * (the exact same deterministic formula the one-time historical fold-in
 * migration, ISS181, used to fold it in) in `project_migrations`; falls
 * back to the tenant's sentinel `DEFAULT_PROJECT_ID` when this workspace
 * was never consolidated - a fresh single-project tenant, or a workspace
 * not yet folded in - keeping that common case resolving exactly as before
 * ISS166.
 */
export function resolveCurrentProjectId(db: DatabaseHandle, currentWorkingDirectory: string = process.cwd()): string {
	const legacyTenantId = resolveLegacyWorkspaceTenantId(currentWorkingDirectory);
	const migration = getProjectMigration(db, legacyTenantId);
	return migration?.projectId ?? DEFAULT_PROJECT_ID;
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