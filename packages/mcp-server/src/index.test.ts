import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalDaemonServer, openSqliteStore, type LocalDaemonServerHandle } from "@agent-issues/api-local";
import { resolveWellKnownLocalTenantId, type RunCredentialCommand } from "@agent-issues/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auditMcpToolRegistrations } from "./mcp-tool-audit.js";
import { createLocalMcpServer, createMcpServer } from "./index.js";

function fakeCredentialStore(): { platform: "darwin"; runCommand: RunCredentialCommand } {
	const store = new Map<string, string>();
	return {
		platform: "darwin",
		runCommand: async (command) => {
			const [action, , account, , service] = command.args;
			const key = `${service}:${account}`;
			if (action === "add-generic-password") {
				store.set(key, command.args[6]);
				return { stdout: "", exitCode: 0 };
			}
			if (action === "find-generic-password") {
				const value = store.get(key);
				return value === undefined ? { stdout: "", exitCode: 44 } : { stdout: `${value}\n`, exitCode: 0 };
			}
			const existed = store.delete(key);
			return { stdout: "", exitCode: existed ? 0 : 44 };
		}
	};
}

describe("agent-issues MCP server", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("registers a tool for every included tracker data command", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const tools = await client.listTools();

		expect(auditMcpToolRegistrations(tools.tools.map((tool) => tool.name))).toEqual({ missing: [] });

		await client.close();
		await server.close();
		await store.close();
	});

	it("creates an entity through entity_create", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "entity_create", arguments: { kind: "issue", title: "Create through MCP", body: "Authored body" } });

		expect(result).toMatchObject({ structuredContent: { entity: { kind: "issue", title: "Create through MCP", body: "Authored body" } } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("edits an entity through entity_edit with its expected revision", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const entity = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({
			name: "entity_edit",
			arguments: {
				entityId: entity.reference,
				title: "Edited title",
				expectedRevision: entity.revision,
				expectedContentHash: entity.contentHash
			}
		});

		expect(result).toMatchObject({ structuredContent: { entity: { reference: entity.reference, title: "Edited title", revision: 2 } } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("discovers the entity and graph command tools", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const tools = await client.listTools();

		expect(tools.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				"entity_create",
				"entity_edit",
				"entity_archive",
				"entity_delete",
				"entity_history",
				"entity_list",
				"entity_move",
				"entity_restore",
				"entity_show",
				"entity_status",
				"relation_link",
				"relation_unlink",
				"relation_query",
				"initiative_bundle",
				"entity_next_work",
				"entity_orphans"
			])
		);

		await client.close();
		await server.close();
		await store.close();
	});

	it("runs entity lifecycle queries and mutations", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const firstParent = await store.createEntity({ kind: "initiative", title: "First parent" });
		const secondParent = await store.createEntity({ kind: "initiative", title: "Second parent" });
		const issue = await store.createEntity({ kind: "issue", title: "Lifecycle issue", body: "Lifecycle body", parentId: firstParent.id });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const status = await client.callTool({ name: "entity_status", arguments: { entityId: issue.reference, status: "in-progress" } });
		const move = await client.callTool({ name: "entity_move", arguments: { entityId: issue.reference, newParentId: secondParent.reference } });
		const history = await client.callTool({ name: "entity_history", arguments: { entityId: issue.reference, revision: 1 } });
		const list = await client.callTool({ name: "entity_list", arguments: { kind: "issue", parentId: secondParent.reference } });
		const relations = await client.callTool({ name: "relation_query", arguments: { entityId: issue.reference } });
		const shown = await client.callTool({ name: "entity_show", arguments: { reference: issue.reference } });
		const archive = await client.callTool({ name: "entity_archive", arguments: { entityId: issue.reference } });

		expect(status).toMatchObject({ structuredContent: { entity: { reference: issue.reference, status: "in-progress" } } });
		expect((status.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((status.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");
		expect(move).toMatchObject({ structuredContent: { entity: { reference: issue.reference }, newParentId: secondParent.id } });
		expect(history).toMatchObject({ structuredContent: { entityId: issue.reference, targetRevision: 1 } });
		expect(list).toMatchObject({ structuredContent: { entities: [expect.objectContaining({ reference: issue.reference })] } });
		expect((list.structuredContent as { entities: object[] }).entities[0]).not.toHaveProperty("body");
		expect((list.structuredContent as { entities: object[] }).entities[0]).not.toHaveProperty("bodySource");
		expect((relations.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((relations.structuredContent as { incoming: Array<{ entity: object }> }).incoming[0]?.entity).not.toHaveProperty("body");
		expect(shown).toMatchObject({ structuredContent: { entity: { reference: issue.reference, body: "Lifecycle body", bodySource: "authored" } } });
		expect(archive).toMatchObject({ structuredContent: { entity: { reference: issue.reference, status: "done" } } });
		expect((archive.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((archive.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");

		await client.close();
		await server.close();
		await store.close();
	});

	it("requires inspection before entity_delete", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Delete through MCP" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({ name: "entity_delete_inspect", arguments: { entityId: issue.reference } });
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({ name: "entity_delete", arguments: { entityId: issue.reference, confirmationToken } });

		expect(inspection).toMatchObject({ structuredContent: { impact: { entity: { reference: issue.reference } }, confirmationToken: expect.any(String) } });
		expect(result).toMatchObject({ structuredContent: { entity: { reference: issue.reference }, removed: true } });
		await expect(store.getEntityDetails(issue.reference)).rejects.toThrow();

		await client.close();
		await server.close();
		await store.close();
	});

	it("runs relation and initiative graph queries", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Graph initiative" });
		const source = await store.createEntity({ kind: "issue", title: "Source", parentId: initiative.id });
		const target = await store.createEntity({ kind: "issue", title: "Target", parentId: initiative.id });
		const orphan = await store.createEntity({ kind: "issue", title: "Orphan" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const linked = await client.callTool({ name: "relation_link", arguments: { fromId: source.reference, relationType: "blocks", toId: target.reference } });
		const relations = await client.callTool({ name: "relation_query", arguments: { entityId: source.reference, direction: "outgoing", types: ["blocks"] } });
		const bundle = await client.callTool({ name: "initiative_bundle", arguments: { initiativeId: initiative.reference } });
		const shown = await client.callTool({ name: "entity_show", arguments: { reference: initiative.reference } });
		const orphans = await client.callTool({ name: "entity_orphans", arguments: { kind: "issue" } });
		const unlinked = await client.callTool({ name: "relation_unlink", arguments: { fromId: source.reference, relationType: "blocks", toId: target.reference } });

		expect(linked).toMatchObject({ structuredContent: { created: true } });
		expect(relations).toMatchObject({ structuredContent: { outgoing: [expect.objectContaining({ entity: expect.objectContaining({ reference: target.reference }) })] } });
		expect(bundle).toMatchObject({ structuredContent: { initiative: { reference: initiative.reference }, issues: expect.arrayContaining([expect.objectContaining({ reference: source.reference })]) } });
		expect(shown).toMatchObject({ structuredContent: { initiative: { reference: initiative.reference }, issues: expect.arrayContaining([expect.objectContaining({ reference: source.reference })]) } });
		expect(orphans).toMatchObject({ structuredContent: { entities: expect.arrayContaining([expect.objectContaining({ reference: orphan.reference })]) } });
		expect(unlinked).toMatchObject({ structuredContent: { removed: true } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("ranks available and blocked work through entity_next_work", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Work initiative" });
		const blocker = await store.createEntity({ kind: "issue", title: "Blocker", parentId: initiative.id });
		const blocked = await store.createEntity({ kind: "issue", title: "Blocked", parentId: initiative.id });
		await store.linkEntities({ fromId: blocker.id, relationType: "blocks", toId: blocked.id });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "entity_next_work", arguments: { scopeId: blocked.reference } });

		expect(result).toMatchObject({
			structuredContent: {
				available: [expect.objectContaining({ issue: expect.objectContaining({ reference: blocker.reference }) })],
				blocked: [expect.objectContaining({ issue: expect.objectContaining({ reference: blocked.reference }), blockers: [blocker.reference] })]
			}
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("returns entity details from entity_show", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Read through MCP" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "entity_show", arguments: { reference: issue.reference } });

		expect(result).toMatchObject({ structuredContent: { entity: { reference: issue.reference, title: "Read through MCP" } } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("creates, changes, links, and deletes Plan entries through MCP", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "MCP Plan", parentId: initiative.id });
		const issue = await store.createEntity({ kind: "issue", title: "Plan issue" });
		const relatedIssue = await store.createEntity({ kind: "issue", title: "Related Plan issue" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const created = await client.callTool({
			name: "plan_entry_create",
			arguments: { planId: plan.reference, role: "question", body: "What must the tool return?", referencedEntityIds: [relatedIssue.reference] }
		});
		expect(created).toMatchObject({ structuredContent: { entry: { body: "What must the tool return?", referencedEntityIds: [relatedIssue.id] } } });
		const entry = (created.structuredContent as { entry: { reference: string; revision: number; contentHash: string } }).entry;
		const list = await client.callTool({ name: "plan_entry_list", arguments: { planId: plan.reference } });
		const edited = await client.callTool({
			name: "plan_entry_edit",
			arguments: { entryId: entry.reference, body: "The tool returns structured data.", expectedRevision: entry.revision, expectedContentHash: entry.contentHash }
		});
		const updatedEntry = (edited.structuredContent as { entry: { reference: string; revision: number; contentHash: string } }).entry;
		const history = await client.callTool({ name: "plan_entry_history", arguments: { entryId: updatedEntry.reference } });
		const linked = await client.callTool({ name: "plan_entry_issue_link", arguments: { entryId: updatedEntry.reference, issueId: issue.reference } });
		const linkedEntry = await store.getPlanEntry({ entryId: updatedEntry.reference });
		const unlinked = await client.callTool({ name: "plan_entry_issue_unlink", arguments: { entryId: updatedEntry.reference, issueId: issue.reference } });
		const unlinkedEntry = await store.getPlanEntry({ entryId: updatedEntry.reference });
		const deleted = await client.callTool({
			name: "plan_entry_delete",
			arguments: { entryId: updatedEntry.reference, expectedRevision: unlinkedEntry.revision, expectedContentHash: unlinkedEntry.contentHash }
		});

		expect(list).toMatchObject({ structuredContent: { entries: [expect.objectContaining({ reference: entry.reference, body: "What must the tool return?" })] } });
		expect(edited).toMatchObject({ structuredContent: { entry: { reference: entry.reference, body: "The tool returns structured data.", revision: 2 } } });
		expect(history).toMatchObject({ structuredContent: { history: expect.arrayContaining([expect.objectContaining({ entryId: expect.any(String), targetRevision: 1, body: "What must the tool return?" })]) } });
		expect(linked).toMatchObject({ structuredContent: { created: true } });
		expect(linkedEntry.referencedEntityIds).toContain(issue.id);
		expect(unlinked).toMatchObject({ structuredContent: { removed: true } });
		expect(deleted).toMatchObject({ structuredContent: { entry: { reference: entry.reference, tombstone: true } } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("creates, changes, lists, and deletes issue comments through MCP", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Comment issue" });
		const relatedIssue = await store.createEntity({ kind: "issue", title: "Related comment issue" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const created = await client.callTool({
			name: "comment_create",
			arguments: { issueId: issue.reference, body: "Authored comment", referencedIssueIds: [relatedIssue.reference] }
		});
		expect(created).toMatchObject({ structuredContent: { comment: { body: "Authored comment", referencedIssueIds: [relatedIssue.id] } } });
		const comment = (created.structuredContent as { comment: { reference: string; revision: number; contentHash: string } }).comment;
		const list = await client.callTool({ name: "comment_list", arguments: { issueId: issue.reference, all: true } });
		const edited = await client.callTool({
			name: "comment_edit",
			arguments: { commentId: comment.reference, body: "Edited comment", expectedRevision: comment.revision, expectedContentHash: comment.contentHash }
		});
		const updatedComment = (edited.structuredContent as { comment: { reference: string; revision: number; contentHash: string } }).comment;
		const history = await client.callTool({ name: "comment_history", arguments: { commentId: updatedComment.reference } });
		const deleted = await client.callTool({
			name: "comment_delete",
			arguments: { commentId: updatedComment.reference, expectedRevision: updatedComment.revision, expectedContentHash: updatedComment.contentHash }
		});

		expect(list).toMatchObject({ structuredContent: { comments: [expect.objectContaining({ reference: comment.reference, body: "Authored comment" })] } });
		expect(edited).toMatchObject({ structuredContent: { comment: { reference: comment.reference, body: "Edited comment", revision: 2 } } });
		expect(history).toMatchObject({
			structuredContent: {
				history: expect.arrayContaining([expect.objectContaining({ commentId: expect.any(String), targetRevision: 1, body: "Authored comment" })])
			}
		});
		expect(deleted).toMatchObject({ structuredContent: { comment: { reference: comment.reference, tombstone: true, revision: 3 } } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("returns context details and terms through context_show", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Glossary initiative" });
		await store.upsertContext({ scopeRef: initiative.reference, title: "Glossary", summary: "Initiative terms." });
		await store.defineContextTerm({ scopeRef: initiative.reference, term: "MCP", definition: "A protocol." });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "context_show", arguments: { scopeRef: initiative.reference } });

		expect(result).toMatchObject({
			structuredContent: {
				context: { title: "Glossary", summary: "Initiative terms." },
				terms: [expect.objectContaining({ term: "MCP", definition: "A protocol." })]
			}
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("queries, changes, and reads context revisions through context tools", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const firstInitiative = await store.createEntity({ kind: "initiative", title: "First context initiative" });
		const secondInitiative = await store.createEntity({ kind: "initiative", title: "Second context initiative" });
		await store.upsertContext({ scopeRef: firstInitiative.reference, title: "First context", summary: "First summary." });
		await store.upsertContext({ scopeRef: secondInitiative.reference, title: "Second context", summary: "Second summary." });
		await store.defineContextTerm({ scopeRef: firstInitiative.reference, term: "parity", definition: "Equivalent behavior." });
		await store.defineContextTerm({ scopeRef: secondInitiative.reference, term: "parity", definition: "A different definition." });
		const firstContext = await store.getContextDetails({ scopeRef: firstInitiative.reference });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const directoryResult = await client.callTool({ name: "context_directory", arguments: {} });
		const search = await client.callTool({ name: "context_search", arguments: { query: "parity", view: "initiatives" } });
		const conflicts = await client.callTool({ name: "context_conflicts", arguments: { query: "parity" } });
		const set = await client.callTool({
			name: "context_set",
			arguments: {
				scopeRef: firstInitiative.reference,
				title: "First context revised",
				summary: "Revised summary.",
				expectedRevision: firstContext.context.revision,
				expectedContentHash: firstContext.context.contentHash
			}
		});
		const define = await client.callTool({
			name: "context_term_define",
			arguments: { scopeRef: firstInitiative.reference, term: "token", definition: "A temporary confirmation value." }
		});
		const token = (await store.getContextDetails({ scopeRef: firstInitiative.reference })).terms.find((term) => term.term === "token");
		const contextRevision = await client.callTool({ name: "context_revision", arguments: { scopeRef: firstInitiative.reference, revision: 1 } });
		const termRevision = await client.callTool({ name: "context_term_revision", arguments: { scopeRef: firstInitiative.reference, term: "parity", revision: 1 } });
		const forget = await client.callTool({
			name: "context_term_forget",
			arguments: {
				scopeRef: firstInitiative.reference,
				term: "token",
				expectedRevision: token?.revision,
				expectedContentHash: token?.contentHash
			}
		});

		expect(directoryResult).toMatchObject({
			structuredContent: {
				initiatives: expect.arrayContaining([expect.objectContaining({ context: expect.objectContaining({ title: "First context" }) })])
			}
		});
		expect(search).toMatchObject({ structuredContent: { query: "parity", view: "initiatives", terms: [expect.objectContaining({ term: "parity" })] } });
		expect(conflicts).toMatchObject({ structuredContent: { conflictsOnly: true, terms: [expect.objectContaining({ term: "parity", hasConflictingDefinitions: true })] } });
		expect(set).toMatchObject({ structuredContent: { context: { title: "First context revised", summary: "Revised summary." } } });
		expect(define).toMatchObject({ structuredContent: { term: { term: "token", definition: "A temporary confirmation value." }, created: true } });
		expect(contextRevision).toMatchObject({ structuredContent: { targetRevision: 1, title: "First context" } });
		expect(termRevision).toMatchObject({ structuredContent: { targetRevision: 1, term: "parity", definition: "Equivalent behavior." } });
		expect(forget).toMatchObject({ structuredContent: { term: "token", removed: true } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("lists tracker contexts through context_list", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Context initiative" });
		await store.upsertContext({ scopeRef: initiative.reference, title: "Initiative context", summary: "Tracker terms." });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "context_list", arguments: {} });

		expect(result).toMatchObject({
			structuredContent: {
				contexts: expect.arrayContaining([expect.objectContaining({ context: expect.objectContaining({ title: "Initiative context" }) })])
			}
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("lists tenants through tenant_list", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "tenant_list", arguments: {} });

		expect(result).toMatchObject({ structuredContent: { tenants: [{ id: resolveWellKnownLocalTenantId() }] } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("renames a tenant through tenant_rename", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: "tenant-source" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({
			name: "tenant_rename",
			arguments: { previousTenantId: "tenant-source", newTenantId: "tenant-renamed" }
		});

		expect(result).toMatchObject({ structuredContent: { previousTenantId: "tenant-source", newTenantId: "tenant-renamed", renamed: true } });

		await client.close();
		await server.close();
		await tenantStore.close();
		await store.close();
	});

	it("requires inspection before tenant_delete", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: "tenant-delete" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({ name: "tenant_delete_inspect", arguments: { tenantId: "tenant-delete" } });
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({ name: "tenant_delete", arguments: { tenantId: "tenant-delete", confirmationToken } });

		expect(inspection).toMatchObject({ structuredContent: { impact: { id: "tenant-delete" }, confirmationToken: expect.any(String) } });
		expect(result).toMatchObject({ structuredContent: { tenantId: "tenant-delete", removed: true } });

		await client.close();
		await server.close();
		await tenantStore.close();
		await store.close();
	});

	it("rejects expired confirmation tokens", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: "tenant-expired" });
		let now = Date.UTC(2026, 0, 1);
		const server = createMcpServer({ openStore: async () => store, now: () => now });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({ name: "tenant_delete_inspect", arguments: { tenantId: "tenant-expired" } });
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		now += 5 * 60 * 1000;
		const result = await client.callTool({ name: "tenant_delete", arguments: { tenantId: "tenant-expired", confirmationToken } });

		expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("has expired") }] });
		expect(await store.listTenants()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "tenant-expired" })]));

		await client.close();
		await server.close();
		await tenantStore.close();
		await store.close();
	});

	it("rejects a replayed confirmation token", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: "tenant-replay" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({ name: "tenant_delete_inspect", arguments: { tenantId: "tenant-replay" } });
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		await client.callTool({ name: "tenant_delete", arguments: { tenantId: "tenant-replay", confirmationToken } });
		const result = await client.callTool({ name: "tenant_delete", arguments: { tenantId: "tenant-replay", confirmationToken } });

		expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Invalid confirmation token") }] });

		await client.close();
		await server.close();
		await tenantStore.close();
		await store.close();
	});

	it("rejects a confirmation token for a different tenant deletion", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: sourceStore } = await openSqliteStore(dbPath, { tenant: "tenant-source" });
		const { store: targetStore } = await openSqliteStore(dbPath, { tenant: "tenant-target" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({ name: "tenant_delete_inspect", arguments: { tenantId: "tenant-source" } });
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({ name: "tenant_delete", arguments: { tenantId: "tenant-target", confirmationToken } });

		expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("does not authorize") }] });
		expect(await store.listTenants()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "tenant-source" }), expect.objectContaining({ id: "tenant-target" })]));

		await client.close();
		await server.close();
		await sourceStore.close();
		await targetStore.close();
		await store.close();
	});

	it("requires inspection before entity_restore", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body" });
		await store.updateEntity({
			entityId: issue.id,
			title: "Updated title",
			expectedRevision: issue.revision,
			expectedContentHash: issue.contentHash
		});
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({ name: "entity_restore_inspect", arguments: { entityId: issue.id, revision: 1 } });
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({ name: "entity_restore", arguments: { entityId: issue.id, revision: 1, confirmationToken } });

		expect(inspection).toMatchObject({ structuredContent: { impact: { entityId: issue.id, title: "Original title" }, confirmationToken: expect.any(String) } });
		expect(result).toMatchObject({ structuredContent: { entityId: issue.id, title: "Original title", restoredFromRevision: 1 } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("requires inspection before body_backfill", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		await store.createEntity({ kind: "issue", title: "Backfill this body" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({ name: "body_backfill_inspect", arguments: { kinds: ["issue"] } });
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({ name: "body_backfill", arguments: { kinds: ["issue"], confirmationToken } });

		expect(inspection).toMatchObject({ structuredContent: { impact: { dryRun: true, updated: 1 }, confirmationToken: expect.any(String) } });
		expect(result).toMatchObject({ structuredContent: { dryRun: false, updated: 1 } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("starts a missing local daemon once and reads entity details through it", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-daemon-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const homeDirectory = path.join(directory, "home");
		const credentialStoreOptions = fakeCredentialStore();
		const { store } = await openSqliteStore(dbPath, { tenant: resolveWellKnownLocalTenantId() });
		const issue = await store.createEntity({ kind: "issue", title: "Read through the daemon" });
		await store.close();

		let daemon: LocalDaemonServerHandle | undefined;
		let spawnCount = 0;
		const server = createLocalMcpServer({
			dbPath,
			homeDirectory,
			credentialStoreOptions,
			spawn: () => {
				spawnCount++;
				daemon = createLocalDaemonServer({ dbPath, homeDirectory, credentialStoreOptions, idleTimeoutMs: 0 });
			}
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "entity_show", arguments: { reference: issue.reference } });
		const created = await client.callTool({ name: "entity_create", arguments: { kind: "issue", title: "Create through the daemon" } });

		expect(result).toMatchObject({ structuredContent: { entity: { reference: issue.reference, title: "Read through the daemon" } } });
		expect(created).toMatchObject({ structuredContent: { entity: { title: "Create through the daemon" } } });
		expect(spawnCount).toBe(1);

		await client.close();
		await server.close();
		await daemon?.close();
	});

	it("writes authored comment and Plan-entry bodies through the local daemon", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-daemon-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const homeDirectory = path.join(directory, "home");
		const credentialStoreOptions = fakeCredentialStore();
		const { store } = await openSqliteStore(dbPath, { tenant: resolveWellKnownLocalTenantId() });
		const initiative = await store.createEntity({ kind: "initiative", title: "Daemon initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "Daemon Plan", parentId: initiative.id });
		const issue = await store.createEntity({ kind: "issue", title: "Daemon issue" });
		await store.close();

		let daemon: LocalDaemonServerHandle | undefined;
		let spawnCount = 0;
		const server = createLocalMcpServer({
			dbPath,
			homeDirectory,
			credentialStoreOptions,
			spawn: () => {
				spawnCount++;
				daemon = createLocalDaemonServer({ dbPath, homeDirectory, credentialStoreOptions, idleTimeoutMs: 0 });
			}
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const comment = await client.callTool({ name: "comment_create", arguments: { issueId: issue.reference, body: "Authored daemon comment" } });
		const entry = await client.callTool({ name: "plan_entry_create", arguments: { planId: plan.reference, role: "decision", body: "Authored daemon decision" } });

		expect(comment).toMatchObject({ structuredContent: { comment: { issueId: issue.id, body: "Authored daemon comment" } } });
		expect(entry).toMatchObject({ structuredContent: { entry: { planId: plan.id, body: "Authored daemon decision" } } });
		expect(spawnCount).toBe(1);

		await client.close();
		await server.close();
		await daemon?.close();
	});
});