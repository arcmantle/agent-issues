import { createHash, randomUUID } from "node:crypto";

import { openLocalDaemonStore, readBuildContentHash, type LocalDaemonStoreOptions } from "@agent-issues/api-local";
import {
	BACKFILLABLE_BODY_KINDS,
	backfillBodies,
	computeEntityContentHash,
	PLAN_ENTRY_ROLES,
	PLAN_ENTRY_SCOPE_DIRECTIONS,
	type EntityRecord,
	type EntitySummary,
	type RelationDirection,
	type RelationType,
	type StorageDriver
} from "@agent-issues/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import packageJson from "../../package.json" with { type: "json" };

export type McpServerOptions = {
	projectIdentity?: string;
	openStore: () => Promise<
		Pick<
			StorageDriver,
			| "createEntity"
			| "updateEntity"
			| "getEntityDetails"
			| "listEntityHistory"
			| "queryEntities"
			| "queryEntityRelations"
			| "archiveEntity"
			| "deleteEntity"
			| "listContexts"
			| "getContextDetails"
			| "getContextDirectory"
			| "queryContextDirectory"
			| "upsertContext"
			| "defineContextTerm"
			| "forgetContextTerm"
			| "materializeContextRevision"
			| "materializeContextTermRevision"
			| "createIssueComment"
			| "updateIssueComment"
			| "deleteIssueComment"
			| "listIssueComments"
			| "listIssueCommentHistory"
			| "createPlanEntry"
			| "getPlanEntry"
			| "updatePlanEntry"
			| "deletePlanEntry"
			| "linkPlanEntryIssue"
			| "unlinkPlanEntryIssue"
			| "listPlanEntries"
			| "listPlanEntryHistory"
			| "moveEntity"
			| "updateEntityStatus"
			| "linkEntities"
			| "unlinkEntities"
			| "listOrphans"
			| "getInitiativeBundle"
			| "listTenants"
			| "renameTenant"
			| "deleteTenant"
			| "materializeEntityRevision"
			| "restoreEntityRevision"
			| "getDatabaseSnapshot"
			| "setEntityBody"
			| "tenantId"
		>
	>;
	now?: () => number;
};

export function createMcpServer(options: McpServerOptions): McpServer {
	const server = new McpServer({ name: "agent-issues", version: packageJson.version });
	const confirmationTokens = new ConfirmationTokenStore(options.now ?? Date.now);

	server.registerTool(
		"project_identity",
		{
			description: "Get the resolved project identity for this MCP server.",
			inputSchema: {}
		},
		async () => toolResult({ projectIdentity: options.projectIdentity ?? null })
	);

	server.registerTool(
		"entity_create",
		{
			description: "Create a tracker entity.",
			inputSchema: {
				kind: z.string().min(1),
				title: z.string().min(1),
				body: z.string().optional(),
				parentId: z.string().min(1).optional(),
				status: z.string().min(1).optional(),
				category: z.string().min(1).optional(),
				priority: z.string().min(1).optional(),
				type: z.string().min(1).optional(),
				links: z.array(z.object({ relationType: z.string().min(1), targetId: z.string().min(1) })).optional()
			}
		},
		async (input) => {
			const entity = await (await options.openStore()).createEntity(input);
			const result = { entity };
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"entity_edit",
		{
			description: "Edit a tracker entity.",
			inputSchema: {
				entityId: z.string().min(1),
				title: z.string().min(1).optional(),
				body: z.string().optional(),
				category: z.string().min(1).optional(),
				priority: z.string().min(1).optional(),
				type: z.string().min(1).nullable().optional(),
				expectedRevision: z.number().int().positive(),
				expectedContentHash: z.string().min(1)
			}
		},
		async (input) => {
			const entity = await (await options.openStore()).updateEntity(input);
			const result = { entity };
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"entity_archive",
		{
			description: "Archive a tracker entity.",
			inputSchema: { entityId: z.string().min(1) }
		},
		async ({ entityId }) => toolResult(await (await options.openStore()).archiveEntity({ entityId }))
	);

	server.registerTool(
		"entity_delete_inspect",
		{
			description: "Inspect the impact of deleting a tracker entity and get a confirmation token.",
			inputSchema: { entityId: z.string().min(1) }
		},
		async ({ entityId }) => {
			const impact = await (await options.openStore()).getEntityDetails(entityId);
			const confirmation = confirmationTokens.issue("entity_delete", { entityId });
			return toolResult({ impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt });
		}
	);

	server.registerTool(
		"entity_delete",
		{
			description: "Delete a tracker entity after inspection confirmation.",
			inputSchema: { entityId: z.string().min(1), confirmationToken: z.string().uuid() }
		},
		async ({ entityId, confirmationToken }) => {
			confirmationTokens.consume(confirmationToken, "entity_delete", { entityId });
			return toolResult(await (await options.openStore()).deleteEntity({ entityId }));
		}
	);

	server.registerTool(
		"entity_move",
		{
			description: "Move a tracker entity to a new parent.",
			inputSchema: { entityId: z.string().min(1), newParentId: z.string().min(1) }
		},
		async (input) => toolResult(await (await options.openStore()).moveEntity(input))
	);

	server.registerTool(
		"entity_status",
		{
			description: "Update a tracker entity status.",
			inputSchema: { entityId: z.string().min(1), status: z.string().min(1) }
		},
		async (input) => toolResult(await (await options.openStore()).updateEntityStatus(input))
	);

	server.registerTool(
		"entity_list",
		{
			description: "List tracker entities by kind and optional filters.",
			inputSchema: {
				kind: z.string().min(1),
				statuses: z.array(z.string().min(1)).optional(),
				parentId: z.string().min(1).optional(),
				limit: z.number().int().positive().optional()
			}
		},
		async (input) => toolResult(await (await options.openStore()).queryEntities(input))
	);

	server.registerTool(
		"entity_history",
		{
			description: "Get a tracker entity at a historical revision.",
			inputSchema: { entityId: z.string().min(1), revision: z.number().int().positive() }
		},
		async (input) => toolResult(await (await options.openStore()).materializeEntityRevision(input))
	);

	server.registerTool(
		"entity_show",
		{
			description: "Get tracker entity details by reference.",
			inputSchema: { reference: z.string().min(1) }
		},
		async ({ reference }) => {
			const store = await options.openStore();
			const details = await store.getEntityDetails(reference);
			return toolResult(details.entity.kind === "initiative" ? await store.getInitiativeBundle(reference) : details);
		}
	);

	server.registerTool(
		"context_list",
		{
			description: "List tracker contexts.",
			inputSchema: {}
		},
		async () => toolResult(await (await options.openStore()).listContexts())
	);

	server.registerTool(
		"context_show",
		{
			description: "Get tracker context details and terms.",
			inputSchema: { scopeRef: z.string().min(1).optional() }
		},
		async ({ scopeRef }) => toolResult(await (await options.openStore()).getContextDetails({ scopeRef }))
	);

	server.registerTool(
		"context_directory",
		{
			description: "Get the tracker context directory.",
			inputSchema: {}
		},
		async () => toolResult(await (await options.openStore()).getContextDirectory())
	);

	server.registerTool(
		"context_search",
		{
			description: "Search tracker context terms.",
			inputSchema: {
				query: z.string().min(1).optional(),
				view: z.enum(["all", "global", "initiatives"]).optional()
			}
		},
		async (input) => toolResult(await (await options.openStore()).queryContextDirectory(input))
	);

	server.registerTool(
		"context_conflicts",
		{
			description: "Find conflicting tracker context terms.",
			inputSchema: {
				query: z.string().min(1).optional(),
				view: z.enum(["all", "initiatives"]).optional()
			}
		},
		async ({ query, view }) => toolResult(await (await options.openStore()).queryContextDirectory({ conflictsOnly: true, query, view }))
	);

	server.registerTool(
		"context_set",
		{
			description: "Create or edit tracker context text.",
			inputSchema: {
				scopeRef: z.string().min(1).optional(),
				title: z.string().min(1),
				summary: z.string().min(1),
				expectedRevision: z.number().int().positive().optional(),
				expectedContentHash: z.string().min(1).optional()
			}
		},
		async (input) => toolResult(await (await options.openStore()).upsertContext(input))
	);

	server.registerTool(
		"context_term_define",
		{
			description: "Create or edit a tracker context term.",
			inputSchema: {
				scopeRef: z.string().min(1).optional(),
				term: z.string().min(1),
				definition: z.string().min(1),
				avoid: z.array(z.string().min(1)).optional(),
				expectedRevision: z.number().int().positive().optional(),
				expectedContentHash: z.string().min(1).optional()
			}
		},
		async (input) => toolResult(await (await options.openStore()).defineContextTerm(input))
	);

	server.registerTool(
		"context_term_forget",
		{
			description: "Remove a tracker context term.",
			inputSchema: {
				scopeRef: z.string().min(1).optional(),
				term: z.string().min(1),
				expectedRevision: z.number().int().positive().optional(),
				expectedContentHash: z.string().min(1).optional()
			}
		},
		async (input) => toolResult(await (await options.openStore()).forgetContextTerm(input))
	);

	server.registerTool(
		"context_revision",
		{
			description: "Get a tracker context revision.",
			inputSchema: { scopeRef: z.string().min(1).optional(), revision: z.number().int().positive() }
		},
		async (input) => toolResult(await (await options.openStore()).materializeContextRevision(input))
	);

	server.registerTool(
		"context_term_revision",
		{
			description: "Get a tracker context term revision.",
			inputSchema: { scopeRef: z.string().min(1).optional(), term: z.string().min(1), revision: z.number().int().positive() }
		},
		async (input) => toolResult(await (await options.openStore()).materializeContextTermRevision(input))
	);

	server.registerTool(
		"comment_create",
		{
			description: "Create an issue comment.",
			inputSchema: {
				issueId: z.string().min(1),
				body: z.string().min(1),
				referencedIssueIds: z.array(z.string().min(1)).optional()
			}
		},
		async (input) => {
			const store = await options.openStore();
			const referencedIssueIds = input.referencedIssueIds === undefined ? undefined : await resolveEntityIds(store, input.referencedIssueIds);
			const comment = await store.createIssueComment({ ...input, referencedIssueIds });
			return toolResult({ comment });
		}
	);

	server.registerTool(
		"comment_edit",
		{
			description: "Edit an issue comment.",
			inputSchema: {
				commentId: z.string().min(1),
				body: z.string().min(1),
				referencedIssueIds: z.array(z.string().min(1)).optional(),
				expectedRevision: z.number().int().positive(),
				expectedContentHash: z.string().min(1)
			}
		},
		async (input) => {
			const store = await options.openStore();
			const referencedIssueIds = input.referencedIssueIds === undefined ? undefined : await resolveEntityIds(store, input.referencedIssueIds);
			const comment = await store.updateIssueComment({ ...input, referencedIssueIds });
			return toolResult({ comment });
		}
	);

	server.registerTool(
		"comment_delete",
		{
			description: "Delete an issue comment.",
			inputSchema: {
				commentId: z.string().min(1),
				expectedRevision: z.number().int().positive(),
				expectedContentHash: z.string().min(1)
			}
		},
		async (input) => {
			const comment = await (await options.openStore()).deleteIssueComment(input);
			return toolResult({ comment });
		}
	);

	server.registerTool(
		"comment_list",
		{
			description: "List issue comments.",
			inputSchema: {
				issueId: z.string().min(1),
				before: z.string().min(1).optional(),
				all: z.boolean().optional()
			}
		},
		async (input) => toolResult(await (await options.openStore()).listIssueComments(input))
	);

	server.registerTool(
		"comment_history",
		{
			description: "Get issue comment revision history.",
			inputSchema: { commentId: z.string().min(1) }
		},
		async ({ commentId }) => toolResult({ history: await (await options.openStore()).listIssueCommentHistory({ commentId }) })
	);

	server.registerTool(
		"plan_entry_create",
		{
			description: "Create a Plan entry.",
			inputSchema: {
				planId: z.string().min(1),
				role: z.enum(PLAN_ENTRY_ROLES),
				body: z.string().min(1),
				scopeDirection: z.enum(PLAN_ENTRY_SCOPE_DIRECTIONS).optional(),
				referencedEntityIds: z.array(z.string().min(1)).optional(),
				supersededEntryIds: z.array(z.string().min(1)).optional()
			}
		},
		async (input) => {
			const store = await options.openStore();
			const referencedEntityIds = input.referencedEntityIds === undefined ? undefined : await resolveEntityIds(store, input.referencedEntityIds);
			const supersededEntryIds = input.supersededEntryIds === undefined ? undefined : await resolvePlanEntryIds(store, input.supersededEntryIds);
			const entry = await store.createPlanEntry({ ...input, referencedEntityIds, supersededEntryIds });
			return toolResult({ entry });
		}
	);

	server.registerTool(
		"plan_entry_edit",
		{
			description: "Edit a Plan entry.",
			inputSchema: {
				entryId: z.string().min(1),
				body: z.string().min(1),
				expectedRevision: z.number().int().positive(),
				expectedContentHash: z.string().min(1)
			}
		},
		async (input) => {
			const entry = await (await options.openStore()).updatePlanEntry(input);
			return toolResult({ entry });
		}
	);

	server.registerTool(
		"plan_entry_delete",
		{
			description: "Delete a Plan entry.",
			inputSchema: {
				entryId: z.string().min(1),
				expectedRevision: z.number().int().positive(),
				expectedContentHash: z.string().min(1)
			}
		},
		async (input) => {
			const entry = await (await options.openStore()).deletePlanEntry(input);
			return toolResult({ entry });
		}
	);

	server.registerTool(
		"plan_entry_list",
		{
			description: "List Plan entries.",
			inputSchema: { planId: z.string().min(1) }
		},
		async ({ planId }) => toolResult({ entries: await (await options.openStore()).listPlanEntries({ planId }) })
	);

	server.registerTool(
		"plan_entry_history",
		{
			description: "Get Plan entry revision history.",
			inputSchema: { entryId: z.string().min(1) }
		},
		async ({ entryId }) => toolResult({ history: await (await options.openStore()).listPlanEntryHistory({ entryId }) })
	);

	server.registerTool(
		"plan_entry_issue_link",
		{
			description: "Link a Plan entry to an issue.",
			inputSchema: { entryId: z.string().min(1), issueId: z.string().min(1) }
		},
		async (input) => toolResult(await (await options.openStore()).linkPlanEntryIssue(input))
	);

	server.registerTool(
		"plan_entry_issue_unlink",
		{
			description: "Remove a Plan entry issue link.",
			inputSchema: { entryId: z.string().min(1), issueId: z.string().min(1) }
		},
		async (input) => toolResult(await (await options.openStore()).unlinkPlanEntryIssue(input))
	);

	server.registerTool(
		"tenant_list",
		{
			description: "List tracker tenants.",
			inputSchema: {}
		},
		async () => {
			const tenants = await (await options.openStore()).listTenants();
			return {
				content: [{ type: "text", text: JSON.stringify(tenants) }],
				structuredContent: { tenants }
			};
		}
	);

	server.registerTool(
		"tenant_rename",
		{
			description: "Rename a tracker tenant.",
			inputSchema: { previousTenantId: z.string().min(1), newTenantId: z.string().min(1) }
		},
		async ({ previousTenantId, newTenantId }) => {
			const result = await (await options.openStore()).renameTenant(previousTenantId, newTenantId);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"tenant_delete_inspect",
		{
			description: "Inspect the impact of deleting a tracker tenant and get a confirmation token.",
			inputSchema: { tenantId: z.string().min(1) }
		},
		async ({ tenantId }) => {
			const impact = (await (await options.openStore()).listTenants()).find((tenant) => tenant.id === tenantId);
			if (!impact) {
				throw new Error(`Tenant not found: ${tenantId}`);
			}

			const confirmation = confirmationTokens.issue("tenant_delete", { tenantId });
			const result = { impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt };
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"tenant_delete",
		{
			description: "Delete a tracker tenant after inspection confirmation.",
			inputSchema: { tenantId: z.string().min(1), confirmationToken: z.string().uuid() }
		},
		async ({ tenantId, confirmationToken }) => {
			confirmationTokens.consume(confirmationToken, "tenant_delete", { tenantId });
			const result = await (await options.openStore()).deleteTenant(tenantId);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"entity_restore_inspect",
		{
			description: "Inspect an entity revision restore and get a confirmation token.",
			inputSchema: { entityId: z.string().min(1), revision: z.number().int().positive() }
		},
		async ({ entityId, revision }) => {
			const impact = await (await options.openStore()).materializeEntityRevision({ entityId, revision });
			const confirmation = confirmationTokens.issue("entity_restore", { entityId, revision });
			const result = { impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt };
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"entity_restore",
		{
			description: "Restore an entity revision after inspection confirmation.",
			inputSchema: { entityId: z.string().min(1), revision: z.number().int().positive(), confirmationToken: z.string().uuid() }
		},
		async ({ entityId, revision, confirmationToken }) => {
			confirmationTokens.consume(confirmationToken, "entity_restore", { entityId, revision });
			const store = await options.openStore();
			const target = await store.materializeEntityRevision({ entityId, revision });
			const head = await store.materializeEntityRevision({ entityId, revision: target.headRevision });
			const result = await store.restoreEntityRevision({
				entityId,
				revision,
				expectedRevision: head.headRevision,
				expectedContentHash: computeEntityContentHash(head.title, head.body)
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"body_backfill_inspect",
		{
			description: "Inspect body backfill impact and get a confirmation token.",
			inputSchema: { kinds: z.array(z.enum(BACKFILLABLE_BODY_KINDS)).optional(), force: z.boolean().optional() }
		},
		async ({ kinds, force }) => {
			const input = { kinds: kinds ?? [...BACKFILLABLE_BODY_KINDS], force: force ?? false };
			const impact = await backfillBodies(await options.openStore(), { ...input, dryRun: true });
			const confirmation = confirmationTokens.issue("body_backfill", input);
			const result = { impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt };
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"body_backfill",
		{
			description: "Backfill tracker bodies after inspection confirmation.",
			inputSchema: {
				kinds: z.array(z.enum(BACKFILLABLE_BODY_KINDS)).optional(),
				force: z.boolean().optional(),
				confirmationToken: z.string().uuid()
			}
		},
		async ({ kinds, force, confirmationToken }) => {
			const input = { kinds: kinds ?? [...BACKFILLABLE_BODY_KINDS], force: force ?? false };
			confirmationTokens.consume(confirmationToken, "body_backfill", input);
			const result = await backfillBodies(await options.openStore(), input);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"relation_link",
		{
			description: "Link two tracker entities with a relation.",
			inputSchema: { fromId: z.string().min(1), relationType: z.string().min(1), toId: z.string().min(1) }
		},
		async (input) => toolResult(await (await options.openStore()).linkEntities(input))
	);

	server.registerTool(
		"relation_unlink",
		{
			description: "Remove a relation between two tracker entities.",
			inputSchema: { fromId: z.string().min(1), relationType: z.string().min(1), toId: z.string().min(1) }
		},
		async (input) => toolResult(await (await options.openStore()).unlinkEntities(input))
	);

	server.registerTool(
		"relation_query",
		{
			description: "Query tracker entity relations.",
			inputSchema: {
				entityId: z.string().min(1),
				direction: z.enum(["incoming", "outgoing", "both"]).optional(),
				types: z.array(z.string().min(1)).optional()
			}
		},
		async ({ entityId, direction, types }) =>
			toolResult(await (await options.openStore()).queryEntityRelations({ entityId, direction, types: types as RelationType[] | undefined }))
	);

	server.registerTool(
		"initiative_bundle",
		{
			description: "Get an initiative and all of its tracked work.",
			inputSchema: { initiativeId: z.string().min(1) }
		},
		async ({ initiativeId }) => toolResult(await (await options.openStore()).getInitiativeBundle(initiativeId))
	);

	server.registerTool(
		"entity_next_work",
		{
			description: "Find available and blocked work for an initiative or its descendant.",
			inputSchema: { scopeId: z.string().min(1) }
		},
		async ({ scopeId }) => {
			const store = await options.openStore();
			const initiative = await resolveContainingInitiative(store, scopeId);
			const [bundle, allIssues] = await Promise.all([store.getInitiativeBundle(initiative.id), store.queryEntities({ kind: "issue" })]);
			return toolResult(deriveNextWork(bundle, allIssues.openBlockers ?? {}));
		}
	);

	server.registerTool(
		"entity_orphans",
		{
			description: "List tracker entities that have no structural parent.",
			inputSchema: { kind: z.string().min(1).optional() }
		},
		async ({ kind }) => toolResult({ entities: await (await options.openStore()).listOrphans(kind) })
	);

	return server;
}

function toolResult(result: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		structuredContent: result as Record<string, unknown>
	};
}

type NextWorkItem = {
	issue: EntityRecord;
	blockers: string[];
	unblocks: string[];
};

function deriveNextWork(
	bundle: { initiative: EntityRecord; issues: EntityRecord[]; subIssueLinks: Array<{ parent: EntityRecord; issue: EntityRecord }> },
	openBlockers: Record<string, string[]>
): { initiative: EntityRecord; available: NextWorkItem[]; blocked: NextWorkItem[] } {
	const unfinishedIssues = bundle.issues.filter((issue) => issue.status !== "done");
	const blockersByReference = new Map(unfinishedIssues.map((issue) => [issue.reference, new Set(openBlockers[issue.reference] ?? [])]));
	for (const { parent, issue } of bundle.subIssueLinks) {
		if (parent.status !== "done" && issue.status !== "done") {
			blockersByReference.get(parent.reference)?.add(issue.reference);
		}
	}

	const unblocksByReference = new Map(unfinishedIssues.map((issue) => [issue.reference, new Set<string>()]));
	for (const issue of unfinishedIssues) {
		for (const blocker of blockersByReference.get(issue.reference) ?? []) {
			unblocksByReference.get(blocker)?.add(issue.reference);
		}
	}

	const items = unfinishedIssues.map((issue) => ({
		issue,
		blockers: Array.from(blockersByReference.get(issue.reference) ?? []).sort(),
		unblocks: Array.from(unblocksByReference.get(issue.reference) ?? []).sort()
	}));
	return {
		initiative: bundle.initiative,
		available: items.filter((item) => item.blockers.length === 0),
		blocked: items.filter((item) => item.blockers.length > 0)
	};
}

async function resolveContainingInitiative(
	store: Pick<StorageDriver, "queryEntityRelations">,
	scopeId: string
): Promise<EntitySummary> {
	const structuralRelationTypes: RelationType[] = ["contains", "owns", "records", "tracks", "creates", "decomposes"];
	let details = await store.queryEntityRelations({ entityId: scopeId, direction: "incoming" as RelationDirection, types: structuralRelationTypes });
	const visited = new Set<string>();
	while (details.entity.kind !== "initiative") {
		if (visited.has(details.entity.id)) {
			throw new Error(`Structural parent cycle found while resolving initiative: ${scopeId}`);
		}
		visited.add(details.entity.id);
		const parent = details.incoming[0]?.entity;
		if (!parent) {
			throw new Error(`No initiative contains: ${scopeId}`);
		}
		details = await store.queryEntityRelations({ entityId: parent.id, direction: "incoming" as RelationDirection, types: structuralRelationTypes });
	}
	return details.entity;
}

async function resolveEntityIds(
	store: Pick<StorageDriver, "getEntityDetails">,
	references: string[]
): Promise<string[]> {
	return await Promise.all(references.map(async (reference) => (await store.getEntityDetails(reference)).entity.id));
}

async function resolvePlanEntryIds(
	store: Pick<StorageDriver, "getPlanEntry">,
	references: string[]
): Promise<string[]> {
	return await Promise.all(references.map(async (reference) => (await store.getPlanEntry({ entryId: reference })).id));
}

type ConfirmationToken = {
	expiresAt: number;
	inputHash: string;
	toolName: string;
};

class ConfirmationTokenStore {
	public constructor(now: () => number) {
		this.now = now;
	}

	protected readonly now: () => number;
	protected readonly tokens = new Map<string, ConfirmationToken>();

	public issue(toolName: string, input: Record<string, unknown>): { token: string; expiresAt: string } {
		const token = randomUUID();
		const expiresAt = this.now() + 5 * 60 * 1000;
		this.tokens.set(token, { toolName, inputHash: hashConfirmationInput(input), expiresAt });
		return { token, expiresAt: new Date(expiresAt).toISOString() };
	}

	public consume(token: string, toolName: string, input: Record<string, unknown>): void {
		const confirmation = this.tokens.get(token);
		this.tokens.delete(token);
		if (!confirmation) {
			throw new Error("Invalid confirmation token.");
		}
		if (confirmation.expiresAt <= this.now()) {
			throw new Error("Confirmation token has expired.");
		}
		if (confirmation.toolName !== toolName || confirmation.inputHash !== hashConfirmationInput(input)) {
			throw new Error("Confirmation token does not authorize this request.");
		}
	}
}

function hashConfirmationInput(input: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function createLocalMcpServer(options: LocalDaemonStoreOptions): McpServer {
	return createMcpServer({
		projectIdentity: options.projectIdentity,
		openStore: () => openLocalDaemonStore({ ...options, buildHash: options.buildHash ?? readBuildContentHash() })
	});
}

export { runMcpStdioServer } from "./stdio.js";