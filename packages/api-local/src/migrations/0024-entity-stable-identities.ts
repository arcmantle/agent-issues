import {
	applyReverseFieldPatch,
	createReverseFieldPatch,
	deriveMigratedEntityIdentity,
	deriveMigratedContextIdentity,
	ENTITY_REVERSE_PATCH_REGISTRY,
	encodeContextRecordKey,
	encodeEntityRecordKey,
	isEntityKind,
	type EntityKind,
	type Migration,
	type ReverseFieldPatchTransition
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

type EntityIdentityRow = {
	tenant_id: string;
	id: string;
	kind: string;
	title: string;
	body: string;
	body_source: string;
	status: string;
	tombstone: number;
};

type EntityPatchRow = { id: string; patch_format: number; reverse_patch: Uint8Array; source_hash: Uint8Array; target_hash: Uint8Array };
type EntityPatchState = { title: string; body: string; bodySource: string; status: string; parentId: string | null; tombstone: boolean };

type MigratedEntityIdentity = {
	tenantId: string;
	legacyAlias: string;
	kind: EntityKind;
	stableId: string;
	canonicalReference: string;
};

export const entityStableIdentitiesMigration: Migration = {
	id: "0024-entity-stable-identities",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite entity Stable identity migration requires the SQLite dialect.");
		}

		const rows = await conn.all<EntityIdentityRow>(sql`SELECT tenant_id, id, kind, title, body, body_source, status, tombstone FROM entities`);
		const identities = rows.map(toMigratedIdentity);
		assertUniqueIdentities(identities);
		await rewriteEntityPatches(conn, rows, identities);

		await conn.run(sql`PRAGMA defer_foreign_keys = ON`);
		await conn.run(sql`ALTER TABLE entities ADD COLUMN reference TEXT`);
		await conn.run(sql`ALTER TABLE contexts ADD COLUMN id TEXT`);
		await conn.run(sql`ALTER TABLE contexts ADD COLUMN reference TEXT`);
		await conn.run(sql`CREATE TABLE entity_aliases (
			tenant_id TEXT NOT NULL,
			alias TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			PRIMARY KEY (tenant_id, alias),
			UNIQUE (tenant_id, entity_id)
		)`);

		for (const identity of identities) {
			await conn.run(sql`UPDATE relations SET from_id = ${identity.stableId}
				WHERE tenant_id = ${identity.tenantId} AND from_id = ${identity.legacyAlias}`);
			await conn.run(sql`UPDATE relations SET to_id = ${identity.stableId}
				WHERE tenant_id = ${identity.tenantId} AND to_id = ${identity.legacyAlias}`);
			await conn.run(sql`UPDATE contexts SET scope_entity_id = ${identity.stableId}
				WHERE tenant_id = ${identity.tenantId} AND scope_entity_id = ${identity.legacyAlias}`);
			await conn.run(sql`UPDATE history_entries SET entity_id = ${identity.stableId}
				WHERE tenant_id = ${identity.tenantId} AND entity_id = ${identity.legacyAlias}`);
			await conn.run(sql`UPDATE history_entries SET parent_id = ${identity.stableId}
				WHERE tenant_id = ${identity.tenantId} AND parent_id = ${identity.legacyAlias}`);
			await conn.run(sql`UPDATE project_migrations SET project_id = ${identity.stableId}
				WHERE tenant_id = ${identity.tenantId} AND project_id = ${identity.legacyAlias}`);
			await conn.run(sql`UPDATE revision_patch_entries SET project_id = ${identity.stableId}
				WHERE tenant_id = ${identity.tenantId} AND project_id = ${identity.legacyAlias}`);
			await conn.run(sql`UPDATE revision_patch_entries SET record_key = ${encodeEntityRecordKey(identity.stableId)}
				WHERE tenant_id = ${identity.tenantId} AND record_kind = 'entity'
					AND record_key = ${encodeEntityRecordKey(identity.legacyAlias)}`);
			await conn.run(sql`UPDATE entities SET project_id = ${identity.stableId}
				WHERE tenant_id = ${identity.tenantId} AND project_id = ${identity.legacyAlias}`);
			await conn.run(sql`UPDATE entities
				SET id = ${identity.stableId}, reference = ${identity.canonicalReference}
				WHERE tenant_id = ${identity.tenantId} AND id = ${identity.legacyAlias}`);
			await conn.run(sql`INSERT INTO entity_aliases (tenant_id, alias, entity_id)
				VALUES (${identity.tenantId}, ${identity.legacyAlias}, ${identity.stableId})`);
		}

		const contexts = await conn.all<{ tenant_id: string; key: string }>(sql`SELECT tenant_id, key FROM contexts`);
		for (const context of contexts) {
			const identity = deriveMigratedContextIdentity(context.key);
			await conn.run(sql`UPDATE revision_patch_entries SET record_key = ${encodeContextRecordKey(identity.stableId)}
				WHERE tenant_id = ${context.tenant_id} AND record_kind = 'context'
					AND record_key = ${encodeContextRecordKey(context.key)}`);
			await conn.run(sql`UPDATE contexts SET id = ${identity.stableId}, reference = ${identity.reference}
				WHERE tenant_id = ${context.tenant_id} AND key = ${context.key}`);
		}

		await conn.run(sql`CREATE UNIQUE INDEX entities_tenant_reference_idx ON entities (tenant_id, reference)`);
		await conn.run(sql`CREATE UNIQUE INDEX contexts_tenant_id_idx ON contexts (tenant_id, id)`);
		await conn.run(sql`CREATE UNIQUE INDEX contexts_tenant_reference_idx ON contexts (tenant_id, reference)`);
	}
};

async function rewriteEntityPatches(conn: Parameters<Migration["up"]>[0], rows: EntityIdentityRow[], identities: MigratedEntityIdentity[]): Promise<void> {
	for (const row of rows) {
		const parent = await conn.all<{ parent_id: string | null }>(sql`SELECT from_id AS parent_id FROM relations
			WHERE tenant_id = ${row.tenant_id} AND to_id = ${row.id} AND type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')
			ORDER BY created_at, from_id LIMIT 1`);
		const patches = await conn.all<EntityPatchRow>(sql`SELECT id, patch_format, reverse_patch, source_hash, target_hash FROM revision_patch_entries
			WHERE tenant_id = ${row.tenant_id} AND record_kind = 'entity' AND record_key = ${encodeEntityRecordKey(row.id)} ORDER BY revision DESC`);
		let successor: EntityPatchState = { title: row.title, body: row.body, bodySource: row.body_source, status: row.status, parentId: parent[0]?.parent_id ?? null, tombstone: Boolean(row.tombstone) };
		for (const patch of patches) {
			const predecessor = applyReverseFieldPatch(successor, decodeEntityTransition(patch), ENTITY_REVERSE_PATCH_REGISTRY);
			const transition = createReverseFieldPatch(mapEntityParent(successor, row.tenant_id, identities), mapEntityParent(predecessor, row.tenant_id, identities), ENTITY_REVERSE_PATCH_REGISTRY);
			await conn.run(sql`UPDATE revision_patch_entries SET patch_format = ${transition.patchFormat}, reverse_patch = ${transition.reversePatch}, source_hash = ${Buffer.from(transition.sourceHash, "hex")}, target_hash = ${Buffer.from(transition.targetHash, "hex")} WHERE id = ${patch.id}`);
			successor = predecessor;
		}
	}
}

function decodeEntityTransition(row: EntityPatchRow): ReverseFieldPatchTransition {
	return { patchFormat: row.patch_format, reversePatch: row.reverse_patch, sourceHash: Buffer.from(row.source_hash).toString("hex"), targetHash: Buffer.from(row.target_hash).toString("hex") };
}

function mapEntityParent(state: EntityPatchState, tenantId: string, identities: MigratedEntityIdentity[]): EntityPatchState {
	if (state.parentId === null) return state;
	const parent = identities.find((identity) => identity.tenantId === tenantId && identity.legacyAlias === state.parentId);
	if (!parent) throw new Error(`Cannot map structured parent reference ${state.parentId}.`);
	return { ...state, parentId: parent.stableId };
}

function toMigratedIdentity(row: EntityIdentityRow): MigratedEntityIdentity {
	if (!isEntityKind(row.kind)) {
		throw new Error(`Cannot migrate entity ${row.id} with unknown kind ${row.kind}.`);
	}
	const identity = deriveMigratedEntityIdentity(row.kind, row.id);
	return {
		tenantId: row.tenant_id,
		legacyAlias: row.id,
		kind: row.kind,
		stableId: identity.stableId,
		canonicalReference: identity.reference
	};
}

function assertUniqueIdentities(identities: MigratedEntityIdentity[]): void {
	const aliases = new Set<string>();
	const stableIds = new Set<string>();
	const canonicalReferences = new Set<string>();
	for (const identity of identities) {
		const tenantAlias = `${identity.tenantId}\0${identity.legacyAlias}`;
		const tenantStableId = `${identity.tenantId}\0${identity.stableId}`;
		const tenantReference = `${identity.tenantId}\0${identity.canonicalReference}`;
		if (aliases.has(tenantAlias)) throw new Error(`Ambiguous Legacy alias ${identity.legacyAlias}.`);
		if (stableIds.has(tenantStableId)) throw new Error(`Duplicate Stable identity ${identity.stableId}.`);
		if (canonicalReferences.has(tenantReference)) throw new Error(`Duplicate Canonical reference ${identity.canonicalReference}.`);
		aliases.add(tenantAlias);
		stableIds.add(tenantStableId);
		canonicalReferences.add(tenantReference);
	}
}