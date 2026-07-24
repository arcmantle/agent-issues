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
import { compactReverseFieldPatchesMigration } from "./0020-compact-reverse-field-patches.js";
import { revisionPatchLedgerMigration } from "./0021-revision-patch-ledger.js";
import { binaryRevisionPatchHashesMigration } from "./0022-binary-revision-patch-hashes.js";
import { contextTermStableIdsMigration } from "./0023-context-term-stable-ids.js";
import { entityStableIdentitiesMigration } from "./0024-entity-stable-identities.js";
import { correctStableIdentityStorageMigration } from "./0025-correct-stable-identity-storage.js";
import { removeEntityAliasesMigration } from "./0026-remove-entity-aliases.js";
import { removeDrizzleLedgerMigration } from "./0027-remove-drizzle-ledger.js";
import { renameRevisionEntriesMigration } from "./0028-rename-revision-entries.js";
import { removeHistoryEntriesMigration } from "./0029-remove-history-entries.js";
import { removeProjectMigrationLedgersMigration } from "./0030-remove-project-migration-ledgers.js";
import { removeMetadataMigration } from "./0031-remove-metadata.js";

/**
 * The full ordered migration chain for `packages/api-local`, replacing
 * drizzle-kit's auto-diffed `.sql` files and `__drizzle_migrations` ledger
 * (ADR43). Pass this list to `runMigrations` in the order declared here.
 */
export const migrations: Migration[] = [baselineV7Migration, backfillTenantBootstrapMigration, addEntityProjectIdMigration, migrateHandoffsToEntitiesMigration, entityRevisionDeltaMigration, entityLifecycleDeltaMigration, entityParentDeltaMarkerMigration, historyEntriesToDeltasMigration, contextRevisionDeltaMigration, contextTermRevisionDeltaMigration, entityRestorationSourceMigration, contextRestorationSourceMigration, contextRevisionBaselinesMigration, compactReverseFieldPatchesMigration, revisionPatchLedgerMigration, binaryRevisionPatchHashesMigration, contextTermStableIdsMigration, entityStableIdentitiesMigration, correctStableIdentityStorageMigration, removeEntityAliasesMigration, removeDrizzleLedgerMigration, renameRevisionEntriesMigration, removeHistoryEntriesMigration, removeProjectMigrationLedgersMigration, removeMetadataMigration];
