import type { Migration } from "../migration-engine.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { historyEntriesMigration } from "./0001-history-entries.js";
import { historyVersionIndexNonUniqueMigration } from "./0002-history-version-index-non-unique.js";
import { projectMigrationsMigration } from "./0003-project-migrations.js";
import { backfillTenantCountersMigration } from "./0004-backfill-tenant-counters.js";
import { backfillFullChainInvariantMigration } from "./0005-backfill-full-chain-invariant.js";
import { backfillHistorySeedMigration } from "./0006-backfill-history-seed.js";

/**
 * The full ordered migration chain for `packages/core`, replacing
 * drizzle-kit's auto-diffed `.sql` files and `__drizzle_migrations` ledger
 * (ADR43). Pass this list to `runMigrations` in the order declared here.
 */
export const migrations: Migration[] = [
	baselineV7Migration,
	historyEntriesMigration,
	historyVersionIndexNonUniqueMigration,
	projectMigrationsMigration,
	backfillTenantCountersMigration,
	backfillFullChainInvariantMigration,
	backfillHistorySeedMigration
];
