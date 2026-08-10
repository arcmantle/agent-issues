import { createHash, randomUUID } from "node:crypto";

import { createReverseFieldPatch, encodeCanonicalReference, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, type StorageDriver } from "@agent-issues/core";
import { runStorageDriverContractSuite } from "@agent-issues/core/storage-driver-contract";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "./db/test-tenant-cleanup.js";
import { PgStore } from "./pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced (Postgres superusers bypass RLS
// unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const schemaName = `storage_contract_${randomUUID().replace(/-/g, "_")}`;
const schemaOptions = `-c search_path=${schemaName}`;
let adminPool: Pool;

beforeAll(async () => {
	adminPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: schemaOptions });
	const databasePool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	try {
		await databasePool.query(`CREATE SCHEMA ${schemaName}`);
		await migratePgDatabase(adminPool);
		await databasePool.query(`GRANT USAGE ON SCHEMA ${schemaName} TO agent_issues_app`);
		await databasePool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaName} TO agent_issues_app`);
	} finally {
		await databasePool.end();
	}
});

afterAll(async () => {
	try {
		await cleanupTestTenants(adminPool);
	} finally {
		await adminPool.end();
		const databasePool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		try {
			await databasePool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		} finally {
			await databasePool.end();
		}
	}
});

// Every store in this suite gets its own dedicated pool (rather than the
// single shared `appPool` `pg-store.test.ts` uses) because `PgStore.close()`
// ends the whole pool it was given, and the shared contract's lifecycle
// test deliberately calls `close()` and expects only that one store's
// connection to be gone. Each contract test closes its own store (and thus
// its own pool) in a `finally`, so no extra teardown is needed here.
async function openPgTestStore(): Promise<StorageDriver> {
	const pool = new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions });
	return new PgStore(pool, createTestTenantId());
}

// Shares one tenant across the identities a single contract test opens, so
// the separation it asserts is genuinely project-level and not tenant-level.
let contractTenantId: string | undefined;
async function openPgTestStoreForProject(projectIdentity: string): Promise<StorageDriver> {
	contractTenantId ??= createTestTenantId();
	const pool = new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions });
	return new PgStore(pool, contractTenantId, projectIdentity);
}

beforeEach(() => {
	contractTenantId = undefined;
});

runStorageDriverContractSuite({
	label: "PgStore (Postgres)",
	openStore: openPgTestStore,
	openStoreForProject: openPgTestStoreForProject
});

it("imports and exports a canonical issue comment with its ordered references", async () => {
	const store = await openPgTestStore();
	try {
		const issue = await store.createEntity({ kind: "issue", title: "Commented issue" });
		const referencedIssue = await store.createEntity({ kind: "issue", title: "Referenced issue" });
		const id = randomUUID();
		const reference = encodeCanonicalReference("issueComment", id);
		const body = "Needs a follow-up.";
		const referencedIssueIds = [referencedIssue.id];
		const now = "2026-08-08T00:00:00.000Z";
		const bundle = await store.exportCanonicalChains();
		await store.importCanonicalChains({
			...bundle,
			issueComments: [{
				head: {
					id,
					reference,
					issueId: issue.id,
					createdBy: issue.createdBy,
					updatedBy: issue.updatedBy,
					body,
					referencedIssueIds,
					tombstone: false,
					revision: 1,
					contentHash: createHash("sha256").update(JSON.stringify({ body, referencedIssueIds, tombstone: false })).digest("hex"),
					createdAt: now,
					updatedAt: now
				},
				deltas: []
			}]
		});

		expect((await store.exportCanonicalChains()).issueComments).toEqual(expect.arrayContaining([
			expect.objectContaining({ head: expect.objectContaining({ id, reference, issueId: issue.id, referencedIssueIds }) })
		]));

		const updatedReferencedIssueIds: string[] = [];
		const updatedAt = "2026-08-08T01:00:00.000Z";
		const updatedComment = {
			head: {
				id,
				reference,
				issueId: issue.id,
				createdBy: issue.createdBy,
				updatedBy: issue.updatedBy,
				body,
				referencedIssueIds: updatedReferencedIssueIds,
				tombstone: false,
				revision: 2,
				contentHash: createHash("sha256").update(JSON.stringify({ body, referencedIssueIds: updatedReferencedIssueIds, tombstone: false })).digest("hex"),
				createdAt: now,
				updatedAt
			},
			deltas: [{
				id: randomUUID(),
				revision: 2,
				author: issue.updatedBy,
				createdAt: updatedAt,
				...createReverseFieldPatch(
					{ body, referencedIssueIds: updatedReferencedIssueIds, tombstone: false },
					{ body, referencedIssueIds, tombstone: false },
					ISSUE_COMMENT_REVERSE_PATCH_REGISTRY
				)
			}]
		};
		const updatedBundle = await store.exportCanonicalChains();
		await store.importCanonicalChains({ ...updatedBundle, issueComments: [updatedComment] });

		expect((await store.exportCanonicalChains()).issueComments.find((chain) => chain.head.id === id)).toMatchObject({
			head: { referencedIssueIds: [] },
			deltas: [expect.objectContaining({ revision: 2 })]
		});
	} finally {
		await store.close();
	}
});
