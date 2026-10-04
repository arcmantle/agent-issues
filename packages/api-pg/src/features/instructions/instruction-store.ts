import { createHash } from "node:crypto";
import { assembleInstruction, compareInstructionSource, describeInstructionReleaseChanges, inspectInstructionDependencies, inspectInstructionReset, inspectInstructionResetAll, prepareInstructionChanges, prepareInstructionFragmentCreate, prepareInstructionFragmentRemove, prepareInstructionReset, prepareInstructionResetAll, prepareInstructionSave, previewInstruction, readInstructionSource } from "@agent-issues/core";
import type { CommitInstructionChangesInput, CreateInstructionFragmentInput, RemoveInstructionFragmentInput, InstructionSourceResult, InstructionKind, InstructionSnapshotItem, InstructionStore, RetrieveInstructionInput, SaveInstructionSourceInput } from "@agent-issues/core";
import type { TenantExecutor } from "../../db/connection.js";

export class PgInstructionStore implements InstructionStore {
	constructor(executor: TenantExecutor, userId: string) {
		this.executor = executor;
		this.userId = userId;
	}

	protected readonly executor: TenantExecutor;
	protected readonly userId: string;

	async retrieveInstruction(input: RetrieveInstructionInput) {
		return assembleInstruction(input, await this.readItems(input.version));
	}

	async previewInstruction(input: Parameters<InstructionStore["previewInstruction"]>[0]) {
		return previewInstruction(input, await this.readItems(input.version));
	}

	async inspectInstructionDependencies(input: RetrieveInstructionInput) {
		return inspectInstructionDependencies(input, await this.readItems(input.version));
	}

	async listInstructionSources(input: { version: string }) {
		return { version: input.version, items: await this.readManagedItems(input.version) };
	}

	async readInstructionSource(input: RetrieveInstructionInput) {
		return readInstructionSource(input, await this.readManagedItems(input.version));
	}

	async compareInstructionSource(input: RetrieveInstructionInput) {
		const current = readInstructionSource(input, await this.readManagedItems(input.version));
		const result = await this.executor.query<{ version: string; kind: InstructionKind; body: string; revision: number; content_hash: string }>(
			"SELECT version, kind, body, revision, content_hash FROM instruction_defaults WHERE item_key = $1", [input.key]
		);
		return compareInstructionSource(input, current, result.rows.map((row) => ({
			version: row.version, key: input.key, kind: row.kind, body: row.body,
			source: { type: "default", revision: row.revision, contentHash: row.content_hash }
		})));
	}

	async saveInstructionSource(input: SaveInstructionSourceInput) {
		await this.lockOwner();
		const contentHash = createHash("sha256").update(typeof input.body === "string" ? input.body : "").digest("hex");
		const saved = prepareInstructionSave(input, await this.readItems(input.version), contentHash);
		await this.writeSource(saved);
		return saved;
	}

	async commitInstructionChanges(input: CommitInstructionChangesInput) {
		await this.lockOwner();
		const items = await this.readItems(input.version);
		const overrides = await this.executor.query<{ key: string; body: string }>("SELECT item_key AS key, body FROM instruction_overrides WHERE tenant_id = $1 AND user_id = $2", [this.executor.tenantId, this.userId]);
		const result = prepareInstructionChanges(input, items, (body) => createHash("sha256").update(body).digest("hex"), overrides.rows);
		for (const change of result.changes) {
			if (change.operation === "remove") await this.appendFragment(change.source, true);
			else await this.writeSource(change.source);
		}
		return result;
	}

	async listInstructionHistory(input: RetrieveInstructionInput) {
		const current = readInstructionSource(input, await this.readItems(input.version));
		const result = await this.executor.query<{ body: string; revision: number; content_hash: string; default_version: string | null; is_default: boolean }>(current.source.type === "personal"
			? "SELECT body, revision, content_hash, NULL AS default_version, FALSE AS is_default FROM instruction_personal_fragments WHERE tenant_id = $1 AND user_id = $2 AND item_key = $3 AND removed = FALSE ORDER BY revision DESC"
			: "SELECT body, revision, content_hash, default_version, is_default FROM instruction_history WHERE tenant_id = $1 AND user_id = $2 AND item_key = $3 ORDER BY revision DESC",
		[this.executor.tenantId, this.userId, input.key]);
		return { ...input, revisions: result.rows.map((row): InstructionSourceResult => ({
			version: input.version, key: input.key, kind: current.kind, body: row.body,
			source: row.is_default ? { type: "default", revision: row.revision, contentHash: row.content_hash } : row.default_version === null
				? { type: "personal", revision: row.revision, contentHash: row.content_hash }
				: { type: "override", revision: row.revision, contentHash: row.content_hash, defaultVersion: row.default_version }
		})) };
	}

	async readInstructionRevision(input: Parameters<InstructionStore["readInstructionRevision"]>[0]): Promise<InstructionSourceResult> {
		const history = await this.listInstructionHistory({ version: input.version, key: input.key });
		const revision = history.revisions.find((item) => item.source.revision === input.revision);
		if (!revision) throw new Error(`Instruction revision not found: ${input.key}@${input.revision}`);
		return revision;
	}

	async restoreInstructionRevision(input: Parameters<InstructionStore["restoreInstructionRevision"]>[0]) {
		await this.lockOwner();
		const revision = await this.readInstructionRevision(input);
		const saved = prepareInstructionSave({ version: input.version, key: input.key, body: revision.body, expectedRevision: input.expectedRevision }, await this.readItems(input.version), createHash("sha256").update(revision.body).digest("hex"));
		await this.writeSource(saved);
		return saved;
	}

	async resetInstructionSource(input: Parameters<InstructionStore["resetInstructionSource"]>[0]) {
		await this.lockOwner();
		const reset = prepareInstructionReset(input, await this.readItems(input.version), await this.readDefault(input));
		await this.writeResetSource(reset);
		return reset;
	}

	async inspectInstructionReset(input: RetrieveInstructionInput) {
		return inspectInstructionReset(input, await this.readItems(input.version), await this.readDefault(input));
	}

	async inspectInstructionResetAll(input: { version: string }) {
		await this.lockOwner();
		const { items, defaults } = await this.readResetAllItems(input.version);
		return inspectInstructionResetAll(input, items, defaults, { type: "cloud", tenantId: this.executor.tenantId, userId: this.userId });
	}

	async resetInstructionAll(input: Parameters<InstructionStore["resetInstructionAll"]>[0]) {
		await this.lockOwner();
		const { items, defaults } = await this.readResetAllItems(input.version);
		const inspection = prepareInstructionResetAll(input, items, defaults, { type: "cloud", tenantId: this.executor.tenantId, userId: this.userId });
		for (const { currentSource, proposedSource } of inspection.overrides) {
			if (currentSource.source.type !== "override") throw new Error("Expected instruction override.");
			const defaultItem = proposedSource ?? await this.readDefault({ version: currentSource.source.defaultVersion, key: currentSource.key });
			await this.writeResetSource({ ...defaultItem, version: input.version, source: { ...defaultItem.source, revision: currentSource.source.revision + 1 } });
		}
		for (const fragment of inspection.personalFragments) await this.appendFragment({ ...fragment, source: { ...fragment.source, revision: fragment.source.revision + 1 } }, true);
		return inspection;
	}

	protected async writeResetSource(reset: InstructionSourceResult): Promise<void> {
		await this.executor.query(`INSERT INTO instruction_history (tenant_id, user_id, item_key, kind, body, revision, content_hash, default_version, is_default)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)`,
		[this.executor.tenantId, this.userId, reset.key, reset.kind, reset.body, reset.source.revision, reset.source.contentHash, reset.version]);
		await this.executor.query("DELETE FROM instruction_overrides WHERE tenant_id = $1 AND user_id = $2 AND item_key = $3", [this.executor.tenantId, this.userId, reset.key]);
	}

	protected async readResetAllItems(version: string) {
		if (!(await this.executor.query("SELECT 1 FROM instruction_bundles WHERE version = $1", [version])).rows.length) throw new Error(`Instruction defaults unavailable for release: ${version}`);
		const overrides = await this.executor.query<{ item_key: string; kind: InstructionKind; body: string; revision: number; content_hash: string; default_version: string }>(
			"SELECT item_key, kind, body, revision, content_hash, default_version FROM instruction_overrides WHERE tenant_id = $1 AND user_id = $2", [this.executor.tenantId, this.userId]);
		const changed = overrides.rows.map((row): InstructionSnapshotItem => ({ key: row.item_key, kind: row.kind, body: row.body, source: { type: "override", revision: row.revision, contentHash: row.content_hash, defaultVersion: row.default_version } }));
		const personal = await this.executor.query<{ item_key: string; body: string; revision: number; content_hash: string }>(`
			SELECT fragment.item_key, fragment.body, fragment.revision, fragment.content_hash FROM instruction_personal_fragments AS fragment
			WHERE fragment.tenant_id = $1 AND fragment.user_id = $2 AND fragment.removed = FALSE
				AND fragment.revision = (SELECT MAX(history.revision) FROM instruction_personal_fragments AS history
					WHERE history.tenant_id = $1 AND history.user_id = $2 AND history.item_key = fragment.item_key)
		`, [this.executor.tenantId, this.userId]);
		for (const row of personal.rows) changed.push({ key: row.item_key, kind: "fragment", body: row.body, source: { type: "personal", revision: row.revision, contentHash: row.content_hash } });
		const result = await this.executor.query<{ item_key: string; kind: InstructionKind; body: string; revision: number; content_hash: string }>("SELECT item_key, kind, body, revision, content_hash FROM instruction_defaults WHERE version = $1", [version]);
		const defaults = result.rows.map((row): InstructionSnapshotItem => ({ key: row.item_key, kind: row.kind, body: row.body, source: { type: "default", revision: row.revision, contentHash: row.content_hash } }));
		return { items: [...defaults.filter((item) => !changed.some((current) => current.key === item.key)), ...changed], defaults };
	}

	protected async readDefault(input: RetrieveInstructionInput): Promise<InstructionSnapshotItem> {
		const result = await this.executor.query<{ kind: InstructionKind; body: string; content_hash: string }>("SELECT kind, body, content_hash FROM instruction_defaults WHERE version = $1 AND item_key = $2", [input.version, input.key]);
		const row = result.rows[0];
		if (!row) throw new Error(`Instruction default not found: ${input.key}`);
		return { key: input.key, kind: row.kind, body: row.body, source: { type: "default", revision: 1, contentHash: row.content_hash } };
	}

	async createInstructionFragment(input: CreateInstructionFragmentInput) {
		await this.lockOwner();
		const items = await this.readItems(input.version);
		const latest = await this.executor.query<{ revision: number | null }>("SELECT MAX(revision) AS revision FROM instruction_personal_fragments WHERE tenant_id = $1 AND user_id = $2 AND item_key = $3", [this.executor.tenantId, this.userId, input.key]);
		const contentHash = createHash("sha256").update(typeof input.body === "string" ? input.body : "").digest("hex");
		const created = prepareInstructionFragmentCreate(input, items, (latest.rows[0]?.revision ?? 0) + 1, contentHash);
		await this.appendFragment(created, false);
		return created;
	}

	async removeInstructionFragment(input: RemoveInstructionFragmentInput) {
		await this.lockOwner();
		const items = await this.readItems(input.version);
		const overrides = await this.executor.query<{ key: string; body: string }>("SELECT item_key AS key, body FROM instruction_overrides WHERE tenant_id = $1 AND user_id = $2", [this.executor.tenantId, this.userId]);
		const removed = prepareInstructionFragmentRemove(input, items, [...items, ...overrides.rows]);
		await this.appendFragment(removed, true);
		return removed;
	}

	protected async lockOwner(): Promise<void> {
		await this.executor.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [this.executor.tenantId, `instructions:${this.userId}`]);
	}

	protected async writeSource(saved: InstructionSourceResult): Promise<void> {
		if (saved.source.type === "personal") {
			await this.appendFragment(saved, false);
			return;
		}
		if (saved.source.type !== "override") throw new Error("Expected instruction override.");
		await this.executor.query(`INSERT INTO instruction_history (tenant_id, user_id, item_key, kind, body, revision, content_hash, default_version)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[this.executor.tenantId, this.userId, saved.key, saved.kind, saved.body, saved.source.revision, saved.source.contentHash, saved.source.defaultVersion]);
		await this.executor.query(`INSERT INTO instruction_overrides (tenant_id, user_id, item_key, kind, body, revision, content_hash, default_version)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (tenant_id, user_id, item_key) DO UPDATE SET body = excluded.body, revision = excluded.revision, content_hash = excluded.content_hash`,
		[this.executor.tenantId, this.userId, saved.key, saved.kind, saved.body, saved.source.revision, saved.source.contentHash, saved.source.defaultVersion]);
	}

	protected async appendFragment(item: InstructionSourceResult, removed: boolean): Promise<void> {
		await this.executor.query(`INSERT INTO instruction_personal_fragments (tenant_id, user_id, item_key, revision, body, content_hash, removed)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, [this.executor.tenantId, this.userId, item.key, item.source.revision, item.body, item.source.contentHash, removed]);
	}

	protected async readManagedItems(version: string) {
		const items = await this.readItems(version);
		const result = await this.executor.query<{ version: string; item_key: string; kind: InstructionKind; body: string; revision: number; content_hash: string }>(`
			SELECT version, item_key, kind, body, revision, content_hash FROM instruction_defaults
			WHERE version = $1 OR version IN (
				SELECT default_version FROM instruction_overrides WHERE tenant_id = $2 AND user_id = $3
			)
		`, [version, this.executor.tenantId, this.userId]);
		return describeInstructionReleaseChanges(version, items, result.rows.map((item) => ({
			version: item.version, key: item.item_key, kind: item.kind, body: item.body,
			source: { type: "default", revision: item.revision, contentHash: item.content_hash }
		})));
	}

	protected async readItems(version: string): Promise<InstructionSnapshotItem[]> {
		const result = await this.executor.query<{
			item_key: string | null; kind: InstructionKind | null; body: string; revision: number; content_hash: string; default_version: string | null; personal: boolean;
		}>(`
			SELECT defaults.item_key, defaults.kind,
				COALESCE(overrides.body, defaults.body) AS body,
				COALESCE(overrides.revision, (SELECT MAX(history.revision) FROM instruction_history AS history
					WHERE history.tenant_id = $2 AND history.user_id = $3 AND history.item_key = defaults.item_key), defaults.revision) AS revision,
				COALESCE(overrides.content_hash, defaults.content_hash) AS content_hash,
				overrides.default_version, FALSE AS personal
			FROM instruction_bundles AS bundle
			LEFT JOIN instruction_defaults AS defaults ON defaults.version = bundle.version
			LEFT JOIN instruction_overrides AS overrides ON overrides.item_key = defaults.item_key
				AND overrides.tenant_id = $2 AND overrides.user_id = $3
			WHERE bundle.version = $1
			UNION ALL
			SELECT fragment.item_key, 'fragment', fragment.body, fragment.revision, fragment.content_hash, NULL, TRUE
			FROM instruction_personal_fragments AS fragment
			WHERE fragment.tenant_id = $2 AND fragment.user_id = $3 AND fragment.removed = FALSE
				AND fragment.revision = (SELECT MAX(history.revision) FROM instruction_personal_fragments AS history
					WHERE history.tenant_id = $2 AND history.user_id = $3 AND history.item_key = fragment.item_key)
				AND EXISTS (SELECT 1 FROM instruction_bundles WHERE version = $1)
			ORDER BY item_key
		`, [version, this.executor.tenantId, this.userId]);
		if (!result.rows.length) throw new Error(`Instruction defaults unavailable for release: ${version}`);
		const keys = new Set<string>();
		return result.rows.flatMap((item): InstructionSnapshotItem[] => {
			if (!item.item_key || !item.kind) return [];
			if (keys.has(item.item_key)) throw new Error(`Personal fragment conflicts with release default: ${item.item_key}`);
			keys.add(item.item_key);
			return [{
			key: item.item_key, kind: item.kind, body: item.body,
			source: item.personal ? { type: "personal", revision: item.revision, contentHash: item.content_hash } : item.default_version !== null
				? { type: "override" as const, revision: item.revision, contentHash: item.content_hash, defaultVersion: item.default_version }
				: { type: "default" as const, revision: item.revision, contentHash: item.content_hash }
		}];
		});
	}
}