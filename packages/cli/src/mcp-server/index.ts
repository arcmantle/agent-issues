import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openLocalDaemonStore, readBuildContentHash, resolveWorkspaceObservation, type LocalDaemonStoreOptions } from "@agent-issues/api-local";
import {
	BACKFILLABLE_BODY_KINDS,
	backfillBodies,
	computeEntityContentHash,
	PLAN_ENTRY_ROLES,
	PLAN_ENTRY_SCOPE_DIRECTIONS,
	projectProposedPlan,
	type EntityRecord,
	type EntitySummary,
	type RelationDirection,
	type RelationType,
	type StorageDriver
} from "@agent-issues/core";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveProjectIdentity } from "../runtime/project-identity.js";
import { resolveMcpWorkspaceScope, type McpWorkspaceScope } from "./client-workspace.js";
import packageJson from "../../package.json" with { type: "json" };

const PLAN_PREVIEW_RESOURCE_URI = "ui://agent-issues/plan-preview.html";
const PLAN_PREVIEW_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const ISSUE_PREVIEW_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const PLAN_PREVIEW_RESOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PLAN_PREVIEW_RESOURCE_SCRIPT = readFileSync(
	path.resolve(PLAN_PREVIEW_RESOURCE_DIRECTORY, path.basename(PLAN_PREVIEW_RESOURCE_DIRECTORY) === "dist" ? "plan-preview.js" : "../../dist/plan-preview.js"),
	"utf8"
);
const PLAN_PREVIEW_RESOURCE_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><plan-preview-app></plan-preview-app><script type="module">${PLAN_PREVIEW_RESOURCE_SCRIPT}</script></body></html>`;
const ISSUE_PREVIEW_RESOURCE_URI = "ui://agent-issues/issue-preview.html";
const ISSUE_PREVIEW_RESOURCE_SCRIPT = readFileSync(
	path.resolve(PLAN_PREVIEW_RESOURCE_DIRECTORY, path.basename(PLAN_PREVIEW_RESOURCE_DIRECTORY) === "dist" ? "issue-preview.js" : "../../dist/issue-preview.js"),
	"utf8"
);
const ISSUE_PREVIEW_RESOURCE_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><issue-preview-app></issue-preview-app><script type="module">${ISSUE_PREVIEW_RESOURCE_SCRIPT}</script></body></html>`;

const issueBreakdownRelationSchema = z.object({
	relationType: z.string().min(1),
	targetId: z.string().min(1).optional(),
	targetKey: z.string().min(1).optional(),
	targetReference: z.string().min(1).optional()
});

const issueBreakdownIssueSchema = z.object({
	key: z.string().min(1),
	title: z.string().min(1),
	outcome: z.string().min(1),
	scope: z.array(z.string().min(1)),
	workMode: z.string().min(1),
	acceptanceCriteria: z.array(z.string().min(1)),
	parentKey: z.string().min(1).optional(),
	relationReferences: z.array(issueBreakdownRelationSchema)
});

export type McpServerOptions = {
	projectIdentity?: string;
	fallbackWorkspaceRoot?: string;
	openStore: (scope?: McpWorkspaceScope) => Promise<
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
			| "confirmPlan"
			| "moveEntity"
			| "updateEntityStatus"
			| "getProspectorSettings"
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
			| "getIssueBreakdownDraft"
			| "getLatestIssueBreakdownDraft"
			| "createIssueBreakdownDraft"
			| "approveIssueBreakdownDraft"
			| "tenantId"
		>
	>;
	now?: () => number;
};

export function createMcpServer(options: McpServerOptions): McpServer {
	const server = new McpServer({ name: "agent-issues", version: packageJson.version });
	const confirmationTokens = new ConfirmationTokenStore(options.now ?? Date.now);

	async function resolveScope(): Promise<McpWorkspaceScope> {
		return resolveMcpWorkspaceScope({
			listRoots: () => server.server.listRoots(),
			capabilities: server.server.getClientCapabilities(),
			fallbackWorkspaceRoot: options.fallbackWorkspaceRoot,
			projectIdentity: options.projectIdentity,
			resolveIdentity: (workspaceRoot) => resolveProjectIdentity(workspaceRoot).identity
		});
	}

	async function openStore(): Promise<Awaited<ReturnType<McpServerOptions["openStore"]>>> {
		return options.openStore(await resolveScope());
	}

	registerAppResource(
		server,
		"Plan Preview",
		PLAN_PREVIEW_RESOURCE_URI,
		{},
		async () => ({
			contents: [{ uri: PLAN_PREVIEW_RESOURCE_URI, mimeType: PLAN_PREVIEW_RESOURCE_MIME_TYPE, text: PLAN_PREVIEW_RESOURCE_HTML }]
		})
	);
	registerAppResource(
		server,
		"Issue Preview",
		ISSUE_PREVIEW_RESOURCE_URI,
		{},
		async () => ({
			contents: [{ uri: ISSUE_PREVIEW_RESOURCE_URI, mimeType: ISSUE_PREVIEW_RESOURCE_MIME_TYPE, text: ISSUE_PREVIEW_RESOURCE_HTML }]
		})
	);

	server.registerTool(
		"project_identity",
		{
			description: "Get the resolved project identity for this MCP server.",
			inputSchema: {}
		},
		async () => {
			const scope = await resolveScope();
			return toolResult({ projectIdentity: scope.projectIdentity ?? null, workspaceRoot: scope.workspaceRoot ?? null });
		}
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
			const entity = await (await openStore()).createEntity(input);
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
			const entity = await (await openStore()).updateEntity(input);
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
		async ({ entityId }) => toolResult(await (await openStore()).archiveEntity({ entityId }))
	);

	server.registerTool(
		"entity_delete_inspect",
		{
			description: "Inspect the impact of deleting a tracker entity and get a confirmation token.",
			inputSchema: { entityId: z.string().min(1) }
		},
		async ({ entityId }) => {
			const impact = await (await openStore()).getEntityDetails(entityId);
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
			return toolResult(await (await openStore()).deleteEntity({ entityId }));
		}
	);

	server.registerTool(
		"entity_move",
		{
			description: "Move a tracker entity to a new parent.",
			inputSchema: { entityId: z.string().min(1), newParentId: z.string().min(1) }
		},
		async (input) => toolResult(await (await openStore()).moveEntity(input))
	);

	server.registerTool(
		"entity_status",
		{
			description: "Update a tracker entity status.",
			inputSchema: { entityId: z.string().min(1), status: z.string().min(1) }
		},
		async (input) => {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const { entity } = await store.getEntityDetails(input.entityId);
			const workspaceObservation = entity.kind === "issue" && entity.status !== "done" && input.status === "done" && scope.workspaceRoot
				? await resolveWorkspaceObservation(scope.workspaceRoot, await store.getProspectorSettings())
				: undefined;
			return toolResult(await store.updateEntityStatus({ ...input, workspaceObservation }));
		}
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
		async (input) => toolResult(await (await openStore()).queryEntities(input))
	);

	server.registerTool(
		"entity_history",
		{
			description: "Get a tracker entity at a historical revision.",
			inputSchema: { entityId: z.string().min(1), revision: z.number().int().positive() }
		},
		async (input) => toolResult(await (await openStore()).materializeEntityRevision(input))
	);

	server.registerTool(
		"entity_show",
		{
			description: "Get tracker entity details by reference.",
			inputSchema: { reference: z.string().min(1) }
		},
		async ({ reference }) => {
			const store = await openStore();
			const details = await store.getEntityDetails(reference);
			return toolResult(details.entity.kind === "initiative" ? await store.getInitiativeBundle(reference) : details);
		}
	);

	registerAppTool(
		server,
		"plan_preview",
		{
			description: "Get a Proposed Plan for review.",
			inputSchema: { planId: z.string().min(1) },
			_meta: { ui: { resourceUri: PLAN_PREVIEW_RESOURCE_URI } }
		},
		async ({ planId }) => {
			const store = await openStore();
			const details = await store.getEntityDetails(planId);
			if (details.entity.kind !== "plan") {
				throw new Error(`Plan preview requires a Plan: ${planId}`);
			}
			const proposedPlan = projectProposedPlan(details.entity, await store.listPlanEntries({ planId: details.entity.id }));
			const plan = { ...proposedPlan, status: details.entity.status, revision: details.entity.revision };
			return textToolResult(formatPlanPreview(plan), { plan });
		}
	);

	server.registerTool(
		"issue_breakdown_create",
		{
			description: "Create an issue-breakdown draft without creating issue records.",
			inputSchema: {
				targetId: z.string().min(1),
				issues: z.array(issueBreakdownIssueSchema).min(1)
			}
		},
		async (input) => {
			const store = await openStore();
			const target = await store.getEntityDetails(input.targetId);
			const draft = await store.createIssueBreakdownDraft({
				targetId: target.entity.id,
				issues: input.issues
			});
			return toolResult({ draft });
		}
	);

	server.registerTool(
		"issue_breakdown_show",
		{
			description: "Get an issue-breakdown draft.",
			inputSchema: { draftId: z.string().min(1) }
		},
		async ({ draftId }) => toolResult({ draft: await (await openStore()).getIssueBreakdownDraft({ draftId }) })
	);

	server.registerTool(
		"issue_breakdown_latest",
		{
			description: "Get the latest issue-breakdown draft for a target.",
			inputSchema: { targetId: z.string().min(1) }
		},
		async ({ targetId }) => {
			const store = await openStore();
			const target = await store.getEntityDetails(targetId);
			return toolResult({ draft: await store.getLatestIssueBreakdownDraft({ targetId: target.entity.id }) });
		}
	);

	registerAppTool(
		server,
		"issue_breakdown_preview",
		{
			description: "Get a proposed issue breakdown for review.",
			inputSchema: { draftId: z.string().min(1) },
			_meta: { ui: { resourceUri: ISSUE_PREVIEW_RESOURCE_URI } }
		},
		async ({ draftId }) => {
			const draft = await (await openStore()).getIssueBreakdownDraft({ draftId });
			return textToolResult(formatIssueBreakdownPreview(draft), { draft });
		}
	);

	server.registerTool(
		"issue_breakdown_approve",
		{
			description: "Approve the exact proposed issue breakdown and create its issue graph.",
			inputSchema: { draftId: z.string().min(1), snapshotDigest: z.string().length(64).regex(/^[a-f0-9]+$/) }
		},
		async (input) => toolResult(await (await openStore()).approveIssueBreakdownDraft(input))
	);

	server.registerTool(
		"plan_confirm",
		{
			description: "Confirm the exact Proposed Plan snapshot as ready.",
			inputSchema: { planId: z.string().min(1), snapshotDigest: z.string().length(64).regex(/^[a-f0-9]+$/) }
		},
		async (input) => toolResult(await (await openStore()).confirmPlan(input))
	);

	server.registerTool(
		"context_list",
		{
			description: "List tracker contexts.",
			inputSchema: {}
		},
		async () => toolResult(await (await openStore()).listContexts())
	);

	server.registerTool(
		"context_show",
		{
			description: "Get tracker context details and terms.",
			inputSchema: { scopeRef: z.string().min(1).optional() }
		},
		async ({ scopeRef }) => toolResult(await (await openStore()).getContextDetails({ scopeRef }))
	);

	server.registerTool(
		"context_directory",
		{
			description: "Get the tracker context directory.",
			inputSchema: {}
		},
		async () => toolResult(await (await openStore()).getContextDirectory())
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
		async (input) => toolResult(await (await openStore()).queryContextDirectory(input))
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
		async ({ query, view }) => toolResult(await (await openStore()).queryContextDirectory({ conflictsOnly: true, query, view }))
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
		async (input) => toolResult(await (await openStore()).upsertContext(input))
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
		async (input) => toolResult(await (await openStore()).defineContextTerm(input))
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
		async (input) => toolResult(await (await openStore()).forgetContextTerm(input))
	);

	server.registerTool(
		"context_revision",
		{
			description: "Get a tracker context revision.",
			inputSchema: { scopeRef: z.string().min(1).optional(), revision: z.number().int().positive() }
		},
		async (input) => toolResult(await (await openStore()).materializeContextRevision(input))
	);

	server.registerTool(
		"context_term_revision",
		{
			description: "Get a tracker context term revision.",
			inputSchema: { scopeRef: z.string().min(1).optional(), term: z.string().min(1), revision: z.number().int().positive() }
		},
		async (input) => toolResult(await (await openStore()).materializeContextTermRevision(input))
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
			const store = await openStore();
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
			const store = await openStore();
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
			const comment = await (await openStore()).deleteIssueComment(input);
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
		async (input) => toolResult(await (await openStore()).listIssueComments(input))
	);

	server.registerTool(
		"comment_history",
		{
			description: "Get issue comment revision history.",
			inputSchema: { commentId: z.string().min(1) }
		},
		async ({ commentId }) => toolResult({ history: await (await openStore()).listIssueCommentHistory({ commentId }) })
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
			const store = await openStore();
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
			const entry = await (await openStore()).updatePlanEntry(input);
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
			const entry = await (await openStore()).deletePlanEntry(input);
			return toolResult({ entry });
		}
	);

	server.registerTool(
		"plan_entry_list",
		{
			description: "List Plan entries.",
			inputSchema: { planId: z.string().min(1) }
		},
		async ({ planId }) => toolResult({ entries: await (await openStore()).listPlanEntries({ planId }) })
	);

	server.registerTool(
		"plan_entry_history",
		{
			description: "Get Plan entry revision history.",
			inputSchema: { entryId: z.string().min(1) }
		},
		async ({ entryId }) => toolResult({ history: await (await openStore()).listPlanEntryHistory({ entryId }) })
	);

	server.registerTool(
		"plan_entry_issue_link",
		{
			description: "Link a Plan entry to an issue.",
			inputSchema: { entryId: z.string().min(1), issueId: z.string().min(1) }
		},
		async (input) => toolResult(await (await openStore()).linkPlanEntryIssue(input))
	);

	server.registerTool(
		"plan_entry_issue_unlink",
		{
			description: "Remove a Plan entry issue link.",
			inputSchema: { entryId: z.string().min(1), issueId: z.string().min(1) }
		},
		async (input) => toolResult(await (await openStore()).unlinkPlanEntryIssue(input))
	);

	server.registerTool(
		"tenant_list",
		{
			description: "List tracker tenants.",
			inputSchema: {}
		},
		async () => {
			const tenants = await (await openStore()).listTenants();
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
			const result = await (await openStore()).renameTenant(previousTenantId, newTenantId);
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
			const impact = (await (await openStore()).listTenants()).find((tenant) => tenant.id === tenantId);
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
			const result = await (await openStore()).deleteTenant(tenantId);
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
			const impact = await (await openStore()).materializeEntityRevision({ entityId, revision });
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
			const store = await openStore();
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
			const impact = await backfillBodies(await openStore(), { ...input, dryRun: true });
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
			const result = await backfillBodies(await openStore(), input);
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
		async (input) => toolResult(await (await openStore()).linkEntities(input))
	);

	server.registerTool(
		"relation_unlink",
		{
			description: "Remove a relation between two tracker entities.",
			inputSchema: { fromId: z.string().min(1), relationType: z.string().min(1), toId: z.string().min(1) }
		},
		async (input) => toolResult(await (await openStore()).unlinkEntities(input))
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
			toolResult(await (await openStore()).queryEntityRelations({ entityId, direction, types: types as RelationType[] | undefined }))
	);

	server.registerTool(
		"initiative_bundle",
		{
			description: "Get an initiative and all of its tracked work.",
			inputSchema: { initiativeId: z.string().min(1) }
		},
		async ({ initiativeId }) => toolResult(await (await openStore()).getInitiativeBundle(initiativeId))
	);

	server.registerTool(
		"entity_next_work",
		{
			description: "Find available and blocked work for an initiative or its descendant.",
			inputSchema: { scopeId: z.string().min(1) }
		},
		async ({ scopeId }) => {
			const store = await openStore();
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
		async ({ kind }) => toolResult({ entities: await (await openStore()).listOrphans(kind) })
	);

	return server;
}

function toolResult(result: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		structuredContent: result as Record<string, unknown>
	};
}

function textToolResult(text: string, structuredContent: Record<string, unknown>): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
	return { content: [{ type: "text", text }], structuredContent };
}

function formatPlanPreview(plan: {
	title: string;
	goal: string;
	context: string;
	snapshotDigest: string;
	revision?: number;
	current: Array<{ title: string; entries: Array<{ body?: string }> }>;
}): string {
	const sections = [
		`# ${plan.title}`,
		plan.revision === undefined ? "" : `Revision ${plan.revision}`,
		`Snapshot digest: ${plan.snapshotDigest}`,
		`## Goal\n\n${plan.goal || "No Goal recorded."}`,
		`## Context\n\n${plan.context || "No Context recorded."}`,
		...plan.current.map((group) => `## ${group.title}\n\n${group.entries.map((entry) => entry.body || "").join("\n\n")}`)
	];
	return sections.filter((section) => section.length > 0).join("\n\n");
}

function formatIssueBreakdownPreview(draft: {
	targetReference: string;
	snapshotDigest: string;
	issues: Array<{
		title: string;
		outcome: string;
		scope: string[];
		workMode: string;
		acceptanceCriteria: string[];
		parentKey?: string;
		relationReferences: Array<{ relationType: string; targetKey?: string; targetReference?: string }>;
	}>;
}): string {
	const issues = draft.issues.map((issue, index) => [
		`## ${index + 1}. ${issue.title}`,
		`Outcome: ${issue.outcome}`,
		`Scope:\n${issue.scope.map((item) => `- ${item}`).join("\n") || "- None"}`,
		`Work mode: ${issue.workMode}`,
		`Acceptance criteria:\n${issue.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- None"}`,
		`Parent: ${issue.parentKey ?? "None"}`,
		`Relations:\n${issue.relationReferences.map((relation) => `- ${relation.relationType}: ${relation.targetKey ?? relation.targetReference ?? "None"}`).join("\n") || "- None"}`
	].join("\n\n"));
	return [`# Issue breakdown for ${draft.targetReference}`, `Snapshot digest: ${draft.snapshotDigest}`, ...issues].join("\n\n");
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
		fallbackWorkspaceRoot: options.workspaceRoot,
		projectIdentity: options.projectIdentity,
		openStore: (scope) => openLocalDaemonStore({
			...options,
			buildHash: options.buildHash ?? readBuildContentHash(),
			projectIdentity: scope?.projectIdentity ?? options.projectIdentity,
			workspaceRoot: scope?.workspaceRoot ?? options.workspaceRoot
		})
	});
}

export { runMcpStdioServer } from "./stdio.js";