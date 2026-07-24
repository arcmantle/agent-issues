import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
	createReverseFieldPatch,
	decodeCanonicalReference,
	deriveMigratedContextIdentity,
	deriveMigratedEntityIdentity,
	encodeContextRecordKey,
	encodeEntityRecordKey,
	ENTITY_REVERSE_PATCH_REGISTRY
} from "@agent-issues/core";
import { runMigrations } from "../db/migration-runner.js";
import { entityStableIdentitiesMigration } from "./0024-entity-stable-identities.js";
import { correctStableIdentityStorageMigration } from "./0025-correct-stable-identity-storage.js";

const databases: Database.Database[] = [];

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

describe("entity Stable identity migration", () => {
	it("replaces a sequential primary identity with a UUID and retains it as a Legacy alias", async () => {
		const database = new Database(":memory:");
		databases.push(database);
		database.exec(`
			CREATE TABLE entities (
				tenant_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
				status TEXT NOT NULL, body TEXT NOT NULL, body_source TEXT NOT NULL, revision INTEGER NOT NULL,
				content_hash TEXT NOT NULL, tombstone INTEGER NOT NULL, project_id TEXT, created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
			);
			CREATE TABLE relations (tenant_id TEXT, from_id TEXT, to_id TEXT, type TEXT, created_at TEXT);
			CREATE TABLE contexts (tenant_id TEXT, key TEXT, scope_entity_id TEXT);
			CREATE TABLE history_entries (tenant_id TEXT, entity_id TEXT, parent_id TEXT);
			CREATE TABLE project_migrations (tenant_id TEXT, project_id TEXT);
			CREATE TABLE revision_patch_entries (
				id TEXT, tenant_id TEXT, project_id TEXT, record_kind TEXT, record_key TEXT, revision INTEGER,
				patch_format INTEGER, reverse_patch BLOB, source_hash BLOB, target_hash BLOB
			);
			INSERT INTO entities VALUES ('tenant-a', 'ISS312', 'issue', 'Existing', 'done', '', 'authored', 1, 'hash', 0, NULL, '2026-01-01', '2026-01-01');
		`);

		await runMigrations(database, [entityStableIdentitiesMigration]);

		const expected = deriveMigratedEntityIdentity("issue", "ISS312");
		const entity = database.prepare("SELECT id, reference FROM entities").get();
		expect(entity).toEqual({ id: expected.stableId, reference: expected.reference });
		expect(decodeCanonicalReference(expected.reference).stableId).toBe(expected.stableId);
		expect(database.prepare("SELECT alias, entity_id FROM entity_aliases").get()).toEqual({
			alias: "ISS312",
			entity_id: expected.stableId
		});
	});

	it("corrects databases that already stored Canonical references as primary identities", async () => {
		const database = new Database(":memory:");
		databases.push(database);
		const identity = deriveMigratedEntityIdentity("issue", "ISS312");
		const contextIdentity = deriveMigratedContextIdentity("INIT3");
		const transition = createReverseFieldPatch(
			{ title: "Existing", body: "", bodySource: "authored", status: "done", parentId: null, tombstone: false },
			{ title: "Earlier", body: "", bodySource: "authored", status: "todo", parentId: null, tombstone: false },
			ENTITY_REVERSE_PATCH_REGISTRY
		);
		database.exec(`
			CREATE TABLE entities (
				tenant_id TEXT NOT NULL, id TEXT NOT NULL, stable_id TEXT NOT NULL, kind TEXT NOT NULL,
				title TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, body_source TEXT NOT NULL,
				revision INTEGER NOT NULL, content_hash TEXT NOT NULL, tombstone INTEGER NOT NULL,
				project_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				PRIMARY KEY (tenant_id, id)
			);
			CREATE UNIQUE INDEX entities_tenant_stable_id_idx ON entities (tenant_id, stable_id);
			CREATE TABLE entity_aliases (
				tenant_id TEXT NOT NULL, alias TEXT NOT NULL, entity_stable_id TEXT NOT NULL,
				PRIMARY KEY (tenant_id, alias), UNIQUE (tenant_id, entity_stable_id)
			);
			CREATE TABLE relations (tenant_id TEXT, from_id TEXT, to_id TEXT, type TEXT, created_at TEXT);
			CREATE TABLE contexts (
				tenant_id TEXT NOT NULL, key TEXT NOT NULL, id TEXT NOT NULL, stable_id TEXT NOT NULL,
				scope_entity_id TEXT, title TEXT, summary TEXT, created_at TEXT, updated_at TEXT,
				revision INTEGER, content_hash TEXT, PRIMARY KEY (tenant_id, key)
			);
			CREATE UNIQUE INDEX contexts_tenant_id_idx ON contexts (tenant_id, id);
			CREATE UNIQUE INDEX contexts_tenant_stable_id_idx ON contexts (tenant_id, stable_id);
			CREATE TABLE history_entries (
				id TEXT, tenant_id TEXT, entity_id TEXT, title TEXT, body TEXT, body_source TEXT,
				status TEXT, parent_id TEXT
			);
			CREATE TABLE project_migrations (tenant_id TEXT, project_id TEXT);
			CREATE TABLE revision_patch_entries (
				id TEXT, tenant_id TEXT, project_id TEXT, record_kind TEXT, record_key TEXT,
				revision INTEGER, patch_format INTEGER, reverse_patch BLOB, source_hash BLOB,
				target_hash BLOB, created_at TEXT
			);
		`);
		database.prepare(`INSERT INTO entities VALUES (?, ?, ?, 'issue', 'Existing', 'done', '', 'authored', 1, 'hash', 0, NULL, '2026-01-01', '2026-01-01')`)
			.run("tenant-a", identity.reference, identity.stableId);
		database.prepare("INSERT INTO entity_aliases VALUES ('tenant-a', 'ISS312', ?)").run(identity.stableId);
		database.prepare("INSERT INTO relations VALUES ('tenant-a', ?, ?, 'relatesTo', '2026-01-01')")
			.run(identity.reference, identity.reference);
		database.prepare("INSERT INTO history_entries VALUES ('patch-1', 'tenant-a', 'ISS312', 'Existing', '', 'authored', 'done', ?)")
			.run(identity.reference);
		database.prepare("INSERT INTO project_migrations VALUES ('tenant-a', ?)").run(identity.reference);
		database.prepare("INSERT INTO contexts VALUES ('tenant-a', 'INIT3', ?, ?, 'ISS312', 'Context', '', '2026-01-01', '2026-01-01', 1, 'hash')")
			.run(contextIdentity.reference, contextIdentity.stableId);
		database.prepare(`INSERT INTO revision_patch_entries VALUES ('patch-1', 'tenant-a', ?, 'entity', ?, 1, ?, ?, ?, ?, '2026-01-01')`)
			.run(identity.reference, encodeEntityRecordKey(identity.stableId), transition.patchFormat, Buffer.from(transition.reversePatch), Buffer.from(transition.sourceHash, "hex"), Buffer.from(transition.targetHash, "hex"));
		database.prepare(`INSERT INTO revision_patch_entries VALUES ('context-patch', 'tenant-a', ?, 'context', ?, 1, 1, X'', X'', X'', '2026-01-01')`)
			.run(identity.reference, encodeContextRecordKey(contextIdentity.reference));

		await runMigrations(database, [correctStableIdentityStorageMigration]);

		expect(database.prepare("SELECT id, reference FROM entities").get()).toEqual({
			id: identity.stableId,
			reference: identity.reference
		});
		expect(database.prepare("SELECT alias, entity_id FROM entity_aliases").get()).toEqual({
			alias: "ISS312",
			entity_id: identity.stableId
		});
		expect(database.prepare("SELECT from_id, to_id FROM relations").get()).toEqual({
			from_id: identity.stableId,
			to_id: identity.stableId
		});
		expect(database.prepare("SELECT entity_id, parent_id FROM history_entries").get()).toEqual({
			entity_id: identity.stableId,
			parent_id: identity.stableId
		});
		expect(database.prepare("SELECT project_id FROM project_migrations").get()).toEqual({ project_id: identity.stableId });
		expect(database.prepare("SELECT id, reference, scope_entity_id FROM contexts").get()).toEqual({
			id: contextIdentity.stableId,
			reference: contextIdentity.reference,
			scope_entity_id: identity.stableId
		});
		expect(database.prepare("SELECT record_kind, record_key, project_id FROM revision_patch_entries ORDER BY id").all()).toEqual([
			{ record_kind: "context", record_key: encodeContextRecordKey(contextIdentity.stableId), project_id: identity.stableId },
			{ record_kind: "entity", record_key: encodeEntityRecordKey(identity.stableId), project_id: identity.stableId }
		]);
	});
});