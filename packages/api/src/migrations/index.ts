import { historyVersionIndexNonUniqueMigration } from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { enableRlsPoliciesMigration } from "./0001-enable-rls-policies.js";

/**
 * The full ordered migration chain for `packages/api`, replacing
 * drizzle-kit's auto-diffed `.sql` files and `__drizzle_migrations` ledger
 * (ADR43). Pass this list to `runMigrations` in the order declared here.
 * `0002-history-version-index-non-unique` is imported directly from
 * `@agent-issues/core` rather than duplicated (ISS174): its content is
 * identical for both packages, since api's baseline recreates the same
 * originally-unique index core's history predates.
 */
export const migrations: Migration[] = [baselineV7Migration, enableRlsPoliciesMigration, historyVersionIndexNonUniqueMigration];
