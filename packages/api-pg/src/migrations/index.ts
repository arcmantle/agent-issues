import type { Migration } from "../db/migration-runner.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { enableRlsPoliciesMigration } from "./0001-enable-rls-policies.js";
import { addEntityProjectIdMigration } from "./0002-add-entity-project-id.js";
import { migrateHandoffsToEntitiesMigration } from "./0003-migrate-handoffs-to-entities.js";
import { entityRevisionDeltaMigration } from "./0004-entity-revision-delta.js";
import { entityLifecycleDeltaMigration } from "./0005-entity-lifecycle-delta.js";
import { entityParentDeltaMarkerMigration } from "./0006-entity-parent-delta-marker.js";
import { historyEntriesToDeltasMigration } from "./0007-history-entries-to-deltas.js";
import { contextRevisionDeltaMigration } from "./0008-context-revision-delta.js";
import { contextTermRevisionDeltaMigration } from "./0009-context-term-revision-delta.js";
import { entityRestorationSourceMigration } from "./0010-entity-restoration-source.js";
import { contextRestorationSourceMigration } from "./0011-context-restoration-source.js";
import { contextRevisionBaselinesMigration } from "./0012-context-revision-baselines.js";

/**
 * The full ordered migration chain for `packages/api`, replacing
 * drizzle-kit's auto-diffed `.sql` files and `__drizzle_migrations` ledger
 * (ADR43). Pass this list to `runMigrations` in the order declared here.
 */
export const migrations: Migration[] = [baselineV7Migration, enableRlsPoliciesMigration, addEntityProjectIdMigration, migrateHandoffsToEntitiesMigration, entityRevisionDeltaMigration, entityLifecycleDeltaMigration, entityParentDeltaMarkerMigration, historyEntriesToDeltasMigration, contextRevisionDeltaMigration, contextTermRevisionDeltaMigration, entityRestorationSourceMigration, contextRestorationSourceMigration, contextRevisionBaselinesMigration];
