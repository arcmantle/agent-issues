import type { Migration } from "@agent-issues/core";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { backfillTenantBootstrapMigration } from "./0004-backfill-tenant-bootstrap.js";

/**
 * The full ordered migration chain for `packages/api-local`, replacing
 * drizzle-kit's auto-diffed `.sql` files and `__drizzle_migrations` ledger
 * (ADR43). Pass this list to `runMigrations` in the order declared here.
 */
export const migrations: Migration[] = [baselineV7Migration, backfillTenantBootstrapMigration];
