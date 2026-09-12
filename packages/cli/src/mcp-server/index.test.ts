import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalDaemonServer, openSqliteStore, type LocalDaemonServerHandle } from "@agent-issues/api-local";
import { projectProposedPlan, resolveWellKnownLocalTenantId, type RunCredentialCommand } from "@agent-issues/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
		expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
			"issue_breakdown_create",
			"issue_breakdown_show",
			"issue_breakdown_latest",
			"issue_breakdown_preview",
			"issue_breakdown_approve"
		]));

		await client.close();
		await server.close();
		await store.close();
	});

	it("ships a self-contained Issue Preview resource", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.readResource({ uri: "ui://agent-issues/issue-preview.html" });
		const content = result.contents[0];
		const html = content && "text" in content ? content.text : "";
		expect(html).toContain("<issue-preview-app>");
		expect(html).toContain("<script type=\"module\">");
		expect(html).not.toMatch(/<script[^>]+src=/i);
		expect(html).not.toMatch(/<(?:img|link|script)[^>]+https?:\/\//i);

		await client.close();
		await server.close();
		await store.close();
	});

	it("serves the Plan Preview MCP App resource", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const resources = await client.listResources();
		const resource = resources.resources.find(({ uri }) => uri === "ui://agent-issues/plan-preview.html");
		expect(resource).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
		const tools = await client.listTools();
		const previewTool = tools.tools.find(({ name }) => name === "plan_preview");
		expect(previewTool?._meta).toMatchObject({ ui: { resourceUri: "ui://agent-issues/plan-preview.html" } });

		const result = await client.readResource({ uri: "ui://agent-issues/plan-preview.html" });
		expect(result.contents).toEqual([
			expect.objectContaining({ mimeType: "text/html;profile=mcp-app", text: expect.stringContaining("<plan-preview-app") })
		]);

		await client.close();
		await server.close();
		await store.close();
	});

	it("creates an Issue Preview draft through the MCP server", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Issue Preview target" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.callTool({
			name: "issue_breakdown_create",
			arguments: {
				targetId: initiative.reference,
				issues: [{
					key: "child",
					title: "Test Issue Preview draft validation",
					outcome: "The preview can show hierarchy and a dependency.",
					scope: ["Create a child test issue in the draft."],
					workMode: "HITL",
					acceptanceCriteria: ["Issue Preview shows the parent and blocking relation."],
					parentKey: "parent",
					relationReferences: [{ relationType: "blocks", targetKey: "parent" }]
				}, {
					key: "parent",
					title: "Test Issue Preview draft foundation",
					outcome: "The preview can show a parent test issue.",
					scope: ["Create a test-only draft record."],
					workMode: "AFK",
					acceptanceCriteria: ["Issue Preview shows this issue before creation."],
					relationReferences: []
				}]
			}
		});

		expect(result.structuredContent).toMatchObject({
			draft: expect.objectContaining({
				targetReference: initiative.reference,
				snapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				issues: [
					expect.objectContaining({ key: "child", parentKey: "parent" }),
					expect.objectContaining({ key: "parent" })
				]
			})
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("serves the Issue Preview MCP App resource and draft snapshot", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Issue Preview target" });
		const draft = await store.createIssueBreakdownDraft({
			targetId: initiative.id,
			issues: [{
				key: "draft-storage",
				title: "Add draft storage",
				outcome: "Store the proposed graph.",
				scope: ["Add the draft store."],
				workMode: "AFK",
				acceptanceCriteria: ["A draft is retrievable."],
				parentKey: "issue-preview",
				relationReferences: [{ relationType: "blocks", targetKey: "issue-preview" }]
			}]
		});
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const resources = await client.listResources();
		expect(resources.resources).toEqual(expect.arrayContaining([
			expect.objectContaining({ uri: "ui://agent-issues/issue-preview.html", mimeType: "text/html;profile=mcp-app" })
		]));
		const tools = await client.listTools();
		expect(tools.tools.find(({ name }) => name === "issue_breakdown_preview")?._meta).toMatchObject({
			ui: { resourceUri: "ui://agent-issues/issue-preview.html" }
		});
		const result = await client.callTool({ name: "issue_breakdown_preview", arguments: { draftId: draft.id } });

		expect(result).toMatchObject({
			structuredContent: {
				draft: expect.objectContaining({
					id: draft.id,
					targetReference: initiative.reference,
					snapshotDigest: draft.snapshotDigest,
					issues: [expect.objectContaining({ key: "draft-storage", title: "Add draft storage" })]
				})
			}
		});
		const text = Array.isArray(result.content)
			? result.content.find((item): item is { type: "text"; text: string } =>
				typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"
			)?.text ?? ""
			: "";
		expect(text).toContain(initiative.reference);
		expect(text).toContain(draft.snapshotDigest);
		expect(text).toContain("Add draft storage");
		expect(text).toContain("Store the proposed graph.");
		expect(text).toContain("Add the draft store.");
		expect(text).toContain("AFK");
		expect(text).toContain("A draft is retrievable.");
		expect(text).toContain("issue-preview");
		expect(text).toContain("blocks");

		await client.close();
		await server.close();
		await store.close();
	});

	it("approves an Issue Preview draft through the MCP server", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Issue Preview target" });
		const draft = await store.createIssueBreakdownDraft({
			targetId: initiative.id,
			issues: [{
				key: "approval",
				title: "Approve the draft",
				outcome: "The server creates the issue.",
				scope: ["Create the approved issue."],
				workMode: "AFK",
				acceptanceCriteria: ["Approval returns its reference."],
				relationReferences: []
			}]
		});
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.callTool({
			name: "issue_breakdown_approve",
			arguments: { draftId: draft.id, snapshotDigest: draft.snapshotDigest }
		});

		expect(result.structuredContent).toMatchObject({
			status: "approved",
			targetReference: initiative.reference,
			createdIssueReferences: [expect.any(String)]
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("ships a self-contained Plan Preview resource", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.readResource({ uri: "ui://agent-issues/plan-preview.html" });
		const content = result.contents[0];
		const html = content && "text" in content ? content.text : "";
		expect(html).toContain("<plan-preview-app>");
		expect(html).toContain("<script type=\"module\">");
		expect(html).not.toMatch(/<script[^>]+src=/i);
		expect(html).not.toMatch(/<(?:img|link|script)[^>]+https?:\/\//i);

		await client.close();
		await server.close();
		await store.close();
	});

	it("publishes Plan Preview in the CLI package files", () => {
		const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { files: string[] };
		expect(packageJson.files).toContain("dist");
		const previewScript = readFileSync(fileURLToPath(new URL("../../dist/plan-preview.js", import.meta.url)), "utf8");
		expect(previewScript).toContain("plan-preview-app");
		expect(previewScript).toContain("Confirm");
	});

	it("reports the resolved project identity", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store, projectIdentity: "shared-product" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "project_identity", arguments: {} });

		expect(result).toMatchObject({ structuredContent: { projectIdentity: "shared-product" } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("reports a null project identity when no identity is configured", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "project_identity", arguments: {} });

		expect(result).toMatchObject({ structuredContent: { projectIdentity: null } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("resolves project identity from the client chat folder", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const chatFolder = path.join(directory, "chat-folder");
		mkdirSync(path.join(chatFolder, ".git"), { recursive: true });
		writeFileSync(
			path.join(chatFolder, ".git", "config"),
			`[remote "origin"]\n\turl = https://github.com/arcmantle/agent-issues.git\n`
		);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		let seenScope: { projectIdentity?: string; workspaceRoot?: string } | undefined;
		const server = createMcpServer({
			fallbackWorkspaceRoot: path.join(directory, "wrong-home"),
			openStore: async (scope) => {
				seenScope = scope;
				return store;
			}
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" }, { capabilities: { roots: {} } });
		client.setRequestHandler(ListRootsRequestSchema, async () => ({
			roots: [{ uri: pathToFileURL(chatFolder).href }]
		}));

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const identity = await client.callTool({ name: "project_identity", arguments: {} });
		await client.callTool({ name: "entity_create", arguments: { kind: "issue", title: "Scoped to chat folder" } });

		expect(identity).toMatchObject({ structuredContent: { projectIdentity: "agent-issues", workspaceRoot: chatFolder } });
		expect(seenScope).toEqual({ projectIdentity: "agent-issues", workspaceRoot: chatFolder });

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

		expect(result).toMatchObject({ structuredContent: { entity: { kind: "issue", title: "Create through MCP" } } });
		expect((result.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((result.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");

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
		expect((move.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((move.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");
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
		expect((result.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((result.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");
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

	it("excludes every issue with an unfinished blocker from available entity_next_work", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Work initiative" });
		const blocker = await store.createEntity({ kind: "issue", title: "Shared blocker", parentId: initiative.id });
		const firstBlocked = await store.createEntity({ kind: "issue", title: "First blocked", parentId: initiative.id });
		const secondBlocked = await store.createEntity({ kind: "issue", title: "Second blocked", parentId: initiative.id });
		const selected = await store.createEntity({ kind: "issue", title: "Available selection", parentId: initiative.id });
		await store.linkEntities({ fromId: blocker.id, relationType: "blocks", toId: firstBlocked.id });
		await store.linkEntities({ fromId: blocker.id, relationType: "blocks", toId: secondBlocked.id });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "entity_next_work", arguments: { scopeId: selected.reference } });
		const content = result.structuredContent as {
			available: Array<{ issue: { reference: string } }>;
			blocked: Array<{ issue: { reference: string }; blockers: string[] }>;
		};

		expect(content.available.map((item) => item.issue.reference).sort()).toEqual([blocker.reference, selected.reference].sort());
		expect(content.blocked).toEqual(expect.arrayContaining([
			expect.objectContaining({ issue: expect.objectContaining({ reference: firstBlocked.reference }), blockers: [blocker.reference] }),
			expect.objectContaining({ issue: expect.objectContaining({ reference: secondBlocked.reference }), blockers: [blocker.reference] })
		]));

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

	it("reports stale Plan confirmation through plan_confirm", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "MCP Plan", parentId: initiative.id });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Initial decision." });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const preview = await client.callTool({ name: "plan_preview", arguments: { planId: plan.reference } });
		const snapshotDigest = (preview.structuredContent as { plan: { snapshotDigest: string } }).plan.snapshotDigest;
		await store.updatePlanEntry({ entryId: entry.id, body: "Changed decision.", expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
		const result = await client.callTool({ name: "plan_confirm", arguments: { planId: plan.reference, snapshotDigest } });

		expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/snapshot is stale/i) }] });

		await client.close();
		await server.close();
		await store.close();
	});

	it("returns a ready Plan as read-only and confirms its snapshot idempotently", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "Ready MCP Plan", parentId: initiative.id });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "The Plan is ready." });
		const readySnapshot = await store.getEntityDetails(plan.reference);
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await store.confirmPlan({
			planId: plan.id,
			snapshotDigest: projectProposedPlan(readySnapshot.entity, [await store.getPlanEntry({ entryId: entry.id })]).snapshotDigest
		});
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const preview = await client.callTool({ name: "plan_preview", arguments: { planId: plan.reference } });
		const snapshotDigest = (preview.structuredContent as { plan: { snapshotDigest: string } }).plan.snapshotDigest;
		const confirmation = await client.callTool({ name: "plan_confirm", arguments: { planId: plan.reference, snapshotDigest } });

		expect(preview).toMatchObject({ structuredContent: { plan: { reference: plan.reference, status: "ready" } } });
		expect(confirmation).toMatchObject({
			structuredContent: { entity: { reference: plan.reference, status: "ready" }, previousStatus: "ready", confirmed: false }
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("confirms the exact Proposed Plan snapshot through plan_confirm", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "MCP Plan", parentId: initiative.id });
		await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Use the confirmation tool." });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const preview = await client.callTool({ name: "plan_preview", arguments: { planId: plan.reference } });
		const snapshotDigest = (preview.structuredContent as { plan: { snapshotDigest: string } }).plan.snapshotDigest;
		const result = await client.callTool({ name: "plan_confirm", arguments: { planId: plan.reference, snapshotDigest } });

		expect(result).toMatchObject({
			structuredContent: { entity: { reference: plan.reference, status: "ready" }, previousStatus: "in-progress", confirmed: true }
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("returns a Proposed Plan through plan_preview", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({
			kind: "plan",
			title: "MCP Plan",
			body: "## Goal\n\nReview the MCP contract.\n\n## Context\n\nUse a text fallback.",
			parentId: initiative.id
		});
		await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Return structured content." });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "plan_preview", arguments: { planId: plan.reference } });

		expect(result).toMatchObject({
			structuredContent: {
				plan: {
					reference: plan.reference,
					title: "MCP Plan",
					goal: "Review the MCP contract.",
					context: "Use a text fallback.",
					current: [expect.objectContaining({ key: "decisions" })],
					snapshotDigest: expect.any(String)
				}
			}
		});
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("MCP Plan") }]);

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
		expect(created).toMatchObject({ structuredContent: { entry: { referencedEntityIds: [relatedIssue.id] } } });
		expect((created.structuredContent as { entry: object }).entry).not.toHaveProperty("body");
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
		expect(created).toMatchObject({ structuredContent: { comment: { referencedIssueIds: [relatedIssue.id] } } });
		expect((created.structuredContent as { comment: object }).comment).not.toHaveProperty("body");
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
		expect(set).toMatchObject({ structuredContent: { context: { title: "First context revised" } } });
		expect((set.structuredContent as { context: object }).context).not.toHaveProperty("summary");
		expect(define).toMatchObject({ structuredContent: { term: { term: "token" }, created: true } });
		expect((define.structuredContent as { term: object }).term).not.toHaveProperty("definition");
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

		expect(comment).toMatchObject({ structuredContent: { comment: { issueId: issue.id } } });
		expect((comment.structuredContent as { comment: object }).comment).not.toHaveProperty("body");
		expect(entry).toMatchObject({ structuredContent: { entry: { planId: plan.id } } });
		expect((entry.structuredContent as { entry: object }).entry).not.toHaveProperty("body");
		expect(spawnCount).toBe(1);

		await client.close();
		await server.close();
		await daemon?.close();
	});
});