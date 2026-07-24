import { applyReverseFieldPatch, createReverseFieldPatch, deriveMigratedEntityIdentity, encodeEntityRecordKey, ENTITY_REVERSE_PATCH_REGISTRY, isEntityKind, type EntityKind, type ReverseFieldPatchTransition } from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

type EntityRow = { tenant_id: string; id: string; kind: string; title: string; body: string; body_source: string; status: string; tombstone: boolean };
type MigratedIdentity = EntityRow & { kind: EntityKind; stableId: string; reference: string };
type EntityPatchRow = { id: string; patch_format: number; reverse_patch: Buffer; source_hash: Buffer; target_hash: Buffer };
type EntityPatchState = { title: string; body: string; bodySource: string; status: string; parentId: string | null; tombstone: boolean };

export const entityStableIdentitiesMigration: Migration = {
	id: "0017-entity-stable-identities",
	async up(conn) {
		if (conn.dialect !== "postgres") throw new Error("PostgreSQL entity Stable identity migration requires the PostgreSQL dialect.");
		const rows = await conn.all<EntityRow>(sql`SELECT tenant_id, id, kind, title, body, body_source, status, tombstone FROM entities`);
		const identities = rows.map((row): MigratedIdentity => {
			if (!isEntityKind(row.kind)) throw new Error(`Cannot migrate entity ${row.id} with unknown kind ${row.kind}.`);
			return { ...row, kind: row.kind, ...deriveMigratedEntityIdentity(row.kind, row.id) };
		});
		assertUniqueIdentities(identities);
		await rewriteEntityPatches(conn, identities);
		await conn.run(sql`ALTER TABLE entities ADD COLUMN stable_id UUID`);
		await conn.run(sql`CREATE TABLE entity_aliases (tenant_id TEXT NOT NULL, alias TEXT NOT NULL, entity_stable_id UUID NOT NULL, PRIMARY KEY (tenant_id, alias), UNIQUE (tenant_id, entity_stable_id))`);
		await conn.run(sql`ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY`);
		await conn.run(sql`CREATE POLICY tenant_isolation ON entity_aliases USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`);
		await conn.run(sql`ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_tenant_id_from_id_entities_tenant_id_id_fk`);
		await conn.run(sql`ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_tenant_id_to_id_entities_tenant_id_id_fk`);
		await conn.run(sql`ALTER TABLE contexts DROP CONSTRAINT IF EXISTS contexts_tenant_id_scope_entity_id_entities_tenant_id_id_fk`);
		for (const identity of identities) {
			await conn.run(sql`UPDATE relations SET from_id=${identity.reference} WHERE tenant_id=${identity.tenant_id} AND from_id=${identity.id}`);
			await conn.run(sql`UPDATE relations SET to_id=${identity.reference} WHERE tenant_id=${identity.tenant_id} AND to_id=${identity.id}`);
			await conn.run(sql`UPDATE contexts SET scope_entity_id=${identity.reference} WHERE tenant_id=${identity.tenant_id} AND scope_entity_id=${identity.id}`);
			await conn.run(sql`UPDATE history_entries SET entity_id=${identity.reference} WHERE tenant_id=${identity.tenant_id} AND entity_id=${identity.id}`);
			await conn.run(sql`UPDATE history_entries SET parent_id=${identity.reference} WHERE tenant_id=${identity.tenant_id} AND parent_id=${identity.id}`);
			await conn.run(sql`UPDATE revision_patch_entries SET project_id=${identity.reference} WHERE tenant_id=${identity.tenant_id} AND project_id=${identity.id}`);
			await conn.run(sql`UPDATE revision_patch_entries SET record_key=${encodeEntityRecordKey(identity.stableId)} WHERE tenant_id=${identity.tenant_id} AND record_kind='entity' AND record_key=${encodeEntityRecordKey(identity.id)}`);
			await conn.run(sql`UPDATE entities SET project_id=${identity.reference} WHERE tenant_id=${identity.tenant_id} AND project_id=${identity.id}`);
			await conn.run(sql`UPDATE entities SET stable_id=${identity.stableId}::uuid, id=${identity.reference} WHERE tenant_id=${identity.tenant_id} AND id=${identity.id}`);
			await conn.run(sql`INSERT INTO entity_aliases VALUES (${identity.tenant_id},${identity.id},${identity.stableId}::uuid)`);
		}
		await conn.run(sql`ALTER TABLE entities ALTER COLUMN stable_id SET NOT NULL`);
		await conn.run(sql`CREATE UNIQUE INDEX entities_tenant_stable_id_idx ON entities (tenant_id, stable_id)`);
		await conn.run(sql`ALTER TABLE relations ADD FOREIGN KEY (tenant_id, from_id) REFERENCES entities(tenant_id,id) ON DELETE CASCADE`);
		await conn.run(sql`ALTER TABLE relations ADD FOREIGN KEY (tenant_id, to_id) REFERENCES entities(tenant_id,id) ON DELETE CASCADE`);
		await conn.run(sql`ALTER TABLE contexts ADD FOREIGN KEY (tenant_id, scope_entity_id) REFERENCES entities(tenant_id,id) ON DELETE CASCADE`);
	}
};

async function rewriteEntityPatches(conn: Parameters<Migration["up"]>[0], identities: MigratedIdentity[]): Promise<void> {
	for (const identity of identities) {
		const parent = await conn.all<{ parent_id: string | null }>(sql`SELECT from_id AS parent_id FROM relations WHERE tenant_id=${identity.tenant_id} AND to_id=${identity.id} AND type IN ('contains','owns','records','tracks','creates','decomposes') ORDER BY created_at,from_id LIMIT 1`);
		const patches = await conn.all<EntityPatchRow>(sql`SELECT id,patch_format,reverse_patch,source_hash,target_hash FROM revision_patch_entries WHERE tenant_id=${identity.tenant_id} AND record_kind='entity' AND record_key=${encodeEntityRecordKey(identity.id)} ORDER BY revision DESC`);
		let successor: EntityPatchState = { title: identity.title, body: identity.body, bodySource: identity.body_source, status: identity.status, parentId: parent[0]?.parent_id ?? null, tombstone: identity.tombstone };
		for (const patch of patches) {
			const predecessor = applyReverseFieldPatch(successor, decodeEntityTransition(patch), ENTITY_REVERSE_PATCH_REGISTRY);
			const transition = createReverseFieldPatch(mapEntityParent(successor, identity.tenant_id, identities), mapEntityParent(predecessor, identity.tenant_id, identities), ENTITY_REVERSE_PATCH_REGISTRY);
			await conn.run(sql`UPDATE revision_patch_entries SET patch_format=${transition.patchFormat},reverse_patch=${Buffer.from(transition.reversePatch)},source_hash=${Buffer.from(transition.sourceHash,"hex")},target_hash=${Buffer.from(transition.targetHash,"hex")} WHERE id=${patch.id}`);
			successor = predecessor;
		}
	}
}

function decodeEntityTransition(row: EntityPatchRow): ReverseFieldPatchTransition {
	return { patchFormat: row.patch_format, reversePatch: row.reverse_patch, sourceHash: row.source_hash.toString("hex"), targetHash: row.target_hash.toString("hex") };
}

function mapEntityParent(state: EntityPatchState, tenantId: string, identities: MigratedIdentity[]): EntityPatchState {
	if (state.parentId === null) return state;
	const parent = identities.find((identity) => identity.tenant_id === tenantId && identity.id === state.parentId);
	if (!parent) throw new Error(`Cannot map structured parent reference ${state.parentId}.`);
	return { ...state, parentId: parent.reference };
}

function assertUniqueIdentities(identities: MigratedIdentity[]): void {
	const aliases = new Set<string>();
	const stableIds = new Set<string>();
	const references = new Set<string>();
	for (const identity of identities) {
		for (const [set, value, label] of [[aliases, identity.id, "Legacy alias"], [stableIds, identity.stableId, "Stable identity"], [references, identity.reference, "Canonical reference"]] as const) {
			const key = `${identity.tenant_id}\0${value}`;
			if (set.has(key)) throw new Error(`Duplicate ${label} ${value}.`);
			set.add(key);
		}
	}
}