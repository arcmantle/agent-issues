import type { Migration } from "../db/migration-runner.js";
import { adrStatusMigration } from "./adr-status-migration.js";
import { finalBaselineMigration } from "./final-baseline.js";
import { userDirectoryMigration } from "./user-directory.js";
import { recordProvenanceMigration } from "./record-provenance.js";
import { contextTermProvenanceMigration } from "./context-term-provenance.js";
import { relationProvenanceMigration } from "./relation-provenance.js";
import { issueCommentsMigration } from "./issue-comments.js";

/**
 * Approved runner migrations for an empty Postgres source profile. Legacy v7
 * sources use the direct transformer and do not replay historical migrations.
 */
export const migrations: Migration[] = [finalBaselineMigration, adrStatusMigration, userDirectoryMigration, recordProvenanceMigration, contextTermProvenanceMigration, relationProvenanceMigration, issueCommentsMigration];
