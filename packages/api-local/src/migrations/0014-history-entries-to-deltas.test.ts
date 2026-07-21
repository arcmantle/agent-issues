import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { DatabaseHandle } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { createSqliteExecutor } from "../db/sqlite-executor.js";
import { materializeEntityRevision } from "../features/entity-store/store.js";
import { baselineV7Migration } from "./0000-baseline-v7.js";
import { backfillTenantBootstrapMigration } from "./0004-backfill-tenant-bootstrap.js";
import { addEntityProjectIdMigration } from "./0009-add-entity-project-id.js";
import { migrateHandoffsToEntitiesMigration } from "./0010-migrate-handoffs-to-entities.js";
import { entityRevisionDeltaMigration } from "./0011-entity-revision-delta.js";
import { entityLifecycleDeltaMigration } from "./0012-entity-lifecycle-delta.js";
import { entityParentDeltaMarkerMigration } from "./0013-entity-parent-delta-marker.js";
import { historyEntriesToDeltasMigration } from "./0014-history-entries-to-deltas.js";
import { entityRestorationSourceMigration } from "./0017-entity-restoration-source.js";

const PRIOR_MIGRATIONS = [
	baselineV7Migration,
	backfillTenantBootstrapMigration,
	addEntityProjectIdMigration,
	migrateHandoffsToEntitiesMigration,
	entityRevisionDeltaMigration,
	entityLifecycleDeltaMigration,
	entityParentDeltaMarkerMigration
];

const dbs: Database.Database[] = [];

afterEach(() => {
	for (const db of dbs.splice(0)) {
		db.close();
	}
});

async function freshDb(): Promise<DatabaseHandle> {
	const raw = new Database(":memory:");
	dbs.push(raw);
	await runMigrations(raw, PRIOR_MIGRATIONS);
	const db = raw as DatabaseHandle;
	db.tenantId = "t";
	db.currentProjectId = "PROJ0";
	return db;
}

function seedEntity(
	db: DatabaseHandle,
	id: string,
	title: string,
	body: string,
	status: string = "open"
): void {
	db.prepare(
		`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, project_id, created_at, updated_at)
         VALUES ('t', ?, 'issue', ?, ?, ?, 'authored', NULL, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
	).run(id, title, status, body);
}

function seedHistoryEntry(
	db: DatabaseHandle,
	entryId: string,
	entityId: string,
	version: number,
	author: string,
	title: string,
	body: string,
	status: string,
	parentId: string | null,
	createdAt: string
): void {
	db.prepare(
		`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
         VALUES (?, 't', ?, ?, ?, ?, ?, 'authored', ?, ?, ?)`
	).run(entryId, entityId, version, author, title, body, status, parentId, createdAt);
}

type DeltaRow = { id: string; revision: number; author: string; prior_title: string; prior_body: string; prior_status: string | null; prior_parent_id: string | null; prior_parent_changed: number; prior_tombstone: number | null; created_at: string };

function deltaRows(db: DatabaseHandle, entityId: string): DeltaRow[] {
	return db
		.prepare(`SELECT * FROM entity_delta_entries WHERE tenant_id = 't' AND entity_id = ? ORDER BY revision`)
		.all(entityId) as DeltaRow[];
}

function entityRevision(db: DatabaseHandle, entityId: string): number {
	const row = db.prepare(`SELECT revision FROM entities WHERE tenant_id = 't' AND id = ?`).get(entityId) as { revision: number };
	return row.revision;
}

// ─── RED: single golden materialization fixture ───────────────────────────────

describe("historyEntriesToDeltasMigration (ISS265) – materialization fixture", () => {
	it("makes all historical revisions materializable from a three-version history", async () => {
		const db = await freshDb();


		// Seed entity at revision 1 (post-0011 default state)
		seedEntity(db, "ISS1", "Version Three Title", "body v3", "in-progress");

		// Three pre-0011 snapshots in history_entries
		seedHistoryEntry(db, "hist-v1", "ISS1", 1, "system", "Version One Title", "body v1", "open", null, "2024-01-01T10:00:00.000Z");
		seedHistoryEntry(db, "hist-v2", "ISS1", 2, "alice", "Version Two Title", "body v2", "open", null, "2024-01-02T10:00:00.000Z");
		seedHistoryEntry(db, "hist-v3", "ISS1", 3, "bob", "Version Three Title", "body v3", "in-progress", null, "2024-01-03T10:00:00.000Z");

		// Run the migration under test
		await runMigrations(db, [historyEntriesToDeltasMigration, entityRestorationSourceMigration]);

		// Entity head advances to the max history version
		expect(entityRevision(db, "ISS1")).toBe(3);

		// Revision 1 is a metadata baseline; later rows are reverse transitions.
		const deltas = deltaRows(db, "ISS1");
		expect(deltas.map((d) => d.revision)).toEqual([1, 2, 3]);

		const executor = createSqliteExecutor(db);

		// Revision 3 – current head
		expect(materializeEntityRevision(executor, { entityId: "ISS1", revision: 3 })).toMatchObject({
			targetRevision: 3,
			headRevision: 3,
			title: "Version Three Title",
			body: "body v3",
			status: "in-progress",
			author: "bob",
			createdAt: "2024-01-03T10:00:00.000Z"
		});

		// Revision 2 – one step back
		expect(materializeEntityRevision(executor, { entityId: "ISS1", revision: 2 })).toMatchObject({
			targetRevision: 2,
			headRevision: 3,
			title: "Version Two Title",
			body: "body v2",
			status: "open",
			author: "alice",
			createdAt: "2024-01-02T10:00:00.000Z"
		});

		// Revision 1 – origin metadata comes from its baseline patch.
		expect(materializeEntityRevision(executor, { entityId: "ISS1", revision: 1 })).toMatchObject({
			targetRevision: 1,
			headRevision: 3,
			title: "Version One Title",
			body: "body v1",
			status: "open",
			author: "system"
		});
	});
});

// ─── Metadata, delta IDs, and stable history id ───────────────────────────────

describe("historyEntriesToDeltasMigration – metadata and stable IDs", () => {
	it("uses the source history entry id as the delta id (deterministic across re-runs)", async () => {
		const db = await freshDb();

		seedEntity(db, "ISS2", "Title B", "body b");
		seedHistoryEntry(db, "stable-id-v1", "ISS2", 1, "system", "Title A", "body a", "open", null, "2024-02-01T00:00:00.000Z");
		seedHistoryEntry(db, "stable-id-v2", "ISS2", 2, "carol", "Title B", "body b", "open", null, "2024-02-02T00:00:00.000Z");

		await runMigrations(db, [historyEntriesToDeltasMigration]);

		const deltas = deltaRows(db, "ISS2");
		expect(deltas.map((delta) => delta.id)).toEqual(["stable-id-v1", "stable-id-v2"]);
	});

	it("preserves author and created_at from the source history entry", async () => {
		const db = await freshDb();

		seedEntity(db, "ISS3", "T2", "b2");
		seedHistoryEntry(db, "hv1", "ISS3", 1, "system", "T1", "b1", "open", null, "2024-03-01T08:00:00.000Z");
		seedHistoryEntry(db, "hv2", "ISS3", 2, "dana", "T2", "b2", "open", null, "2024-03-02T09:00:00.000Z");

		await runMigrations(db, [historyEntriesToDeltasMigration]);

		const delta = deltaRows(db, "ISS3").find((row) => row.revision === 2)!;
		expect(delta!.author).toBe("dana");
		expect(delta!.created_at).toBe("2024-03-02T09:00:00.000Z");
	});
});

// ─── Null/non-null parent transitions ────────────────────────────────────────

describe("historyEntriesToDeltasMigration – parent transitions", () => {
	it("records prior_parent_changed=1 when parent_id changes across versions", async () => {
		const db = await freshDb();

		seedEntity(db, "ISS4", "Moved Issue", "body");
		// Version 1: parentId = INIT1; version 2: parentId = INIT2 (moved)
		seedHistoryEntry(db, "pv1", "ISS4", 1, "system", "Moved Issue", "body", "open", "INIT1", "2024-04-01T00:00:00.000Z");
		seedHistoryEntry(db, "pv2", "ISS4", 2, "eve", "Moved Issue", "body", "open", "INIT2", "2024-04-02T00:00:00.000Z");

		await runMigrations(db, [historyEntriesToDeltasMigration]);

		const delta = deltaRows(db, "ISS4").find((row) => row.revision === 2)!;
		expect(delta!.prior_parent_changed).toBe(1);
		expect(delta!.prior_parent_id).toBe("INIT1");
	});

	it("records prior_parent_changed=0 when parent_id is unchanged", async () => {
		const db = await freshDb();

		seedEntity(db, "ISS5", "Stable Issue", "body");
		seedHistoryEntry(db, "sv1", "ISS5", 1, "system", "Old Title", "body", "open", "INIT1", "2024-05-01T00:00:00.000Z");
		seedHistoryEntry(db, "sv2", "ISS5", 2, "frank", "Stable Issue", "body", "open", "INIT1", "2024-05-02T00:00:00.000Z");

		await runMigrations(db, [historyEntriesToDeltasMigration]);

		const [delta] = deltaRows(db, "ISS5");
		expect(delta!.prior_parent_changed).toBe(0);
	});

	it("records prior_parent_changed=1 when parent_id transitions from null to a value", async () => {
		const db = await freshDb();

		seedEntity(db, "ISS6", "Parented Issue", "body");
		seedHistoryEntry(db, "npv1", "ISS6", 1, "system", "Parented Issue", "body", "open", null, "2024-06-01T00:00:00.000Z");
		seedHistoryEntry(db, "npv2", "ISS6", 2, "grace", "Parented Issue", "body", "open", "INIT1", "2024-06-02T00:00:00.000Z");

		await runMigrations(db, [historyEntriesToDeltasMigration]);

		const delta = deltaRows(db, "ISS6").find((row) => row.revision === 2)!;
		expect(delta!.prior_parent_changed).toBe(1);
		expect(delta!.prior_parent_id).toBeNull();
	});
});

// ─── Tombstone-ready rows ──────────────────────────────────────────────────────

describe("historyEntriesToDeltasMigration – tombstone-ready rows", () => {
	it("sets prior_tombstone to null for all migrated deltas (history_entries have no tombstone state)", async () => {
		const db = await freshDb();

		seedEntity(db, "ISS7", "Entity to delete", "body");
		seedHistoryEntry(db, "tv1", "ISS7", 1, "system", "Entity to delete", "body", "open", null, "2024-07-01T00:00:00.000Z");
		seedHistoryEntry(db, "tv2", "ISS7", 2, "heidi", "Entity to delete", "body", "done", null, "2024-07-02T00:00:00.000Z");

		await runMigrations(db, [historyEntriesToDeltasMigration]);

		const [delta] = deltaRows(db, "ISS7");
		expect(delta!.prior_tombstone).toBeNull();
	});
});

// ─── Replay-safety ────────────────────────────────────────────────────────────

describe("historyEntriesToDeltasMigration – replay-safety", () => {
	it("is idempotent: running migration twice produces identical delta rows", async () => {
		const db = await freshDb();

		seedEntity(db, "ISS8", "Idempotent", "body");
		seedHistoryEntry(db, "rv1", "ISS8", 1, "system", "Idempotent v1", "body v1", "open", null, "2024-08-01T00:00:00.000Z");
		seedHistoryEntry(db, "rv2", "ISS8", 2, "ivan", "Idempotent", "body", "open", null, "2024-08-02T00:00:00.000Z");

		await runMigrations(db, [historyEntriesToDeltasMigration]);
		const firstRun = deltaRows(db, "ISS8");
		const firstRevision = entityRevision(db, "ISS8");

		// Remove the ledger row so the migration SQL itself runs a second time.
		db.prepare(`DELETE FROM schema_migrations WHERE id = ?`).run(historyEntriesToDeltasMigration.id);
		await runMigrations(db, [historyEntriesToDeltasMigration]);
		const secondRun = deltaRows(db, "ISS8");
		const secondRevision = entityRevision(db, "ISS8");

		expect(secondRun).toEqual(firstRun);
		expect(secondRevision).toBe(firstRevision);
	});

	it("splices snapshot revisions before existing deltas without losing either chain", async () => {
		const db = await freshDb();
		db.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, revision, content_hash, project_id, created_at, updated_at)
			 VALUES ('t', 'ISS9', 'issue', 'Post-migration edit', 'open', 'body-new', 'authored', 2, 'somehash', NULL, '2024-09-01T00:00:00.000Z', '2024-09-03T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO entity_delta_entries (id, tenant_id, entity_id, revision, author, prior_title, prior_body, prior_body_source, prior_status, prior_parent_id, prior_parent_changed, prior_tombstone, created_at)
			 VALUES ('existing-delta', 't', 'ISS9', 2, 'judy', 'Snapshot v2', 'body-v2', 'authored', NULL, NULL, 0, NULL, '2024-09-03T00:00:00.000Z')`
		).run();
		seedHistoryEntry(db, "pre-v1", "ISS9", 1, "creator", "Snapshot v1", "body-v1", "open", null, "2024-09-01T00:00:00.000Z");
		seedHistoryEntry(db, "pre-v2", "ISS9", 2, "editor", "Snapshot v2", "body-v2", "open", null, "2024-09-02T00:00:00.000Z");

		await runMigrations(db, [historyEntriesToDeltasMigration, entityRestorationSourceMigration]);

		const deltas = deltaRows(db, "ISS9");
		expect(deltas.map((delta) => [delta.id, delta.revision])).toEqual([
			["pre-v1", 1],
			["pre-v2", 2],
			["existing-delta", 3]
		]);
		expect(entityRevision(db, "ISS9")).toBe(3);

		const executor = createSqliteExecutor(db);
		expect(materializeEntityRevision(executor, { entityId: "ISS9", revision: 1 })).toMatchObject({
			title: "Snapshot v1",
			body: "body-v1",
			author: "creator",
			createdAt: "2024-09-01T00:00:00.000Z"
		});
		expect(materializeEntityRevision(executor, { entityId: "ISS9", revision: 2 })).toMatchObject({
			title: "Snapshot v2",
			body: "body-v2",
			author: "editor"
		});
		expect(materializeEntityRevision(executor, { entityId: "ISS9", revision: 3 })).toMatchObject({
			title: "Post-migration edit",
			body: "body-new",
			author: "judy"
		});
	});
});

// ─── Multi-tenant isolation ───────────────────────────────────────────────────

describe("historyEntriesToDeltasMigration – multi-tenant", () => {
	it("processes each tenant independently without cross-contamination", async () => {
		const db = await freshDb();

		// Tenant A entity with 2 versions
		db.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, project_id, created_at, updated_at)
             VALUES ('tenantA', 'E1', 'issue', 'Title A2', 'open', 'body-a2', 'authored', NULL, '2024-10-01T00:00:00.000Z', '2024-10-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
             VALUES ('a-v1', 'tenantA', 'E1', 1, 'system', 'Title A1', 'body-a1', 'authored', 'open', NULL, '2024-10-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
             VALUES ('a-v2', 'tenantA', 'E1', 2, 'kim', 'Title A2', 'body-a2', 'authored', 'open', NULL, '2024-10-02T00:00:00.000Z')`
		).run();

		// Tenant B entity with 2 versions (same entity id, different tenant)
		db.prepare(
			`INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, project_id, created_at, updated_at)
             VALUES ('tenantB', 'E1', 'issue', 'Title B2', 'open', 'body-b2', 'authored', NULL, '2024-10-01T00:00:00.000Z', '2024-10-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
             VALUES ('b-v1', 'tenantB', 'E1', 1, 'system', 'Title B1', 'body-b1', 'authored', 'open', NULL, '2024-10-01T00:00:00.000Z')`
		).run();
		db.prepare(
			`INSERT INTO history_entries (id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
             VALUES ('b-v2', 'tenantB', 'E1', 2, 'lee', 'Title B2', 'body-b2', 'authored', 'open', NULL, '2024-10-02T00:00:00.000Z')`
		).run();

		await runMigrations(db, [historyEntriesToDeltasMigration]);

		const aDelta = db
			.prepare(`SELECT id, prior_title FROM entity_delta_entries WHERE tenant_id = 'tenantA' AND entity_id = 'E1'`)
			.all() as Array<{ id: string; prior_title: string }>;
		const bDelta = db
			.prepare(`SELECT id, prior_title FROM entity_delta_entries WHERE tenant_id = 'tenantB' AND entity_id = 'E1'`)
			.all() as Array<{ id: string; prior_title: string }>;

		expect(aDelta).toHaveLength(2);
		expect(aDelta).toContainEqual({ id: "a-v2", prior_title: "Title A1" });

		expect(bDelta).toHaveLength(2);
		expect(bDelta).toContainEqual({ id: "b-v2", prior_title: "Title B1" });
	});
});

describe("historyEntriesToDeltasMigration – concurrent snapshots", () => {
	it("linearizes duplicate versions by version, timestamp, and stable id", async () => {
		const db = await freshDb();
		seedEntity(db, "ISS10", "Winning title", "winning body");
		seedHistoryEntry(db, "base", "ISS10", 1, "creator", "Base title", "base body", "open", null, "2024-11-01T00:00:00.000Z");
		seedHistoryEntry(db, "concurrent-a", "ISS10", 2, "alice", "Losing title", "losing body", "open", null, "2024-11-02T00:00:00.000Z");
		seedHistoryEntry(db, "concurrent-b", "ISS10", 2, "bob", "Winning title", "winning body", "open", null, "2024-11-03T00:00:00.000Z");

		await runMigrations(db, [historyEntriesToDeltasMigration, entityRestorationSourceMigration]);

		expect(deltaRows(db, "ISS10").map((delta) => [delta.id, delta.revision])).toEqual([
			["base", 1],
			["concurrent-a", 2],
			["concurrent-b", 3]
		]);
		const executor = createSqliteExecutor(db);
		expect(materializeEntityRevision(executor, { entityId: "ISS10", revision: 2 })).toMatchObject({
			title: "Losing title",
			author: "alice"
		});
		expect(materializeEntityRevision(executor, { entityId: "ISS10", revision: 3 })).toMatchObject({
			title: "Winning title",
			author: "bob"
		});
	});
});

// ─── schema_migrations ledger ────────────────────────────────────────────────

describe("historyEntriesToDeltasMigration – ledger", () => {
	it("records the migration id in schema_migrations", async () => {
		const db = await freshDb();

		await runMigrations(db, [historyEntriesToDeltasMigration]);

		const ledger = db.prepare(`SELECT id FROM schema_migrations WHERE id = ?`).get(historyEntriesToDeltasMigration.id) as { id: string } | undefined;
		expect(ledger).toMatchObject({ id: "0014-history-entries-to-deltas" });
	});
});
