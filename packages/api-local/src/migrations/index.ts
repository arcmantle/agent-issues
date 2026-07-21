import type { Migration } from "@agent-issues/core";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { backfillTenantBootstrapMigration } from "./0004-backfill-tenant-bootstrap.js";
import { addEntityProjectIdMigration } from "./0009-add-entity-project-id.js";
import { migrateHandoffsToEntitiesMigration } from "./0010-migrate-handoffs-to-entities.js";
import { entityRevisionDeltaMigration } from "./0011-entity-revision-delta.js";
import { entityLifecycleDeltaMigration } from "./0012-entity-lifecycle-delta.js";
import { entityParentDeltaMarkerMigration } from "./0013-entity-parent-delta-marker.js";
import { historyEntriesToDeltasMigration } from "./0014-history-entries-to-deltas.js";
import { contextRevisionDeltaMigration } from "./0015-context-revision-delta.js";
import { contextTermRevisionDeltaMigration } from "./0016-context-term-revision-delta.js";
import { entityRestorationSourceMigration } from "./0017-entity-restoration-source.js";
import { contextRestorationSourceMigration } from "./0018-context-restoration-source.js";
import { contextRevisionBaselinesMigration } from "./0019-context-revision-baselines.js";

/**
 * The full ordered migration chain for `packages/api-local`, replacing
 * drizzle-kit's auto-diffed `.sql` files and `__drizzle_migrations` ledger
 * (ADR43). Pass this list to `runMigrations` in the order declared here.
 */
export const migrations: Migration[] = [baselineV7Migration, backfillTenantBootstrapMigration, addEntityProjectIdMigration, migrateHandoffsToEntitiesMigration, entityRevisionDeltaMigration, entityLifecycleDeltaMigration, entityParentDeltaMarkerMigration, historyEntriesToDeltasMigration, contextRevisionDeltaMigration, contextTermRevisionDeltaMigration, entityRestorationSourceMigration, contextRestorationSourceMigration, contextRevisionBaselinesMigration];
