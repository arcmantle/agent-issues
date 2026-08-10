import { randomUUID } from "node:crypto";
import type {
	BodySource,
	CanonicalIssueCommentChain,
	AuthIdentity,
	CanonicalChainBundle,
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	DatabaseSnapshot,
	DefineContextTermResult,
	DeleteResult,
	DeleteTenantResult,
	EntityDetails,
	EntityRecord,
	ForgetContextTermResult,
	HistoryEntryRecord,
	InitiativeBundle,
	IssueCommentPage,
	IssueCommentRecord,
	IssueCommentHistoryEntry,
	LinkResult,
	MoveResult,
	ProjectDiscovery,
	ProjectSnapshot,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult,
	QueryEntitiesInput,
	QueryEntitiesResult,
	QueryEntityRelationsInput,
	RelationRecord,
	RenameTenantResult,
	StatusUpdateResult,
	StorageDriver,
	TenantSummary,
	UnlinkResult
} from "@agent-issues/core";
import { computeIssueCommentContentHash, createReverseFieldPatch, encodeCanonicalReference, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, IssueCommentConflictError, materializeIssueCommentFromPatches, measureHistory, SYSTEM_AUTHENTICATION_SUBJECT } from "@agent-issues/core";
import type { Pool } from "pg";

import { withTenantTransaction, type TenantExecutor } from "./db/connection.js";
import { PgSynchronizeStore } from "./features/synchronize/canonical-chain-store.js";
import { PgUserDirectoryStore } from "./features/user-directory/store.js";
import { deleteTenant, listTenants, renameTenant } from "./db/tenant-admin.js";
import { PgContextStore } from "./features/context/context-store.js";
import { PgEntityStore, resolveCurrentProjectId } from "./features/entity-store/store.js";
import { PgHistoryDiagnosticsStore } from "./features/history-diagnostics.js";

/**
 * Postgres implementation of the storage-driver seam (ADR11, ADR13, ISS39).
 * Every method opens exactly one `withTenantTransaction` (ADR9's `SET LOCAL
 * app.tenant_id`), so RLS is always active for the query, then delegates to
 * the free functions in `features/entity-store`, `features/context`, and
 * `db/tenant-admin` - mirroring `SqliteStore`'s own thin-delegating-class
 * shape exactly (`api-local/src/sqlite-store.ts`).
 *
 * Tenant administration (`listTenants`/`deleteTenant`/`renameTenant`) is
 * necessarily narrower here than `SqliteStore`'s: RLS makes each `PgStore`
 * instance's own tenant the only one it can ever see or touch (ADR9), so
 * these methods only ever report on or act on `this.tenantId` - never an
 * arbitrary other tenant the way a single SQLite file's admin CLI can.
 * `renameTenant` copies every row to the new tenant id under a temporarily
 * re-pointed `app.tenant_id` and then deletes the old rows, rather than a
 * single `UPDATE ... SET tenant_id`, because RLS's `USING` (old value) and
 * `WITH CHECK` (new value) can never both pass for one statement scoped to
 * a single session tenant id.
 */
export class PgStore implements StorageDriver {
	public constructor(
		private readonly pool: Pool,
		public readonly tenantId: string,
		/**
		 * The executor-resolved project identity (ISS183, mirroring
		 * `resolveProjectIdentity` in core) this request is scoped to.
		 * Threaded from the cloud gate's `x-agent-issues-project-identity`
		 * header. Undefined keeps today's behavior: the bare (no `--scope`)
		 * default context resolves to the tenant-wide sentinel, exactly as
		 * before this issue - so single-project tenants and any caller that
		 * doesn't send the header see no change at all.
		 */
		private readonly projectIdentity?: string,
		actorIdentity?: AuthIdentity
	) {
		this.actorIdentity = actorIdentity;
	}

	/**
	 * The project this store settled on, kept for its lifetime. See
	 * `transaction` for why it is resolved once rather than per call.
	 */
	protected currentProjectId?: string;
	protected readonly actorIdentity: AuthIdentity | undefined;

	private get historyDiagnosticsStore(): PgHistoryDiagnosticsStore {
		return new PgHistoryDiagnosticsStore(this.pool, this.tenantId);
	}

	/**
	 * One `withTenantTransaction` per store method (ADR9), carrying this
	 * request's `projectIdentity` onto the executor so project-scoped reads can
	 * resolve it.
	 *
	 * The project is resolved on this store's FIRST transaction and remembered
	 * for its lifetime, which is what makes cloud behave like local rather than
	 * merely look like it: local resolves `currentProjectId` once when the
	 * database is opened, so a session that later creates a second project
	 * keeps operating as the project it opened against. Resolving lazily or
	 * per-transaction instead would make the same sequence start failing the
	 * moment a second project appeared. Only harvested after `fn` succeeds - a
	 * rolled-back transaction may have resolved to a project that no longer
	 * exists.
	 */
	protected transaction<T>(fn: (executor: TenantExecutor) => Promise<T>): Promise<T> {
		return withTenantTransaction(
			this.pool,
			this.tenantId,
			async (executor) => {
				// Awaited before `fn` runs, not merely started: the advisory lock
				// inside project registration is transaction-scoped, so it cannot
				// serialize two resolutions racing within this same transaction.
				// Letting `fn` start first is how a store ends up minting two
				// projects for one identity and making it ambiguous forever.
				const projectId = this.currentProjectId ?? (await resolveCurrentProjectId(executor, executor.projectIdentity));
				executor.currentProjectId = projectId;

				const result = await fn(executor);
				this.currentProjectId = projectId;
				return result;
			},
			this.projectIdentity
		);
	}

	/**
	 * For the methods that legitimately span every project - project discovery
	 * (the call that tells you which projects exist), whole-tenant synchronize,
	 * and tenant administration. These deliberately skip project resolution:
	 * requiring one would make discovery fail in exactly the multi-project
	 * tenants it exists for, and would let a `deleteTenant` call register a
	 * project in the tenant it is about to remove.
	 */
	protected tenantWideTransaction<T>(fn: (executor: TenantExecutor) => Promise<T>): Promise<T> {
		return withTenantTransaction(this.pool, this.tenantId, fn, this.projectIdentity);
	}

	public withAuthenticatedIdentity(identity: AuthIdentity): StorageDriver {
		return new PgStore(this.pool, this.tenantId, this.projectIdentity, identity);
	}

	protected mutation<T>(fn: (executor: TenantExecutor, actorId: string) => Promise<T>): Promise<T> {
		return this.transaction(async (executor) => {
			const identity = this.actorIdentity ?? { userId: SYSTEM_AUTHENTICATION_SUBJECT, tenantId: this.tenantId };
			const user = await new PgUserDirectoryStore(executor).upsertUser({ authenticationSubject: identity.userId, displayName: identity.displayName });
			return fn(executor, user.id);
		});
	}

	protected tenantWideMutation<T>(fn: (executor: TenantExecutor, actorId: string) => Promise<T>): Promise<T> {
		return this.tenantWideTransaction(async (executor) => {
			const identity = this.actorIdentity ?? { userId: SYSTEM_AUTHENTICATION_SUBJECT, tenantId: this.tenantId };
			const user = await new PgUserDirectoryStore(executor).upsertUser({ authenticationSubject: identity.userId, displayName: identity.displayName });
			return fn(executor, user.id);
		});
	}

	public async exportCanonicalChains() {
		return this.tenantWideTransaction((executor) => new PgSynchronizeStore(executor).exportCanonicalChains());
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle) {
		return this.tenantWideMutation((executor) => new PgSynchronizeStore(executor).importCanonicalChains(bundle));
	}

	public async upsertUser(input: Parameters<StorageDriver["upsertUser"]>[0]) {
		return this.tenantWideTransaction((executor) => new PgUserDirectoryStore(executor).upsertUser(input));
	}

	public async listUsers() {
		return this.tenantWideTransaction((executor) => new PgUserDirectoryStore(executor).listUsers());
	}

	public async getHistoryDiagnostics() {
		return measureHistory(await this.exportCanonicalChains(), await this.historyDiagnosticsStore.getMaterializationDepths());
	}

	public async createEntity(input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		author?: string;
		links?: Array<{ relationType: string; targetId: string }>;
	}): Promise<EntityRecord> {
		return this.mutation((executor, actorId) => new PgEntityStore(executor, this.projectIdentity).createEntity(input, actorId));
	}

	public async getEntityDetails(entityId: string): Promise<EntityDetails> {
		const details = await this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getEntityDetails(entityId));
		return details.entity.kind === "issue"
			? { ...details, comments: await this.listIssueComments({ issueId: details.entity.id }) }
			: details;
	}

	public async queryEntityRelations(input: QueryEntityRelationsInput): Promise<EntityDetails> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).queryEntityRelations(input));
	}

	public async listEntities(kind: string): Promise<EntityRecord[]> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).listEntities(kind));
	}

	public async queryEntities(input: QueryEntitiesInput): Promise<QueryEntitiesResult> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).queryEntities(input));
	}

	public async listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).listEntityHistory(entityId));
	}

	public async createIssueComment(input: { issueId: string; body: string; referencedIssueIds?: string[] }): Promise<IssueCommentRecord> {
		return this.mutation(async (executor, actorId) => {
			const entityStore = new PgEntityStore(executor, this.projectIdentity);
			const issue = (await entityStore.getEntityDetails(input.issueId)).entity;
			if (issue.kind !== "issue") throw new Error(`Comments can only attach to issues: ${input.issueId}`);
			if (input.body.trim().length === 0) throw new Error("Issue comment body must not be empty.");
			const referencedIssueIds = await validateReferencedIssueIds(entityStore, input.referencedIssueIds ?? []);
			const synchronizeStore = new PgSynchronizeStore(executor);
			const current = await synchronizeStore.exportCanonicalChains();
			const id = randomUUID();
			const reference = encodeCanonicalReference("issueComment", id);
			const createdAt = new Date().toISOString();
			const state = { body: input.body, referencedIssueIds, tombstone: false };
			const chain = {
				head: { id, reference, issueId: issue.id, createdBy: actorId, updatedBy: actorId, ...state, revision: 1, contentHash: computeIssueCommentContentHash(state.body, state.referencedIssueIds, state.tombstone), createdAt, updatedAt: createdAt },
				deltas: [{ id: randomUUID(), revision: 1, author: actorId, createdAt, ...createReverseFieldPatch(state, state, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY) }]
			};
			await synchronizeStore.importCanonicalChains({ ...current, issueComments: [...current.issueComments, chain] });
			return toIssueCommentRecord(chain.head);
		});
	}

	public async updateIssueComment(input: { commentId: string; body: string; referencedIssueIds?: string[]; expectedRevision: number; expectedContentHash: string }): Promise<IssueCommentRecord> {
		return this.mutation(async (executor, actorId) => {
			if (input.body.trim().length === 0) throw new Error("Issue comment body must not be empty.");
			const synchronizeStore = new PgSynchronizeStore(executor);
			const current = await synchronizeStore.exportCanonicalChains();
			const chain = current.issueComments.find((candidate) => candidate.head.id === input.commentId || candidate.head.reference === input.commentId);
			if (!chain || chain.head.tombstone) throw new Error(`Issue comment not found: ${input.commentId}`);
			if (chain.head.revision !== input.expectedRevision || chain.head.contentHash !== input.expectedContentHash) throw new IssueCommentConflictError(chain.head.id, chain.head.revision, chain.head.contentHash);
			const referencedIssueIds = input.referencedIssueIds === undefined
				? chain.head.referencedIssueIds
				: await validateReferencedIssueIds(new PgEntityStore(executor, this.projectIdentity), input.referencedIssueIds);
			const updatedAt = new Date().toISOString();
			const successor = { body: input.body, referencedIssueIds, tombstone: false };
			const revision = chain.head.revision + 1;
			const updated = {
				...chain,
				head: { ...chain.head, ...successor, updatedBy: actorId, revision, contentHash: computeIssueCommentContentHash(successor.body, successor.referencedIssueIds, successor.tombstone), updatedAt },
				deltas: [...chain.deltas, { id: randomUUID(), revision, author: actorId, createdAt: updatedAt, ...createReverseFieldPatch(successor, { body: chain.head.body, referencedIssueIds: chain.head.referencedIssueIds, tombstone: false }, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY) }]
			};
			await synchronizeStore.importCanonicalChains({ ...current, issueComments: current.issueComments.map((candidate) => candidate.head.id === chain.head.id ? updated : candidate) });
			return toIssueCommentRecord(updated.head);
		});
	}

	public async deleteIssueComment(input: { commentId: string; expectedRevision: number; expectedContentHash: string }): Promise<IssueCommentRecord> {
		return this.mutation(async (executor, actorId) => {
			const synchronizeStore = new PgSynchronizeStore(executor);
			const current = await synchronizeStore.exportCanonicalChains();
			const chain = current.issueComments.find((candidate) => candidate.head.id === input.commentId || candidate.head.reference === input.commentId);
			if (!chain || chain.head.tombstone) throw new Error(`Issue comment not found: ${input.commentId}`);
			if (chain.head.revision !== input.expectedRevision || chain.head.contentHash !== input.expectedContentHash) throw new IssueCommentConflictError(chain.head.id, chain.head.revision, chain.head.contentHash);
			const updatedAt = new Date().toISOString();
			const successor = { body: chain.head.body, referencedIssueIds: chain.head.referencedIssueIds, tombstone: true };
			const revision = chain.head.revision + 1;
			const updated = {
				...chain,
				head: { ...chain.head, ...successor, updatedBy: actorId, revision, contentHash: computeIssueCommentContentHash(successor.body, successor.referencedIssueIds, successor.tombstone), updatedAt },
				deltas: [...chain.deltas, { id: randomUUID(), revision, author: actorId, createdAt: updatedAt, ...createReverseFieldPatch(successor, { ...successor, tombstone: false }, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY) }]
			};
			await synchronizeStore.importCanonicalChains({ ...current, issueComments: current.issueComments.map((candidate) => candidate.head.id === chain.head.id ? updated : candidate) });
			return toIssueCommentRecord(updated.head);
		});
	}

	public async listIssueComments(input: { issueId: string; before?: string; all?: boolean }): Promise<IssueCommentPage> {
		return this.transaction(async (executor) => {
			const issue = (await new PgEntityStore(executor, this.projectIdentity).getEntityDetails(input.issueId)).entity;
			if (issue.kind !== "issue") throw new Error(`Comments can only attach to issues: ${input.issueId}`);
			const comments = (await new PgSynchronizeStore(executor).exportCanonicalChains()).issueComments
				.filter((chain) => chain.head.issueId === issue.id)
				.map((chain) => toIssueCommentRecord(chain.head))
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.reference.localeCompare(right.reference));
			const cursor = input.before ? decodeCommentCursor(input.before) : undefined;
			const available = cursor ? comments.filter((comment) => comment.createdAt < cursor.createdAt || (comment.createdAt === cursor.createdAt && comment.reference < cursor.reference)) : comments;
			const page = input.all ? available : available.slice(-50);
			return { comments: page, total: comments.length, nextBefore: !input.all && available.length > page.length && page[0] ? encodeCommentCursor(page[0]) : null };
		});
	}

	public async listIssueCommentHistory(input: { commentId: string }): Promise<IssueCommentHistoryEntry[]> {
		return this.transaction(async (executor) => {
			const chain = (await new PgSynchronizeStore(executor).exportCanonicalChains()).issueComments
				.find((candidate) => candidate.head.id === input.commentId || candidate.head.reference === input.commentId);
			if (!chain) return [];
			return Array.from({ length: chain.head.revision }, (_, index) => {
				const targetRevision = index + 1;
				const state = materializeIssueCommentFromPatches(chain.head, chain.deltas, targetRevision);
				const delta = chain.deltas.find((candidate) => candidate.revision === targetRevision)!;
				return { commentId: chain.head.id, targetRevision, headRevision: chain.head.revision, ...state, author: delta.author, createdAt: delta.createdAt, restoredFromRevision: delta.restoredFromRevision ?? null };
			});
		});
	}

	public async listAllRelations(): Promise<RelationRecord[]> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).listAllRelations());
	}

	public async applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).applyRelations(relations));
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult> {
		return this.mutation((executor, actorId) => new PgEntityStore(executor, this.projectIdentity).linkEntities(input, actorId));
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult> {
		return this.mutation((executor) => new PgEntityStore(executor, this.projectIdentity).unlinkEntities(input));
	}

	public async updateEntityStatus(input: { entityId: string; status: string; author?: string }): Promise<StatusUpdateResult> {
		return this.mutation((executor, actorId) => new PgEntityStore(executor, this.projectIdentity).updateEntityStatus(input, actorId));
	}

	public async updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord> {
		return this.mutation((executor, actorId) => new PgEntityStore(executor, this.projectIdentity).updateEntity(input, actorId));
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord> {
		return this.mutation((executor, actorId) => new PgEntityStore(executor, this.projectIdentity).setEntityBody(input, actorId));
	}

	public async materializeEntityRevision(input: { entityId: string; revision: number }) {
		const result = await this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).materializeEntityRevision(input));
		await this.historyDiagnosticsStore.recordMaterialization("entity", result.headRevision, result.targetRevision);
		return result;
	}

	public async restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await this.mutation((executor, actorId) => new PgEntityStore(executor, this.projectIdentity).restoreEntityRevision(input, actorId));
		await this.historyDiagnosticsStore.recordMaterialization("entity", input.expectedRevision, input.revision);
		return result;
	}

	public async archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult> {
		return this.mutation((executor, actorId) => new PgEntityStore(executor, this.projectIdentity).archiveEntity(input, actorId));
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult> {
		return this.mutation((executor, actorId) => new PgEntityStore(executor, this.projectIdentity).moveEntity(input, actorId));
	}

	public async deleteEntity(input: { entityId: string }): Promise<DeleteResult> {
		return this.mutation((executor, actorId) => new PgEntityStore(executor, this.projectIdentity).deleteEntity(input, actorId));
	}

	public async listOrphans(kind?: string): Promise<EntityRecord[]> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).listOrphans(kind));
	}

	public async listProjectAdrs(): Promise<EntityRecord[]> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).listProjectAdrs());
	}

	public async getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getInitiativeBundle(initiativeId));
	}

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	public async getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	public async getDatabaseSnapshot(input?: { projectId: string }): Promise<DatabaseSnapshot | ProjectSnapshot> {
		if (input) {
			return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getDatabaseSnapshot(input));
		}

		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getDatabaseSnapshot());
	}

	public async getProjectDiscovery(input?: { projectId?: string }): Promise<ProjectDiscovery> {
		return this.tenantWideTransaction((executor) => new PgEntityStore(executor, this.projectIdentity).getProjectDiscovery(input));
	}

	public async getSnapshotSignature(): Promise<string> {
		return this.tenantWideTransaction((executor) => new PgEntityStore(executor, this.projectIdentity).getSnapshotSignature());
	}

	public async listContexts(): Promise<ContextListResult> {
		return this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).listContexts());
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).getContextDetails(input));
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).getContextDirectory());
	}

	public async queryContextDirectory(input: QueryContextDirectoryInput = {}): Promise<QueryContextDirectoryResult> {
		return this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).queryContextDirectory(input));
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ContextDetails> {
		return this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).upsertContext(input, actorId));
	}

	public async defineContextTerm(input: {
		scopeRef?: string;
		term: string;
		definition: string;
		avoid?: string[];
		author?: string;
		expectedRevision?: number;
		expectedContentHash?: string;
	}): Promise<DefineContextTermResult> {
		return this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).defineContextTerm(input, actorId));
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ForgetContextTermResult> {
		return this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).forgetContextTerm(input, actorId));
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }) {
		const result = await this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).materializeContextRevision(input));
		await this.historyDiagnosticsStore.recordMaterialization("context", result.headRevision, result.targetRevision);
		return result;
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }) {
		const result = await this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).materializeContextTermRevision(input));
		await this.historyDiagnosticsStore.recordMaterialization("context-term", result.headRevision, result.targetRevision);
		return result;
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).restoreContextRevision(input, actorId));
		await this.historyDiagnosticsStore.recordMaterialization("context", input.expectedRevision, input.revision);
		return result;
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).restoreContextTermRevision(input, actorId));
		await this.historyDiagnosticsStore.recordMaterialization("context-term", input.expectedRevision, input.revision);
		return result;
	}

	public async listTenants(): Promise<TenantSummary[]> {
		return this.tenantWideTransaction((executor) => listTenants(executor, this.tenantId));
	}

	public async deleteTenant(tenantId: string): Promise<DeleteTenantResult> {
		return this.tenantWideMutation((executor) => deleteTenant(executor, this.tenantId, tenantId));
	}

	public async renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult> {
		return this.tenantWideMutation((executor) => renameTenant(executor, this.tenantId, previousTenantId, newTenantId));
	}

	public async close(): Promise<void> {
		await this.pool.end();
	}
}

async function validateReferencedIssueIds(entityStore: PgEntityStore, referencedIssueIds: string[]): Promise<string[]> {
	const deduplicated = [...new Set(referencedIssueIds)];
	for (const referencedIssueId of deduplicated) {
		const referencedIssue = (await entityStore.getEntityDetails(referencedIssueId)).entity;
		if (referencedIssue.kind !== "issue") {
			throw new Error(`Issue comment references must target issues: ${referencedIssueId}`);
		}
	}
	return deduplicated;
}

function toIssueCommentRecord(head: CanonicalIssueCommentChain["head"]): IssueCommentRecord {
	return {
		id: head.id,
		reference: head.reference,
		issueId: head.issueId,
		createdBy: head.createdBy,
		updatedBy: head.updatedBy,
		...(!head.tombstone && { body: head.body }),
		referencedIssueIds: head.referencedIssueIds,
		tombstone: head.tombstone,
		revision: head.revision,
		contentHash: head.contentHash,
		createdAt: head.createdAt,
		updatedAt: head.updatedAt
	};
}

function encodeCommentCursor(comment: Pick<IssueCommentRecord, "createdAt" | "reference">): string {
	return Buffer.from(JSON.stringify({ createdAt: comment.createdAt, reference: comment.reference })).toString("base64url");
}

function decodeCommentCursor(value: string): { createdAt: string; reference: string } {
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; reference?: unknown };
		if (typeof cursor.createdAt !== "string" || typeof cursor.reference !== "string") throw new Error();
		return { createdAt: cursor.createdAt, reference: cursor.reference };
	} catch {
		throw new Error("Invalid issue comment cursor.");
	}
}

export function openPgStore(pool: Pool, tenantId: string): PgStore {
	return new PgStore(pool, tenantId);
}
