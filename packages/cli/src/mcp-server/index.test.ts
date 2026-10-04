import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalDaemonServer, openSqliteStore, type LocalDaemonServerHandle } from "@agent-issues/api-local";
import { createApiServer, createPgPool, installInstructionBundle, migratePgDatabase } from "@agent-issues/api-pg";
import { LocalAuthProvider, projectProposedPlan, resolveWellKnownLocalTenantId, type RunCredentialCommand } from "@agent-issues/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { auditMcpToolRegistrations } from "./mcp-tool-audit.js";
import { createLocalMcpServer, createMcpServer } from "./index.js";
import { runCli } from "../cli/index.js";
import { saveSavedLogin } from "../auth/auth-session.js";
import { openStorageDriver } from "../runtime/open-storage-driver.js";
import { startLiveSite } from "../site/server.js";
import packageJson from "../../package.json" with { type: "json" };

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

	it("retrieves the same database Markdown and running-release metadata through CLI and MCP", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-interfaces-"));
		directories.push(directory);
		const dbPath = path.join(directory, "instructions.db");
		const credentialStoreOptions = fakeCredentialStore();
		const body = "# Prepare\n\nComplete database instructions.\n";
		const daemon = createLocalDaemonServer({
			dbPath, homeDirectory: directory, credentialStoreOptions,
			instructionBundle: { version: packageJson.version, items: [
				{ key: "skill/prepare", kind: "skill", body: "# Prepare\n\n<!-- include:fragment/rules -->\n" },
				{ key: "fragment/rules", kind: "fragment", body: "Complete <!-- include:fragment/end -->" },
				{ key: "fragment/end", kind: "fragment", body: "database instructions." }
			] }
		});
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "instruction-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } });
			expect(result.isError).not.toBe(true);
			expect(result.content).toEqual([
				{ type: "text", text: expect.any(String) },
				{ type: "text", text: body }
			]);
			expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
				version: packageJson.version, documentHash: expect.stringMatching(/^[a-f0-9]{64}$/), offset: 0, nextOffset: null
			});
			expect(result.structuredContent).toBeUndefined();
			const stdout = new PassThrough();
			let output = "";
			stdout.on("data", (chunk) => { output += chunk.toString(); });
			expect(await runCli(["instruction", "retrieve", "skill/prepare", "--db", dbPath, "--json"], { cwd: directory, stdout })).toBe(0);
			expect(JSON.parse(output)).toMatchObject({
				body, version: packageJson.version, source: { type: "default", revision: 1 },
				fragments: [
					{ key: "fragment/rules", source: { type: "default", revision: 1 } },
					{ key: "fragment/end", source: { type: "default", revision: 1 } }
				]
			});
			output = "";
			expect(await runCli(["instruction", "retrieve", "skill/prepare", "--db", dbPath], { cwd: directory, stdout })).toBe(0);
			expect(output).toBe(body);
			output = "";
			await expect(runCli(["instruction", "retrieve", "skill/missing", "--db", dbPath], { cwd: directory, stdout })).rejects.toThrow("Instruction not found");
			expect(output).toBe("");
			const missing = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/missing" } });
			expect(missing.isError).toBe(true);
			expect(missing.structuredContent).toBeUndefined();
		} finally {
			await client.close();
			await server.close();
			await daemon.close();
		}
	});

	it.each([
		["empty", ""],
		["large Markdown", "# Instructions\n\nRead the complete document.\n".repeat(900)],
		["escaped Unicode", "\u{1F680}\u00e9\u4e2d\n\"\\\t\u0000".repeat(3_000)]
	])("reads complete bounded instruction parts (%s)", async (_name, body) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-parts-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		await store.importInstructionBundle({ version: packageJson.version, items: [
			{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/rules -->" },
			{ key: "fragment/rules", kind: "fragment", body: "<!-- include:fragment/end -->" },
			{ key: "fragment/end", kind: "fragment", body }
		] });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "instruction-parts-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let offset: number | null = 0;
			let documentHash: string | undefined;
			let reconstructed = "";
			let partCount = 0;
			do {
				const argumentsValue = { key: "skill/prepare", ...(offset ? { offset, documentHash } : {}) };
				const result = await client.callTool({ name: "instruction_retrieve", arguments: argumentsValue });
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(8 * 1024);
				const content = result.content as Array<{ type: string; text: string }>;
				expect(content).toHaveLength(2);
				const metadata = JSON.parse(content[0].text) as { version: string; documentHash: string; offset: number; nextOffset: number | null };
				documentHash ??= metadata.documentHash;
				expect(metadata).toMatchObject({ version: packageJson.version, documentHash, offset: reconstructed.length });
				if (metadata.nextOffset !== null) {
					expect(metadata.nextOffset).toBe(reconstructed.length + content[1].text.length);
					expect(content[1].text.length).toBeGreaterThan(0);
					expect(content[1].text).not.toMatch(/[\uD800-\uDBFF]$/);
				}
				if (offset) expect(await client.callTool({ name: "instruction_retrieve", arguments: argumentsValue })).toEqual(result);
				reconstructed += content[1].text;
				offset = metadata.nextOffset;
				expect(++partCount).toBeLessThan(100);
			} while (offset !== null);
			expect(reconstructed).toBe(body);
			if (body.length > 8 * 1024) expect(partCount).toBeGreaterThan(1);
			else expect(partCount).toBe(1);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("rejects invalid offsets, missing hashes, wrong keys, and changed snapshots without partial Markdown", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-offsets-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		const source = "<!-- include:fragment/rules -->";
		const rules = "\u{1F680}" + "Read these instructions.\n".repeat(900);
		await store.importInstructionBundle({ version: packageJson.version, items: [
			{ key: "skill/prepare", kind: "skill", body: source },
			{ key: "skill/other", kind: "skill", body: source },
			{ key: "fragment/rules", kind: "fragment", body: rules }
		] });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "instruction-offsets-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const first = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } });
			const { nextOffset, documentHash } = JSON.parse((first.content as Array<{ text: string }>)[0].text) as { nextOffset: number; documentHash: string };
			expect(nextOffset).toEqual(expect.any(Number));
			for (const argumentsValue of [
				{ key: "skill/prepare", offset: nextOffset },
				{ key: "skill/prepare", offset: 1, documentHash },
				{ key: "skill/prepare", offset: rules.length, documentHash },
				{ key: "skill/prepare", offset: nextOffset, documentHash: "0".repeat(64) },
				{ key: "skill/other", offset: nextOffset, documentHash }
			]) {
				const result = await client.callTool({ name: "instruction_retrieve", arguments: argumentsValue });
				expect(result.isError).toBe(true);
				expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("restart instruction_retrieve without offset and documentHash") }]);
			}
			for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				const invalid = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare", offset, documentHash } });
				expect(invalid.isError).toBe(true);
				expect(invalid.content).toEqual([{ type: "text", text: expect.stringContaining("Input validation error") }]);
			}
			for (const [key, body] of [["skill/prepare", source], ["fragment/rules", rules]]) {
				const before = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } });
				const { nextOffset: offset, documentHash: beforeHash } = JSON.parse((before.content as Array<{ text: string }>)[0].text) as { nextOffset: number; documentHash: string };
				await store.saveInstructionSource({ version: packageJson.version, key, body, expectedRevision: 1 });
				const changed = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare", offset, documentHash: beforeHash } });
				expect(changed.isError).toBe(true);
				expect(changed.content).toEqual([{ type: "text", text: expect.stringContaining("Discard all parts and restart") }]);
				const restarted = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } });
				expect(restarted.isError).not.toBe(true);
			}
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["local", "cloud"])("previews, commits, and compares instructions through site, CLI, and MCP (%s)", async (backend) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-batch-interfaces-"));
		directories.push(directory);
		const dbPath = path.join(directory, "instructions.db");
		const credentialStoreOptions = { ...fakeCredentialStore(), homeDirectory: directory };
		const previousBundle = { version: `reset-all-previous-${randomUUID()}`, items: [{ key: "fragment/same-key", kind: "fragment" as const, body: "Previous default" }] };
		const bundle = { version: packageJson.version, items: [
			{ key: "skill/prepare", kind: "skill" as const, body: "Prepare" },
			{ key: "fragment/rules", kind: "fragment" as const, body: "Rules" }
		] };
		const adminPool = backend === "cloud" ? createPgPool({ connectionString: process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues" }) : undefined;
		const appPool = backend === "cloud" ? createPgPool({ connectionString: process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues" }) : undefined;
		const tenantId = `batch-interface-${randomUUID()}`;
		let cloud: ReturnType<typeof createApiServer> | undefined;
		let installedBundle = false;
		if (adminPool && appPool) {
			await migratePgDatabase(adminPool);
			installedBundle = !(await adminPool.query("SELECT 1 FROM instruction_bundles WHERE version = $1", [bundle.version])).rows.length;
			await installInstructionBundle(adminPool, bundle);
			const authProvider = new LocalAuthProvider({ secret: "test-only-instruction-batch-secret" });
			cloud = createApiServer({ pool: appPool, authProvider, port: 0, authMetadata: { provider: "entra", tenantId, clientId: "test-client" } });
			await new Promise<void>((resolve) => cloud!.server.once("listening", resolve));
			const address = cloud.server.address();
			if (!address || typeof address === "string") throw new Error("Cloud test server has no TCP address.");
			await saveSavedLogin({ name: "test-cloud", kind: "remote", serviceUrl: `http://127.0.0.1:${address.port}`, tenantId, userId: "alice",
				accessToken: await authProvider.issueToken({ tenantId, userId: "alice" }), expiresAt: "2099-01-01T00:00:00.000Z" }, credentialStoreOptions);
		}
		const daemon = backend === "local" ? createLocalDaemonServer({
			dbPath, homeDirectory: directory, credentialStoreOptions,
			instructionBundle: bundle
		}) : undefined;
		if (daemon) await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = backend === "cloud" ? createMcpServer({
			fallbackWorkspaceRoot: directory,
			openStore: async (scope) => (await openStorageDriver({ authSessionOptions: credentialStoreOptions,
				databaseOptions: { currentWorkingDirectory: directory, projectIdentity: scope?.projectIdentity } })).store
		}) : createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "batch-test", version: "1.0.0" });
		const inputPath = path.join(directory, "changes.json");
		let site: Awaited<ReturnType<typeof startLiveSite>> | undefined;
		const stdout = new PassThrough();
		let output = "";
		stdout.on("data", (chunk) => { output += chunk.toString(); });
		async function commit(input: object, exitCode = 0) {
			writeFileSync(inputPath, JSON.stringify(input));
			output = "";
			expect(await runCli(["instruction", "commit", "--input-file", inputPath, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).toBe(exitCode);
			return JSON.parse(output);
		}
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			await client.callTool({ name: "instruction_fragment_create", arguments: { key: "fragment/personal", body: "Personal" } });
			await client.callTool({ name: "instruction_save", arguments: { key: "skill/prepare", body: "<!-- include:fragment/personal -->", expectedRevision: 1 } });
			const beforePreview = (await client.callTool({ name: "instruction_list", arguments: {} })).structuredContent;
			site = await startLiveSite({ dbPath, port: 0, currentWorkingDirectory: directory, credentialStoreOptions });
			await new Promise<void>((resolve) => site!.server.once("listening", resolve));
			const siteAddress = site.server.address();
			if (!siteAddress || typeof siteAddress === "string") throw new Error("Site test server has no TCP address.");
			const previewUrl = `http://127.0.0.1:${siteAddress.port}/api/instructions/preview`;
			for (const changes of [
				[{ key: "skill/prepare", body: "Pending <!-- include:fragment/rules --> Again <!-- include:fragment/rules -->" }],
				[{ key: "skill/prepare", body: "Pending <!-- include:fragment/rules --> Again <!-- include:fragment/rules -->" }, { key: "fragment/rules", body: "New <!-- include:fragment/personal -->" }]
			]) {
				const preview = await client.callTool({ name: "instruction_preview", arguments: { key: "skill/prepare", changes } });
				expect(preview.isError).not.toBe(true);
				expect(preview.structuredContent).toMatchObject({ pending: true, version: packageJson.version,
					pendingKeys: changes.map((change) => change.key).sort(),
					body: changes.length === 1 ? "Pending Rules Again Rules" : "Pending New Personal Again New Personal" });
				writeFileSync(inputPath, JSON.stringify({ changes }));
				output = "";
				expect(await runCli(["instruction", "preview", "skill/prepare", "--input-file", inputPath, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
				expect(JSON.parse(output)).toEqual(preview.structuredContent);
				const response = await fetch(previewUrl, { method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ key: "skill/prepare", changes, version: "ignored-client-version" }) });
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual(preview.structuredContent);
				output = "";
				expect(await runCli(["instruction", "preview", "skill/prepare", "--input-file", inputPath, "--db", dbPath], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
				expect(output).toBe(`Pending\n\n${(preview.structuredContent as { body: string }).body}`);
			}
			const invalidPreview = { changes: [{ key: "skill/prepare", body: "Partial <!-- include:fragment/missing -->" }] };
			const failedPreview = await client.callTool({ name: "instruction_preview", arguments: { key: "skill/prepare", ...invalidPreview } });
			expect(failedPreview.isError).toBe(true);
			expect(failedPreview.structuredContent).toBeUndefined();
			writeFileSync(inputPath, JSON.stringify(invalidPreview));
			output = "";
			await expect(runCli(["instruction", "preview", "skill/prepare", "--input-file", inputPath, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("fragment not found");
			expect(output).toBe("");
			const failedSitePreview = await fetch(previewUrl, { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: "skill/prepare", ...invalidPreview }) });
			expect(failedSitePreview.status).toBe(500);
			expect(await failedSitePreview.text()).toContain("fragment not found");
			expect((await fetch(previewUrl)).status).toBe(405);
			expect((await fetch(previewUrl, { method: "POST", body: "invalid-json" })).status).toBe(400);
			expect((await client.callTool({ name: "instruction_list", arguments: {} })).structuredContent).toEqual(beforePreview);
			const input = { changes: [
				{ operation: "remove", key: "fragment/personal", expectedRevision: 1 },
				{ operation: "save", key: "skill/prepare", body: "<!-- include:fragment/rules -->", expectedRevision: 2 }
			] };
			const saved = await commit(input);
			expect(saved).toMatchObject({ version: packageJson.version, changes: [
				{ operation: "remove", source: { key: "fragment/personal", source: { revision: 2 } } },
				{ operation: "save", source: { key: "skill/prepare", source: { revision: 3 } } }
			] });
			const staleInput = { changes: [
				{ operation: "save", key: "fragment/rules", body: "Changed", expectedRevision: 1 },
				{ operation: "save", key: "skill/prepare", body: "Stale", expectedRevision: 2 }
			] };
			const stale = await client.callTool({ name: "instruction_commit", arguments: staleInput });
			expect(stale.isError).toBe(true);
			expect(stale.structuredContent).toMatchObject({ reason: "revision-conflict", currentSource: { key: "skill/prepare", source: { revision: 3 } } });
			expect(await commit(staleInput, 1)).toEqual(stale.structuredContent);
			const invalidInput = { changes: [
				{ operation: "save", key: "skill/prepare", body: "New", expectedRevision: 3 },
				{ operation: "save", key: "fragment/rules", body: "<!-- include:fragment/missing -->", expectedRevision: 1 }
			] };
			const invalid = await client.callTool({ name: "instruction_commit", arguments: invalidInput });
			expect(invalid.isError).toBe(true);
			expect(await commit(invalidInput, 1)).toEqual(invalid.structuredContent);
			const changesUrl = `http://127.0.0.1:${siteAddress.port}/api/instructions/changes`;
			const frontmatterInput = { changes: [
				{ operation: "save", key: "skill/prepare", body: "---\nname: changed\n---\nNew", expectedRevision: 3 },
				{ operation: "save", key: "fragment/rules", body: "Changed rules", expectedRevision: 1 }
			] };
			for (const changes of [staleInput, invalidInput, frontmatterInput]) {
				const response = await fetch(changesUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) });
				expect(response.status).toBe(400);
				if (changes === frontmatterInput) expect(await response.text()).toContain("frontmatter is read-only");
			}
			expect((await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } })).content).toContainEqual({ type: "text", text: "Rules" });
			const siteCommit = await fetch(changesUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "ignored-client-version", changes: [
				{ operation: "save", key: "skill/prepare", body: "New <!-- include:fragment/rules -->", expectedRevision: 3 },
				{ operation: "save", key: "fragment/rules", body: "rules", expectedRevision: 1 }
			] }) });
			expect(siteCommit.status).toBe(200);
			expect(await siteCommit.json()).toMatchObject({ version: packageJson.version, changes: [
				{ source: { source: { revision: 4 } } }, { source: { source: { revision: 2 } } }
			] });
			expect((await fetch(changesUrl)).status).toBe(405);
			expect((await fetch(changesUrl, { method: "POST", body: "invalid-json" })).status).toBe(400);
			expect((await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } })).content).toContainEqual({ type: "text", text: "New rules" });
			async function historyCli(args: string[], exitCode = 0) {
				output = "";
				expect(await runCli(["instruction", ...args, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).toBe(exitCode);
				return JSON.parse(output);
			}
			const key = "skill/prepare";
			const history = await client.callTool({ name: "instruction_history", arguments: { key } });
			expect(history.isError).not.toBe(true);
			expect(history.structuredContent).toMatchObject({ version: packageJson.version, key, revisions: [
				{ source: { revision: 4 } }, { source: { revision: 3 } }, { source: { revision: 2 } }
			] });
			expect(await historyCli(["history", key])).toEqual(history.structuredContent);
			const revision = await client.callTool({ name: "instruction_revision", arguments: { key, revision: 3 } });
			expect(await historyCli(["revision", key, "--revision", "3"])).toEqual(revision.structuredContent);
			output = "";
			expect(await runCli(["instruction", "revision", key, "--revision", "3", "--db", dbPath], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
			expect(output).toBe("<!-- include:fragment/rules -->");
			const restored = await client.callTool({ name: "instruction_restore", arguments: { key, revision: 3, expectedRevision: 4 } });
			expect(restored.isError).not.toBe(true);
			expect(await historyCli(["read", key])).toEqual(restored.structuredContent);
			const cliRestored = await historyCli(["restore", key, "--revision", "4", "--expected-revision", "5"]);
			expect((await client.callTool({ name: "instruction_read", arguments: { key } })).structuredContent).toEqual(cliRestored);
			for (const [revisionNumber, expectedRevision, reason] of [[3, 5, "revision-conflict"], [2, 6, "invalid-source"]] as const) {
				const failed = await client.callTool({ name: "instruction_restore", arguments: { key, revision: revisionNumber, expectedRevision } });
				expect(failed.isError).toBe(true);
				expect(failed.structuredContent).toMatchObject({ reason, currentSource: cliRestored });
				expect(await historyCli(["restore", key, "--revision", String(revisionNumber), "--expected-revision", String(expectedRevision)], 1)).toEqual(failed.structuredContent);
			}
			expect((await client.callTool({ name: "instruction_retrieve", arguments: { key } })).content).toContainEqual({ type: "text", text: "New rules" });
			const beforeComparison = await historyCli(["history", key]);
			const compared = await client.callTool({ name: "instruction_compare", arguments: { key, version: "ignored-client-version" } });
			expect(compared.isError).not.toBe(true);
			expect(compared.structuredContent).toMatchObject({
				key, version: packageJson.version, currentSource: cliRestored, different: true,
				defaultSource: { version: packageJson.version, body: "Prepare", source: { type: "default", revision: 1 } }
			});
			expect(await historyCli(["compare", key])).toEqual(compared.structuredContent);
			output = "";
			expect(await runCli(["instruction", "compare", key, "--db", dbPath], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
			expect(JSON.parse(output)).toEqual(compared.structuredContent);
			const missingComparison = await client.callTool({ name: "instruction_compare", arguments: { key: "skill/missing" } });
			expect(missingComparison.isError).toBe(true);
			expect(missingComparison.structuredContent).toBeUndefined();
			output = "";
			await expect(runCli(["instruction", "compare", "skill/missing", "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("Instruction not found");
			expect(output).toBe("");
			expect(await historyCli(["read", key])).toEqual(cliRestored);
			expect(await historyCli(["history", key])).toEqual(beforeComparison);
			const dependencies = await client.callTool({ name: "instruction_dependencies", arguments: { key, version: "ignored-client-version" } });
			expect(dependencies.isError).not.toBe(true);
			expect(dependencies.structuredContent).toMatchObject({
				key, version: packageJson.version, source: cliRestored.source,
				dependencies: [{ key: "fragment/rules", direct: true, source: { type: "override", revision: 2 } }],
				affectedInstructions: [], modifiedFragments: ["fragment/rules"]
			});
			expect(await historyCli(["dependencies", key])).toEqual(dependencies.structuredContent);
			output = "";
			expect(await runCli(["instruction", "dependencies", key, "--db", dbPath], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
			expect(JSON.parse(output)).toEqual(dependencies.structuredContent);
			const fragmentImpact = await client.callTool({ name: "instruction_dependencies", arguments: { key: "fragment/rules" } });
			expect(fragmentImpact.structuredContent).toMatchObject({ dependencies: [], affectedInstructions: [key], modifiedFragments: ["fragment/rules"] });
			const missingDependencies = await client.callTool({ name: "instruction_dependencies", arguments: { key: "skill/missing" } });
			expect(missingDependencies.isError).toBe(true);
			expect(missingDependencies.structuredContent).toBeUndefined();
			output = "";
			await expect(runCli(["instruction", "dependencies", "skill/missing", "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("Instruction not found");
			expect(output).toBe("");
			expect(await historyCli(["history", key])).toEqual(beforeComparison);
			const inspected = await client.callTool({ name: "instruction_reset_inspect", arguments: { key } });
			expect(inspected.isError).not.toBe(true);
			const { confirmationToken, expiresAt, ...impact } = inspected.structuredContent as Record<string, unknown>;
			expect(impact).toMatchObject({ currentSource: cliRestored, proposedSource: { body: "Prepare" }, affectedInstructions: [key], modifiedFragments: [] });
			expect(await historyCli(["reset-inspect", key])).toEqual(impact);
			output = "";
			await expect(runCli(["instruction", "reset", key, "--expected-revision", "6", "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("--yes");
			expect(output).toBe("");
			const reset = await client.callTool({ name: "instruction_reset", arguments: { key, expectedRevision: 6, confirmationToken } });
			expect(reset.isError).not.toBe(true);
			expect(reset.structuredContent).toMatchObject({ body: "Prepare", source: { type: "default", revision: 7 } });
			expect(await historyCli(["read", "fragment/rules"])).toMatchObject({ body: "rules", source: { type: "override", revision: 2 } });
			expect(await historyCli(["reset", key, "--expected-revision", "6", "--yes"], 1)).toMatchObject({ reason: "revision-conflict", currentSource: reset.structuredContent });
			const replay = await client.callTool({ name: "instruction_reset", arguments: { key, expectedRevision: 6, confirmationToken } });
			expect(replay.isError).toBe(true);
			const cliReset = await historyCli(["reset", key, "--expected-revision", "7", "--yes"]);
			expect(cliReset).toMatchObject({ body: "Prepare", source: { type: "default", revision: 8 } });
			expect((await client.callTool({ name: "instruction_read", arguments: { key } })).structuredContent).toEqual(cliReset);
			if (adminPool) {
				await installInstructionBundle(adminPool, previousBundle);
				const opened = await openStorageDriver({ authSessionOptions: credentialStoreOptions, databaseOptions: { currentWorkingDirectory: directory } });
				try { await opened.store.saveInstructionSource({ version: previousBundle.version, key: "fragment/same-key", body: "Hidden override", expectedRevision: 1 }); }
				finally { await opened.store.close(); }
			} else {
				const opened = await openSqliteStore(dbPath, { projectIdentity: "reset-all-fixture" });
				try {
					await opened.store.importInstructionBundle(previousBundle);
					await opened.store.saveInstructionSource({ version: previousBundle.version, key: "fragment/same-key", body: "Hidden override", expectedRevision: 1 });
				} finally { await opened.store.close(); }
			}
			await client.callTool({ name: "instruction_fragment_create", arguments: { key: "fragment/same-key", body: "Same-key personal fragment" } });
			await client.callTool({ name: "instruction_fragment_create", arguments: { key: "fragment/reset-all", body: "Personal" } });
			await client.callTool({ name: "instruction_save", arguments: { key, body: "<!-- include:fragment/reset-all -->", expectedRevision: 8 } });
			const allInspection = await client.callTool({ name: "instruction_reset_all_inspect", arguments: {} });
			expect(allInspection.isError).not.toBe(true);
			const { confirmationToken: allToken, expiresAt: allExpiry, ...allImpact } = allInspection.structuredContent as Record<string, unknown>;
			expect(allImpact).toMatchObject({ version: packageJson.version, overrides: [
				{ currentSource: { key: "fragment/rules" } }, { currentSource: { key: "fragment/same-key" }, proposedSource: null }, { currentSource: { key } }
			], personalFragments: [{ key: "fragment/reset-all" }, { key: "fragment/same-key" }], affectedInstructions: [key] });
			expect(await historyCli(["reset-all-inspect"])).toEqual(allImpact);
			const resetAllUrl = previewUrl.replace("/preview", "/reset-all");
			const siteInspection = await fetch(`${resetAllUrl}/inspect`);
			expect(siteInspection.status).toBe(200);
			const { confirmationToken: siteToken, expiresAt: siteExpiry, ...siteImpact } = await siteInspection.json();
			expect(siteImpact).toEqual(allImpact);
			writeFileSync(inputPath, JSON.stringify({ expectedRevisions: allImpact.expectedRevisions }));
			output = "";
			await expect(runCli(["instruction", "reset-all", "--input-file", inputPath, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("--yes");
			expect(output).toBe("");
			const unconfirmedSite = await fetch(resetAllUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevisions: allImpact.expectedRevisions }) });
			expect(unconfirmedSite.status).toBe(400);
			const resetAll = await client.callTool({ name: "instruction_reset_all", arguments: { expectedRevisions: allImpact.expectedRevisions, confirmationToken: allToken } });
			expect(resetAll.isError).not.toBe(true);
			expect(resetAll.structuredContent).toEqual(allImpact);
			expect(await historyCli(["read", key])).toMatchObject({ body: "Prepare", source: { type: "default", revision: 10 } });
			expect(await historyCli(["read", "fragment/rules"])).toMatchObject({ body: "Rules", source: { type: "default", revision: 3 } });
			expect((await client.callTool({ name: "instruction_reset_all", arguments: { expectedRevisions: allImpact.expectedRevisions, confirmationToken: allToken } })).isError).toBe(true);
			const emptyImpact = await historyCli(["reset-all-inspect"]);
			expect(emptyImpact).toMatchObject({ overrides: [], personalFragments: [], expectedRevisions: [] });
			writeFileSync(inputPath, JSON.stringify({ expectedRevisions: [] }));
			expect(await historyCli(["reset-all", "--input-file", inputPath, "--yes"])).toEqual(emptyImpact);
			await client.callTool({ name: "instruction_fragment_create", arguments: { key: "fragment/site-reset", body: "Site" } });
			const freshSiteInspection = await (await fetch(`${resetAllUrl}/inspect`)).json();
			const siteReset = await fetch(resetAllUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevisions: freshSiteInspection.expectedRevisions, confirmationToken: freshSiteInspection.confirmationToken }) });
			expect(siteReset.status).toBe(200);
			expect(await historyCli(["reset-all-inspect"])).toEqual(emptyImpact);
			await client.callTool({ name: "instruction_fragment_create", arguments: { key: "fragment/confirmation", body: "Private" } });
			const staleInspection = (await client.callTool({ name: "instruction_reset_all_inspect", arguments: {} })).structuredContent as Record<string, unknown>;
			await client.callTool({ name: "instruction_save", arguments: { key: "fragment/confirmation", body: "Changed", expectedRevision: 1 } });
			writeFileSync(inputPath, JSON.stringify({ expectedRevisions: staleInspection.expectedRevisions }));
			expect(await historyCli(["reset-all", "--input-file", inputPath, "--yes"], 1)).toMatchObject({ reason: "revision-conflict", currentInspection: { personalFragments: [{ body: "Changed" }] } });
			expect((await client.callTool({ name: "instruction_reset_all", arguments: { expectedRevisions: staleInspection.expectedRevisions, confirmationToken: staleInspection.confirmationToken } })).isError).toBe(true);
			if (cloud) {
				const address = cloud.server.address();
				if (!address || typeof address === "string") throw new Error("Cloud test server has no TCP address.");
				const serviceUrl = `http://127.0.0.1:${address.port}`;
				const authProvider = new LocalAuthProvider({ secret: "test-only-instruction-batch-secret" });
				async function switchOwner(userId: string) {
					await saveSavedLogin({ name: "test-cloud", kind: "remote", serviceUrl, tenantId, userId,
						accessToken: await authProvider.issueToken({ tenantId, userId }), expiresAt: "2099-01-01T00:00:00.000Z" }, credentialStoreOptions);
				}
				const ownerInspection = (await client.callTool({ name: "instruction_reset_all_inspect", arguments: {} })).structuredContent as Record<string, unknown>;
				await switchOwner("bob");
				await client.callTool({ name: "instruction_fragment_create", arguments: { key: "fragment/confirmation", body: "Private" } });
				await client.callTool({ name: "instruction_save", arguments: { key: "fragment/confirmation", body: "Changed", expectedRevision: 1 } });
				expect((await client.callTool({ name: "instruction_reset_all", arguments: { expectedRevisions: ownerInspection.expectedRevisions, confirmationToken: ownerInspection.confirmationToken } })).isError).toBe(true);
				expect(await historyCli(["read", "fragment/confirmation"])).toMatchObject({ body: "Changed", source: { revision: 2 } });
				await switchOwner("alice");
			}
		} finally {
			await client.close();
			await server.close();
			if (site) {
				const closed = new Promise<void>((resolve) => site!.server.once("close", resolve));
				site.close();
				await closed;
			}
			await daemon?.close();
			if (cloud) await new Promise<void>((resolve, reject) => cloud!.server.close((error) => error ? reject(error) : resolve()));
			if (adminPool) {
				await adminPool.query("DELETE FROM instruction_history WHERE tenant_id = $1", [tenantId]);
				await adminPool.query("DELETE FROM instruction_personal_fragments WHERE tenant_id = $1", [tenantId]);
				await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
				await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [previousBundle.version]);
				await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [previousBundle.version]);
				if (installedBundle) {
					await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [bundle.version]);
					await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [bundle.version]);
				}
				await adminPool.end();
			}
			await appPool?.end();
		}
	});

	it("creates and removes the same personal fragments through CLI and MCP", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-fragment-interfaces-"));
		directories.push(directory);
		const dbPath = path.join(directory, "instructions.db");
		const credentialStoreOptions = fakeCredentialStore();
		const daemon = createLocalDaemonServer({
			dbPath, homeDirectory: directory, credentialStoreOptions,
			instructionBundle: { version: packageJson.version, items: [{ key: "skill/prepare", kind: "skill", body: "Prepare" }] }
		});
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "fragment-test", version: "1.0.0" });
		const stdout = new PassThrough();
		let output = "";
		stdout.on("data", (chunk) => { output += chunk.toString(); });
		async function cli(args: string[], exitCode = 0) {
			output = "";
			expect(await runCli(["instruction", ...args, "--db", dbPath, "--json"], { cwd: directory, stdout })).toBe(exitCode);
			return JSON.parse(output);
		}
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const key = "fragment/personal";
			const created = await client.callTool({ name: "instruction_fragment_create", arguments: { key, body: "Personal" } });
			expect(created.isError).not.toBe(true);
			expect(await cli(["read", key])).toEqual(created.structuredContent);
			const duplicate = await client.callTool({ name: "instruction_fragment_create", arguments: { key, body: "Duplicate" } });
			expect(duplicate.isError).toBe(true);
			expect(duplicate.structuredContent).toMatchObject({ reason: "already-exists", currentSource: created.structuredContent });
			const bodyPath = path.join(directory, "body.md");
			writeFileSync(bodyPath, "<!-- include:fragment/personal -->");
			await cli(["save", "skill/prepare", "--body-file", bodyPath, "--expected-revision", "1"]);
			const blocked = await client.callTool({ name: "instruction_fragment_remove", arguments: { key, expectedRevision: 1 } });
			expect(blocked.isError).toBe(true);
			expect(blocked.structuredContent).toMatchObject({ reason: "referenced", affectedReferences: ["skill/prepare"] });
			expect(await cli(["fragment", "remove", key, "--expected-revision", "1"], 1)).toEqual(blocked.structuredContent);
			output = "";
			await expect(runCli(["instruction", "fragment", "remove", key, "--expected-revision", "1", "--db", dbPath], { cwd: directory, stdout })).rejects.toThrow("skill/prepare");
			expect(output).toBe("");
			writeFileSync(bodyPath, "Prepare");
			await cli(["save", "skill/prepare", "--body-file", bodyPath, "--expected-revision", "2"]);
			writeFileSync(bodyPath, "Newer");
			const saved = await cli(["save", key, "--body-file", bodyPath, "--expected-revision", "1"]);
			const stale = await client.callTool({ name: "instruction_fragment_remove", arguments: { key, expectedRevision: 1 } });
			expect(stale.isError).toBe(true);
			expect(stale.structuredContent).toMatchObject({ reason: "revision-conflict", currentSource: saved });
			expect(await cli(["fragment", "remove", key, "--expected-revision", "1"], 1)).toEqual(stale.structuredContent);
			expect(await cli(["fragment", "remove", key, "--expected-revision", "2"])).toMatchObject({ key, source: { revision: 3 } });
			const recreated = await cli(["fragment", "create", key, "--body-file", bodyPath]);
			expect((await client.callTool({ name: "instruction_read", arguments: { key } })).structuredContent).toEqual(recreated);
			const removed = await client.callTool({ name: "instruction_fragment_remove", arguments: { key, expectedRevision: 4 } });
			expect(removed.isError).not.toBe(true);
			expect((await client.callTool({ name: "instruction_read", arguments: { key } })).isError).toBe(true);
			expect(await cli(["list"])).toMatchObject({ items: [{ key: "skill/prepare" }] });
		} finally {
			await client.close();
			await server.close();
			await daemon.close();
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

	it("reads and saves the same instruction source through CLI and MCP with revision errors", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-management-"));
		directories.push(directory);
		const dbPath = path.join(directory, "instructions.db");
		const credentialStoreOptions = fakeCredentialStore();
		const daemon = createLocalDaemonServer({
			dbPath, homeDirectory: directory, credentialStoreOptions,
			instructionBundle: { version: packageJson.version, items: [
				{ key: "agent/agent-issues", kind: "agent", body: "Agent" },
				{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/rules -->" },
				{ key: "fragment/rules", kind: "fragment", body: "Rules" }
			] }
		});
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "instruction-management-test", version: "1.0.0" });
		const stdout = new PassThrough();
		let output = "";
		stdout.on("data", (chunk) => { output += chunk.toString(); });
		async function cli(args: string[]) {
			output = "";
			expect(await runCli(["instruction", ...args, "--db", dbPath, "--json"], { cwd: directory, stdout })).toBe(0);
			return JSON.parse(output);
		}
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const listed = await client.callTool({ name: "instruction_list", arguments: {} });
			expect(listed.isError).not.toBe(true);
			expect(await cli(["list"])).toEqual(listed.structuredContent);
			for (const key of ["agent/agent-issues", "skill/prepare", "fragment/rules"]) {
				const read = await client.callTool({ name: "instruction_read", arguments: { key } });
				expect(await cli(["read", key])).toEqual(read.structuredContent);
				const saved = await client.callTool({ name: "instruction_save", arguments: { key, body: "From MCP", expectedRevision: 1 } });
				expect(saved.isError).not.toBe(true);
				expect(await cli(["read", key])).toEqual(saved.structuredContent);
				const bodyPath = path.join(directory, "body.md");
				writeFileSync(bodyPath, "From CLI\n");
				const cliSaved = await cli(["save", key, "--body-file", bodyPath, "--expected-revision", "2"]);
				const current = await client.callTool({ name: "instruction_read", arguments: { key } });
				expect(current.structuredContent).toEqual(cliSaved);
				const stale = await client.callTool({ name: "instruction_save", arguments: { key, body: "Stale", expectedRevision: 2 } });
				expect(stale.isError).toBe(true);
				expect(JSON.stringify(stale.content)).toContain("revision conflict");
				expect(stale.structuredContent).toMatchObject({ reason: "revision-conflict", currentSource: cliSaved });
				output = "";
				expect(await runCli(["instruction", "save", key, "--body-file", bodyPath, "--expected-revision", "2", "--db", dbPath, "--json"], { cwd: directory, stdout })).toBe(1);
				expect(JSON.parse(output)).toMatchObject({ reason: "revision-conflict", currentSource: cliSaved });
				output = "";
				await expect(runCli(["instruction", "save", key, "--body-file", bodyPath, "--expected-revision", "2", "--db", dbPath], { cwd: directory, stdout })).rejects.toThrow("revision conflict");
				expect(output).toBe("");
				const invalid = await client.callTool({ name: "instruction_save", arguments: { key, body: "<!-- include:fragment/missing -->", expectedRevision: 3 } });
				expect(invalid.isError).toBe(true);
				expect(invalid.structuredContent).toMatchObject({ reason: "invalid-source", currentSource: cliSaved });
				expect((await client.callTool({ name: "instruction_read", arguments: { key } })).structuredContent).toEqual(cliSaved);
				writeFileSync(bodyPath, "<!-- include:fragment/missing -->");
				output = "";
				await expect(runCli(["instruction", "save", key, "--body-file", bodyPath, "--expected-revision", "3", "--db", dbPath], { cwd: directory, stdout })).rejects.toThrow(/fragment not found[\s\S]*revision 3/);
				expect(output).toBe("");
				writeFileSync(bodyPath, "");
				expect(await cli(["save", key, "--body-file", bodyPath, "--expected-revision", "3"])).toMatchObject({ body: "", source: { revision: 4 } });
				expect((await client.callTool({ name: "instruction_read", arguments: { key } })).structuredContent).toMatchObject({ body: "", source: { revision: 4 } });
			}
		} finally {
			await client.close();
			await server.close();
			await daemon.close();
		}
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
		const confirmationTool = tools.tools.find(({ name }) => name === "plan_confirm");
		expect(confirmationTool?._meta).toBeUndefined();

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
					planEntryIds: ["PLAN_ENTRY_123"],
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
					expect.objectContaining({ key: "child", parentKey: "parent", planEntryIds: ["PLAN_ENTRY_123"] }),
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
				planEntryIds: ["PLAN_ENTRY_123"],
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
		expect(text).toContain("Plan entries");
		expect(text).toContain("PLAN_ENTRY_123");
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
		expect(previewScript).toContain("Plan ready");
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

	it("records a workspace observation when the MCP status tool completes an issue", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Observed completion" });
		const server = createMcpServer({ fallbackWorkspaceRoot: directory, openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			await client.callTool({ name: "entity_status", arguments: { entityId: issue.id, status: "done" } });
			expect((await store.getEntityDetails(issue.id)).completionObservations).toEqual([
				expect.objectContaining({
					completionOrdinal: 1,
					calculatedVersionState: "unknown",
					diagnostics: [{ code: "workspace-observation-failed", message: expect.any(String) }]
				})
			]);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
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
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const text = content[0];
		expect(content).toEqual([{ type: "text", text: expect.stringContaining("MCP Plan") }]);
		expect(text && "text" in text ? text.text : "").toContain((result.structuredContent as { plan: { snapshotDigest: string } }).plan.snapshotDigest);

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
		const prd = await store.createEntity({ kind: "prd", title: "Plan product requirement" });
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
		const linked = await client.callTool({ name: "plan_entry_entity_link", arguments: { entryId: updatedEntry.reference, targetId: prd.reference } });
		const linkedEntry = await store.getPlanEntry({ entryId: updatedEntry.reference });
		const unlinked = await client.callTool({ name: "plan_entry_entity_unlink", arguments: { entryId: updatedEntry.reference, targetId: prd.reference } });
		const unlinkedEntry = await store.getPlanEntry({ entryId: updatedEntry.reference });
		const deleted = await client.callTool({
			name: "plan_entry_delete",
			arguments: { entryId: updatedEntry.reference, expectedRevision: unlinkedEntry.revision, expectedContentHash: unlinkedEntry.contentHash }
		});

		expect(list).toMatchObject({ structuredContent: { entries: [expect.objectContaining({ reference: entry.reference, body: "What must the tool return?" })] } });
		expect(edited).toMatchObject({ structuredContent: { entry: { reference: entry.reference, body: "The tool returns structured data.", revision: 2 } } });
		expect(history).toMatchObject({ structuredContent: { history: expect.arrayContaining([expect.objectContaining({ entryId: expect.any(String), targetRevision: 1, body: "What must the tool return?" })]) } });
		expect(linked).toMatchObject({ structuredContent: { created: true } });
		expect(linkedEntry.referencedEntityIds).toContain(prd.id);
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