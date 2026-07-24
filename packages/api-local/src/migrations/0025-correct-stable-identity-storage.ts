import {
	applyReverseFieldPatch,
	computeCanonicalStateHash,
	createReverseFieldPatch,
	decodeCanonicalReference,
	deriveEntityKindFromId,
	deriveMigratedEntityIdentity,
	encodeContextRecordKey,
	encodeEntityRecordKey,
	ENTITY_REVERSE_PATCH_REGISTRY,
	type EntityKind,
	type Migration,
	type ReverseFieldPatchTransition
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

type EntityIdentityRow = {
	tenant_id: string;
	id: string;
	stable_id: string;
	legacy_alias: string;
	kind: EntityKind;
	title: string;
	body: string;
	body_source: string;
	status: string;
	tombstone: number;
};

type EntityPatchRow = { id: string; patch_format: number; reverse_patch: Uint8Array; source_hash: Uint8Array; target_hash: Uint8Array };
type EntityPatchState = { title: string; body: string; bodySource: string; status: string; parentId: string | null; tombstone: boolean };
type HistorySnapshotRow = { id: string; tenant_id: string; entity_id: string; title: string; body: string; body_source: string; status: string; parent_id: string | null };

export const correctStableIdentityStorageMigration: Migration = {
	id: "0025-correct-stable-identity-storage",
	async up(conn) {
		if (conn.dialect !== "sqlite") throw new Error("Corrected Stable identity storage migration requires the SQLite dialect.");

		const columns = await conn.all<{ name: string }>(sql`PRAGMA table_info(entities)`);
		if (columns.some(({ name }) => name === "reference")) return;

		const identities = await conn.all<EntityIdentityRow>(sql`SELECT entity.tenant_id,entity.id,entity.stable_id,
			alias.alias AS legacy_alias,entity.kind,entity.title,entity.body,entity.body_source,entity.status,entity.tombstone
			FROM entities AS entity
			JOIN entity_aliases AS alias
				ON alias.tenant_id=entity.tenant_id AND alias.entity_stable_id=entity.stable_id`);
		const snapshots = await conn.all<HistorySnapshotRow>(sql`SELECT id,tenant_id,entity_id,title,body,body_source,status,parent_id FROM history_entries`);
		await rewriteEntityPatches(conn, identities, snapshots);
		await conn.run(sql`PRAGMA defer_foreign_keys = ON`);

		for (const identity of identities) {
			await conn.run(sql`UPDATE relations SET from_id=${identity.stable_id} WHERE tenant_id=${identity.tenant_id} AND from_id=${identity.id}`);
			await conn.run(sql`UPDATE relations SET to_id=${identity.stable_id} WHERE tenant_id=${identity.tenant_id} AND to_id=${identity.id}`);
			await conn.run(sql`UPDATE contexts SET scope_entity_id=${identity.stable_id} WHERE tenant_id=${identity.tenant_id} AND scope_entity_id=${identity.id}`);
			await conn.run(sql`UPDATE history_entries SET entity_id=${identity.stable_id} WHERE tenant_id=${identity.tenant_id} AND entity_id IN (${identity.id},${identity.legacy_alias})`);
			await conn.run(sql`UPDATE history_entries SET parent_id=${identity.stable_id} WHERE tenant_id=${identity.tenant_id} AND parent_id IN (${identity.id},${identity.legacy_alias})`);
			await conn.run(sql`UPDATE project_migrations SET project_id=${identity.stable_id} WHERE tenant_id=${identity.tenant_id} AND project_id=${identity.id}`);
			await conn.run(sql`UPDATE revision_patch_entries SET project_id=${identity.stable_id} WHERE tenant_id=${identity.tenant_id} AND project_id=${identity.id}`);
			await conn.run(sql`UPDATE revision_patch_entries SET record_key=${encodeEntityRecordKey(identity.stable_id)}
				WHERE tenant_id=${identity.tenant_id} AND record_kind='entity'
					AND record_key IN (${encodeEntityRecordKey(identity.id)},${encodeEntityRecordKey(identity.legacy_alias)})`);
			await conn.run(sql`UPDATE entities SET project_id=${identity.stable_id} WHERE tenant_id=${identity.tenant_id} AND project_id=${identity.id}`);
		}
		await normalizeHistoricalLocators(conn, "history_entries", "entity_id");
		await normalizeHistoricalLocators(conn, "history_entries", "parent_id");
		await normalizeHistoricalLocators(conn, "project_migrations", "project_id");
		await normalizeHistoricalLocators(conn, "revision_patch_entries", "project_id");
		await normalizeHistoricalLocators(conn, "entities", "project_id");
		await normalizeHistoricalLocators(conn, "contexts", "scope_entity_id");

		await conn.run(sql`ALTER TABLE entities ADD COLUMN reference TEXT`);
		await conn.run(sql`UPDATE entities SET reference=id, id=stable_id`);
		await conn.run(sql`DROP INDEX entities_tenant_stable_id_idx`);
		await conn.run(sql`ALTER TABLE entities DROP COLUMN stable_id`);
		await conn.run(sql`CREATE UNIQUE INDEX entities_tenant_reference_idx ON entities (tenant_id,reference)`);

		await conn.run(sql`ALTER TABLE entity_aliases RENAME COLUMN entity_stable_id TO entity_id`);

		const contexts = await conn.all<{ tenant_id: string; key: string; id: string; stable_id: string }>(sql`SELECT tenant_id,key,id,stable_id FROM contexts`);
		for (const context of contexts) {
			await conn.run(sql`UPDATE revision_patch_entries SET record_key=${encodeContextRecordKey(context.stable_id)}
				WHERE tenant_id=${context.tenant_id} AND record_kind='context'
					AND record_key IN (${encodeContextRecordKey(context.id)},${encodeContextRecordKey(context.key)})`);
		}
		await conn.run(sql`ALTER TABLE contexts ADD COLUMN reference TEXT`);
		await conn.run(sql`UPDATE contexts SET reference=id, id=stable_id`);
		await conn.run(sql`DROP INDEX contexts_tenant_stable_id_idx`);
		await conn.run(sql`ALTER TABLE contexts DROP COLUMN stable_id`);
		await conn.run(sql`CREATE UNIQUE INDEX contexts_tenant_reference_idx ON contexts (tenant_id,reference)`);
	}
};

async function normalizeHistoricalLocators(
	conn: Parameters<Migration["up"]>[0],
	table: "contexts" | "entities" | "history_entries" | "project_migrations" | "revision_patch_entries",
	column: "entity_id" | "parent_id" | "project_id" | "scope_entity_id"
): Promise<void> {
	const tableIdentifier = sql.raw(table);
	const columnIdentifier = sql.raw(column);
	const locators = await conn.all<{ tenant_id: string; locator: string | null }>(sql`SELECT DISTINCT tenant_id,${columnIdentifier} AS locator FROM ${tableIdentifier} WHERE ${columnIdentifier} IS NOT NULL`);
	for (const { tenant_id, locator } of locators) {
		if (locator === null || isUuid(locator)) continue;
		const aliases = await conn.all<{ entity_stable_id: string }>(sql`SELECT entity_stable_id FROM entity_aliases WHERE tenant_id=${tenant_id} AND alias=${locator}`);
		const stableId = aliases[0]?.entity_stable_id ?? resolveHistoricalStableId(locator);
		await conn.run(sql`UPDATE ${tableIdentifier} SET ${columnIdentifier}=${stableId} WHERE tenant_id=${tenant_id} AND ${columnIdentifier}=${locator}`);
	}
}

function resolveHistoricalStableId(locator: string): string {
	try {
		return decodeCanonicalReference(locator).stableId;
	} catch {
		return deriveMigratedEntityIdentity(deriveEntityKindFromId(locator), locator).stableId;
	}
}

async function rewriteEntityPatches(
	conn: Parameters<Migration["up"]>[0],
	identities: EntityIdentityRow[],
	snapshots: HistorySnapshotRow[]
): Promise<void> {
	const snapshotsByPatch = new Map(snapshots.map((snapshot) => [
		`${snapshot.tenant_id}\0${snapshot.entity_id}\0${snapshot.id}`,
		snapshot
	]));
	const identitiesByLocator = new Map<string, EntityIdentityRow>();
	for (const identity of identities) {
		for (const locator of [identity.id, identity.stable_id, identity.legacy_alias]) {
			identitiesByLocator.set(`${identity.tenant_id}\0${locator}`, identity);
		}
	}
	for (const identity of identities) {
		const parent = await conn.all<{ parent_id: string | null }>(sql`SELECT from_id AS parent_id FROM relations WHERE tenant_id=${identity.tenant_id} AND to_id=${identity.id} AND type IN ('contains','owns','records','tracks','creates','decomposes') ORDER BY created_at,from_id LIMIT 1`);
		const patches = await conn.all<EntityPatchRow>(sql`SELECT id,patch_format,reverse_patch,source_hash,target_hash FROM revision_patch_entries WHERE tenant_id=${identity.tenant_id} AND record_kind='entity' AND record_key IN (${encodeEntityRecordKey(identity.stable_id)},${encodeEntityRecordKey(identity.id)},${encodeEntityRecordKey(identity.legacy_alias)}) ORDER BY revision DESC`);
		let successor: EntityPatchState = { title: identity.title, body: identity.body, bodySource: identity.body_source, status: identity.status, parentId: parent[0]?.parent_id ?? null, tombstone: Boolean(identity.tombstone) };
		for (const patch of patches) {
			const transition = decodeTransition(patch);
			const snapshot = [identity.id, identity.stable_id, identity.legacy_alias]
				.map((locator) => snapshotsByPatch.get(`${identity.tenant_id}\0${locator}\0${patch.id}`))
				.find((candidate) => candidate !== undefined);
			successor = resolveStoredState(successor, snapshot, identity, identitiesByLocator, transition.sourceHash, patch.id);
			const predecessor = applyReverseFieldPatch(successor, transition, ENTITY_REVERSE_PATCH_REGISTRY);
			const rewritten = createReverseFieldPatch(mapParent(successor, identity.tenant_id, identitiesByLocator), mapParent(predecessor, identity.tenant_id, identitiesByLocator), ENTITY_REVERSE_PATCH_REGISTRY);
			await conn.run(sql`UPDATE revision_patch_entries SET patch_format=${rewritten.patchFormat},reverse_patch=${rewritten.reversePatch},source_hash=${Buffer.from(rewritten.sourceHash,"hex")},target_hash=${Buffer.from(rewritten.targetHash,"hex")} WHERE id=${patch.id}`);
			successor = predecessor;
		}
	}
}

function resolveStoredState(
	state: EntityPatchState,
	snapshot: HistorySnapshotRow | undefined,
	identity: EntityIdentityRow,
	identitiesByLocator: ReadonlyMap<string, EntityIdentityRow>,
	expectedSourceHash: string,
	patchId: string
): EntityPatchState {
	const matches: EntityPatchState[] = [];
	const bases = snapshot
		? [state, { title: snapshot.title, body: snapshot.body, bodySource: snapshot.body_source, status: snapshot.status, parentId: snapshot.parent_id, tombstone: false }]
		: [state];
	for (const base of bases) {
		const parent = base.parentId === null ? null : identitiesByLocator.get(`${identity.tenant_id}\0${base.parentId}`);
		if (base.parentId !== null && !parent) throw new Error(`Cannot map structured parent reference ${base.parentId} while rewriting entity patch ${patchId}.`);
		const parentIds = parent ? [parent.legacy_alias, parent.id, parent.stable_id] : [null];
		for (const parentId of new Set(parentIds)) {
			const candidate = { ...base, parentId };
			if (computeCanonicalStateHash(candidate, ENTITY_REVERSE_PATCH_REGISTRY) === expectedSourceHash) matches.push(candidate);
		}
	}
	const uniqueMatches = [...new Map(matches.map((match) => [JSON.stringify(match), match])).values()];
	if (uniqueMatches.length !== 1) throw new Error(`Cannot uniquely reconstruct source state for entity patch ${patchId}: ${uniqueMatches.length} matches.`);
	return uniqueMatches[0]!;
}

function decodeTransition(row: EntityPatchRow): ReverseFieldPatchTransition {
	return { patchFormat: row.patch_format, reversePatch: row.reverse_patch, sourceHash: Buffer.from(row.source_hash).toString("hex"), targetHash: Buffer.from(row.target_hash).toString("hex") };
}

function mapParent(state: EntityPatchState, tenantId: string, identitiesByLocator: ReadonlyMap<string, EntityIdentityRow>): EntityPatchState {
	if (state.parentId === null) return state;
	const parent = identitiesByLocator.get(`${tenantId}\0${state.parentId}`);
	if (!parent) throw new Error(`Cannot map structured parent reference ${state.parentId}.`);
	return { ...state, parentId: parent.stable_id };
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

