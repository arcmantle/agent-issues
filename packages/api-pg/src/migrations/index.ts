import type { Migration } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { enableRlsPoliciesMigration } from "./0001-enable-rls-policies.js";
import { addEntityProjectIdMigration } from "./0002-add-entity-project-id.js";
import { migrateHandoffsToEntitiesMigration } from "./0003-migrate-handoffs-to-entities.js";

/**
 * The full ordered migration chain for `packages/api`, replacing
 * drizzle-kit's auto-diffed `.sql` files and `__drizzle_migrations` ledger
 * (ADR43). Pass this list to `runMigrations` in the order declared here.
 */
export const migrations: Migration[] = [baselineV7Migration, enableRlsPoliciesMigration, addEntityProjectIdMigration, migrateHandoffsToEntitiesMigration];
