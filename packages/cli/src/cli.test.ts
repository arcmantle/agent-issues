import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { isEntrypointInvocation, runCli, shouldRunLocalDaemon } from "./cli.js";
import { main } from "./cli/index.js";
import { createEntity, ensureDatabase, getDatabaseSnapshot, getEntityDetails, getProjectDiscovery, listEntities, listTenants, materializeEntityRevision, openSqliteStore } from "@agent-issues/api-local";
import { LOCAL_DAEMON_SPAWN_FLAG } from "./daemon/local-daemon-store.js";
import { startLiveSite } from "./site/index.js";

let tempDir: string | null = null;
const liveSiteClosers = new Set<() => void>();

function createTempDir(): string {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-cli-"));
	const workspace = path.join(tempDir, "default-project");
	mkdirSync(workspace);
	return workspace;
}

function createCapture() {
	const stream = new PassThrough();
	let text = "";

	stream.on("data", (chunk) => {
		text += chunk.toString();
	});

	return {
		stream,
		read: () => text
	};
}

// Opens a real SSE connection and resolves once a `snapshot-changed` event
// arrives (mirrors `cloud-site-server.test.ts`'s helper of the same name).
function waitForSnapshotChangedEvent(url: string): { event: Promise<unknown>; stop: () => void } {
	let resolveEvent: (value: unknown) => void;
	const promise = new Promise<unknown>((resolve) => {
		resolveEvent = resolve;
	});

	const controller = new AbortController();
	void (async () => {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.body) return;
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const rawEvent = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
					if (dataLine) {
						const parsed = JSON.parse(dataLine.slice("data:".length).trim());
						if (parsed.type === "snapshot-changed") {
							resolveEvent(parsed);
						}
					}
					boundary = buffer.indexOf("\n\n");
				}
			}
		} catch {
			// aborted
		}
	})();

	return { event: promise, stop: () => controller.abort() };
}

afterEach(() => {
	for (const close of liveSiteClosers) {
		close();
	}
	liveSiteClosers.clear();

	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

async function getAvailablePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Could not determine an available port.")));
				return;
			}

			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve(address.port);
			});
		});
	});
}

describe("cli", () => {
	it("prints help when invoked without a command", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli([], { stderr: stderr.stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("agent-issues help");
	});

	it("routes command help through the existing help renderer", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["create", "--help"], { stderr: stderr.stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("agent-issues create <kind>");
	});

	it("resolves help for a multi-word command like 'auth login' by its full name, not just its first word", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["help", "auth", "login", "--json"], { stderr: stderr.stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		const payload = JSON.parse(stdout.read());
		expect(payload.command.name).toBe("auth login");
	});

	it("routes '--help' appended to a multi-word command through the help renderer", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "login", "--help"], { stderr: stderr.stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("agent-issues auth login --tenant-id");
	});

	it("documents generic handoff creation and title or body edits in help", async () => {
		const createStdout = createCapture();
		const createExitCode = await runCli(["help", "create", "--json"], { stdout: createStdout.stream, stderr: createCapture().stream });

		expect(createExitCode).toBe(0);
		expect(JSON.parse(createStdout.read()).command.examples).toContain(
			'agent-issues create handoff --title "Resume export work" --body-file - --link handsOff ISS1'
		);

		const editStdout = createCapture();
		const editExitCode = await runCli(["help", "edit", "--json"], { stdout: editStdout.stream, stderr: createCapture().stream });

		expect(editExitCode).toBe(0);
		expect(JSON.parse(editStdout.read()).command.usage).toContain(
			"agent-issues edit <id> [--title <title>] [--body <markdown> | --body-file <path|->] [--view <compact|full>]"
		);
	});

	it.each(["list", "relations", "show", "bundle"])("documents compact and full JSON views for %s", async (command) => {
		const stdout = createCapture();

		const exitCode = await runCli(["help", command, "--json"], {
			stderr: createCapture().stream,
			stdout: stdout.stream
		});
		const help = JSON.parse(stdout.read()).command;

		expect(exitCode).toBe(0);
		expect(help.options).toContainEqual({
			allowedValues: ["compact", "full"],
			description: "Select compact or full JSON output. Compact is the default; use full for authored content and complete records. Human-readable output is unchanged.",
			name: "--view <compact|full>"
		});
	});

	it("documents bounded list and relation filters", async () => {
		const listStdout = createCapture();
		const relationsStdout = createCapture();

		await runCli(["help", "list", "--json"], { stderr: createCapture().stream, stdout: listStdout.stream });
		await runCli(["help", "relations", "--json"], { stderr: createCapture().stream, stdout: relationsStdout.stream });
		const listHelp = JSON.parse(listStdout.read()).command;
		const relationsHelp = JSON.parse(relationsStdout.read()).command;

		expect(listHelp.options.map((option: { name: string }) => option.name)).toEqual([
			"--status <comma-separated statuses>",
			"--parent <id>",
			"--limit <count>",
			"--view <compact|full>"
		]);
		expect(relationsHelp.options.map((option: { name: string }) => option.name)).toEqual([
			"--direction <incoming|outgoing|both>",
			"--type <comma-separated types>",
			"--view <compact|full>"
		]);
		expect(listHelp.examples).toContain("agent-issues list issue --status todo,in-progress --parent <initiativeId> --limit 20 --json");
		expect(relationsHelp.examples).toContain("agent-issues relations <id> --direction incoming --type blocks,decomposes --json");
		expect(listHelp.notes).toContain("Accepted status values depend on the entity kind; use agent-issues schema --json to inspect each kind's workflow.");
	});

	it("rejects read-only context acknowledgement views before opening the store", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-context-view.db");

		await expect(runCli(
			["context", "show", "--view", "compact", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow("--view compact is only valid for context set, define, and forget.");
		expect(existsSync(dbPath)).toBe(false);
	});

	it("documents compact and full mutation acknowledgements", async () => {
		for (const command of ["create", "edit", "archive", "delete", "move", "status", "link", "unlink"]) {
			const stdout = createCapture();
			await runCli(["help", command, "--json"], { stderr: createCapture().stream, stdout: stdout.stream });
			const help = JSON.parse(stdout.read()).command;
			expect(help.options).toContainEqual({
				allowedValues: ["compact", "full"],
				description: "Select compact or full JSON output. Compact is the default; use full for authored content and complete records. Human-readable output is unchanged.",
				name: "--view <compact|full>"
			});
		}

		const contextStdout = createCapture();
		await runCli(["help", "context", "--json"], { stderr: createCapture().stream, stdout: contextStdout.stream });
		expect(JSON.parse(contextStdout.read()).command.options).toContainEqual(expect.objectContaining({
			name: "--view <all|global|initiatives|compact|full>"
		}));
	});

	it("prints compact json by default and pretty json when requested", async () => {
		const compactStdout = createCapture();
		const compactStderr = createCapture();

		const compactExitCode = await runCli(["help", "create", "--json"], {
			stderr: compactStderr.stream,
			stdout: compactStdout.stream
		});

		expect(compactExitCode).toBe(0);
		expect(compactStderr.read()).toBe("");
		expect(JSON.parse(compactStdout.read())).toBeTruthy();
		expect(compactStdout.read().trim().split("\n")).toHaveLength(1);

		const prettyStdout = createCapture();
		const prettyStderr = createCapture();

		const prettyExitCode = await runCli(["help", "create", "--json", "--pretty"], {
			stderr: prettyStderr.stream,
			stdout: prettyStdout.stream
		});

		expect(prettyExitCode).toBe(0);
		expect(prettyStderr.read()).toBe("");
		expect(JSON.parse(prettyStdout.read())).toBeTruthy();
		expect(prettyStdout.read().trim().split("\n").length).toBeGreaterThan(1);
	});

	it("prints compact json errors by default and pretty json errors when requested", async () => {
		const originalWrite = process.stderr.write.bind(process.stderr);
		const chunks: string[] = [];

		process.stderr.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;

		try {
			const compactExitCode = await main(["show", "--json"]);

			expect(compactExitCode).toBe(1);
			expect(JSON.parse(chunks.join(""))).toHaveProperty("error");
			expect(chunks.join("").trim().split("\n")).toHaveLength(1);

			chunks.length = 0;

			const prettyExitCode = await main(["show", "--json", "--pretty"]);

			expect(prettyExitCode).toBe(1);
			expect(JSON.parse(chunks.join(""))).toHaveProperty("error");
			expect(chunks.join("").trim().split("\n").length).toBeGreaterThan(1);
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	it("treats a symlinked argv path as a direct invocation", async () => {
		const root = createTempDir();
		const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
		const linkedPath = path.join(root, "agent-issues");

		symlinkSync(cliPath, linkedPath);

		expect(isEntrypointInvocation(pathToFileURL(cliPath).href, linkedPath)).toBe(true);
	});

	it("recognizes the hidden daemon-spawn flag as the first argument (ISS190)", () => {
		expect(shouldRunLocalDaemon([LOCAL_DAEMON_SPAWN_FLAG])).toBe(true);
	});

	it("does not treat an ordinary command as the daemon-spawn flag", () => {
		expect(shouldRunLocalDaemon(["list", "initiative"])).toBe(false);
		expect(shouldRunLocalDaemon([])).toBe(false);
	});

	it("creates entities through clipanion-parsed options", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(
			["create", "initiative", "--title", "Ship clipanion", "--db", dbPath],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("initiative");

		const { db, executor } = await ensureDatabase(dbPath);
		try {
			const initiatives = listEntities(executor, "initiative");
			expect(initiatives).toHaveLength(1);
			expect(initiatives[0]?.title).toBe("Ship clipanion");
		} finally {
			db.close();
		}
	});

	it("returns compact create and edit acknowledgements without authored bodies", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createBody = "Create body that must not be echoed. ".repeat(200);
		const editBody = "Edit body that must not be echoed. ".repeat(200);
		const createStdout = createCapture();

		await runCli([
			"create", "issue",
			"--title", "Compact mutation",
			"--body", createBody,
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: createStdout.stream });
		const created = JSON.parse(createStdout.read()) as { reference: string; revision: number };

		expect(created).toEqual({
			operation: "create",
			reference: expect.stringMatching(/^ISS_/),
			status: "todo",
			revision: 1
		});
		expect(createStdout.read()).not.toContain(createBody);

		const editStdout = createCapture();
		await runCli([
			"edit", created.reference,
			"--body", editBody,
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: editStdout.stream });

		expect(JSON.parse(editStdout.read())).toEqual({
			operation: "edit",
			reference: created.reference,
			revision: 2
		});
		expect(editStdout.read()).not.toContain(editBody);

		const fullStdout = createCapture();
		await runCli([
			"edit", created.reference,
			"--title", "Full mutation",
			"--view", "full",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: fullStdout.stream });
		expect(JSON.parse(fullStdout.read())).toEqual(expect.objectContaining({
			body: editBody,
			contentHash: expect.any(String),
			reference: created.reference,
			revision: 3
		}));
	});

	it("returns compact lifecycle acknowledgements while preserving human output", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (kind: string, title: string, parent?: string) => {
			const stdout = createCapture();
			await runCli([
				"create", kind, "--title", title,
				...(parent ? ["--parent", parent] : []),
				"--view", "full", "--db", dbPath, "--json"
			], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const firstParent = await createJson("initiative", "First parent");
		const secondParent = await createJson("initiative", "Second parent");
		const issue = await createJson("issue", "Lifecycle issue", firstParent.id);
		const statusStdout = createCapture();
		await runCli(["status", issue.reference, "in-progress", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: statusStdout.stream });
		expect(JSON.parse(statusStdout.read())).toEqual({
			operation: "status",
			reference: issue.reference,
			previousStatus: "todo",
			status: "in-progress",
			revision: 2
		});

		const moveStdout = createCapture();
		await runCli(["move", issue.reference, secondParent.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: moveStdout.stream });
		expect(JSON.parse(moveStdout.read())).toEqual(expect.objectContaining({
			operation: "move",
			reference: issue.reference,
			newParentId: secondParent.id,
			type: "tracks",
			revision: 3
		}));

		const archiveStdout = createCapture();
		await runCli(["archive", issue.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: archiveStdout.stream });
		expect(JSON.parse(archiveStdout.read())).toEqual({
			operation: "archive",
			reference: issue.reference,
			previousStatus: "in-progress",
			status: "done",
			revision: 4
		});

		const statusNoopStdout = createCapture();
		await runCli(["status", issue.reference, "done", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: statusNoopStdout.stream });
		expect(JSON.parse(statusNoopStdout.read())).toEqual(expect.objectContaining({
			operation: "status",
			reference: issue.reference,
			previousStatus: "done",
			status: "done"
		}));

		const humanStdout = createCapture();
		await runCli(["status", issue.reference, "done", "--view", "compact", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: humanStdout.stream });
		expect(humanStdout.read()).toContain(`Updated ${issue.id} from done to done`);

		const deleteStdout = createCapture();
		await runCli(["delete", issue.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: deleteStdout.stream });
		expect(JSON.parse(deleteStdout.read())).toEqual({ operation: "delete", reference: issue.reference, removed: true });
	});

	it("returns compact relation acknowledgements for successful and no-op writes", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (title: string) => {
			const stdout = createCapture();
			await runCli(["create", "issue", "--title", title, "--view", "full", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const source = await createJson("Source");
		const target = await createJson("Target");
		const runRelation = async (command: "link" | "unlink") => {
			const stdout = createCapture();
			await runCli([command, source.reference, "blocks", target.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read());
		};

		expect(await runRelation("link")).toEqual({ operation: "link", fromId: source.id, toId: target.id, type: "blocks", created: true });
		expect(await runRelation("link")).toEqual({ operation: "link", fromId: source.id, toId: target.id, type: "blocks", created: false });
		expect(await runRelation("unlink")).toEqual({ operation: "unlink", fromId: source.id, toId: target.id, type: "blocks", removed: true });
	});

	it("returns compact context write and restore acknowledgements without authored content", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const summary = "Context summary that must not be echoed. ".repeat(100);
		const definition = "Term definition that must not be echoed. ".repeat(100);
		const runJson = async (args: string[]) => {
			const stdout = createCapture();
			await runCli([...args, "--view", "compact", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return { output: stdout.read(), value: JSON.parse(stdout.read()) };
		};

		const set = await runJson(["context", "set", "--title", "Compact context", "--summary", summary]);
		expect(set.value).toEqual({ operation: "context-set", reference: expect.stringMatching(/^CTX_/), revision: 1 });
		expect(set.output).not.toContain(summary);

		const define = await runJson(["context", "define", "Order", "--definition", definition]);
		expect(define.value).toEqual(expect.objectContaining({ operation: "context-define", contextReference: set.value.reference, term: "Order", created: true, revision: 1 }));
		expect(define.output).not.toContain(definition);

		const redefine = await runJson(["context", "define", "Order", "--definition", "Updated definition"]);
		expect(redefine.value).toEqual(expect.objectContaining({ operation: "context-define", term: "Order", created: false, revision: 2 }));

		const forget = await runJson(["context", "forget", "Order"]);
		expect(forget.value).toEqual(expect.objectContaining({ operation: "context-forget", reference: set.value.reference, term: "Order", removed: true }));
		const forgetNoop = await runJson(["context", "forget", "Order"]);
		expect(forgetNoop.value).toEqual(expect.objectContaining({ operation: "context-forget", reference: set.value.reference, term: "Order", removed: false }));

		const contextRestore = await runJson(["restore", "--context", "default", "--revision", "1"]);
		expect(contextRestore.value).toEqual({ operation: "context-restore", contextKey: "default", revision: 2, restoredFromRevision: 1 });
		const termRestore = await runJson(["restore", "--context", "default", "--term", "Order", "--revision", "1"]);
		expect(termRestore.value).toEqual(expect.objectContaining({ operation: "context-term-restore", contextKey: "default", term: "Order", restoredFromRevision: 1 }));

		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const entity = await store.createEntity({ kind: "issue", title: "Original", body: "Original body" });
		await store.updateEntity({
			entityId: entity.id,
			title: "Edited",
			expectedRevision: entity.revision,
			expectedContentHash: entity.contentHash
		});
		await store.close();
		const entityRestore = await runJson(["restore", entity.reference, "--revision", "1"]);
		expect(entityRestore.value).toEqual({
			operation: "restore",
			id: entity.id,
			revision: 3,
			restoredFromRevision: 1
		});
	});

	it.each([
		["create", "issue", "--title", "Invalid view"],
		["edit", "missing", "--title", "Invalid view"],
		["archive", "missing"],
		["delete", "missing"],
		["move", "missing", "parent"],
		["status", "missing", "done"],
		["link", "from", "blocks", "to"],
		["unlink", "from", "blocks", "to"],
		["restore", "missing", "--revision", "1"],
		["context", "set", "--title", "Invalid", "--summary", "Invalid"],
		["context", "define", "Term", "--definition", "Invalid"],
		["context", "forget", "Term"]
	])("rejects an invalid mutation view before opening the store", async (...command) => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-mutation-view.db");

		await expect(runCli(
			[...command, "--view", "summary", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow("Unknown entity view: summary");
		expect(existsSync(dbPath)).toBe(false);
	});

	it("lists populated compact JSON as items and total", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createStdout = createCapture();

		const createExitCode = await runCli(
			["create", "issue", "--title", "Compact list issue", "--view", "full", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createStdout.stream }
		);
		const created = JSON.parse(createStdout.read()) as { id: string };
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(
			["list", "issue", "--db", dbPath, "--json", "--view", "compact"],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(createExitCode).toBe(0);
		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(JSON.parse(stdout.read())).toEqual({
			items: [{
				id: created.id,
				kind: "issue",
				status: "todo",
				title: "Compact list issue"
			}],
			total: 1
		});
	});

	it("lists empty compact JSON as empty items and zero total", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(
			["list", "issue", "--db", dbPath, "--json", "--view", "compact"],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(JSON.parse(stdout.read())).toEqual({ items: [], total: 0 });
	});

	it("combines list filters and preserves the filtered total when results are limited", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (args: string[]): Promise<{ id: string; reference: string }> => {
			const stdout = createCapture();
			await runCli([...args, "--view", "full", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: stdout.stream
			});
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const selectedParent = await createJson(["create", "initiative", "--title", "Selected parent"]);
		const otherParent = await createJson(["create", "initiative", "--title", "Other parent"]);
		await createJson(["create", "issue", "--title", "Selected todo", "--parent", selectedParent.id]);
		await createJson(["create", "issue", "--title", "Selected active", "--parent", selectedParent.id, "--status", "in-progress"]);
		await createJson(["create", "issue", "--title", "Other todo", "--parent", otherParent.id]);
		const stdout = createCapture();

		const exitCode = await runCli([
			"list", "issue",
			"--status", "todo,in-progress",
			"--parent", selectedParent.reference,
			"--limit", "1",
			"--view", "compact",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout.read()) as { items: Array<{ title: string }>; total: number };
		expect(result.items).toHaveLength(1);
		expect(["Selected todo", "Selected active"]).toContain(result.items[0]?.title);
		expect(result.total).toBe(2);

		const emptyStdout = createCapture();
		await runCli([
			"list", "issue",
			"--parent", otherParent.reference,
			"--status", "in-progress",
			"--view", "compact",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: emptyStdout.stream });
		expect(JSON.parse(emptyStdout.read())).toEqual({ items: [], total: 0 });
	});

	it("returns compact list JSON by default and preserves explicit full view", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		await runCli(
			["create", "issue", "--title", "Full list issue", "--body", "Full body", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		);
		const defaultStdout = createCapture();
		const fullStdout = createCapture();

		const defaultExitCode = await runCli(
			["list", "issue", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: defaultStdout.stream }
		);
		const fullExitCode = await runCli(
			["list", "issue", "--db", dbPath, "--json", "--view", "full"],
			{ cwd: root, stderr: createCapture().stream, stdout: fullStdout.stream }
		);

		expect(defaultExitCode).toBe(0);
		expect(fullExitCode).toBe(0);
		expect(JSON.parse(defaultStdout.read())).toEqual({
			items: [expect.objectContaining({ kind: "issue", status: "todo", title: "Full list issue" })],
			total: 1
		});
		expect(JSON.parse(fullStdout.read())).toEqual([
			expect.objectContaining({ body: "Full body", contentHash: expect.any(String), revision: 1 })
		]);
	});

	it("rejects an invalid list view before opening the store", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-view.db");

		await expect(runCli(
			["list", "issue", "--db", dbPath, "--json", "--view", "summary"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow("Unknown entity view: summary");
		expect(existsSync(dbPath)).toBe(false);
	});

	it.each(["relations", "show", "bundle"])("rejects an invalid %s view before opening the store", async (command) => {
		const root = createTempDir();
		const dbPath = path.join(root, `${command}-invalid-view.db`);

		await expect(runCli(
			[command, "missing-entity", "--db", dbPath, "--json", "--view", "summary"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow("Unknown entity view: summary");
		expect(existsSync(dbPath)).toBe(false);
	});

	it("renders compact relations with mixed incoming and outgoing edges", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (kind: string, title: string): Promise<{ id: string }> => {
			const stdout = createCapture();
			await runCli(
				["create", kind, "--title", title, "--view", "full", "--db", dbPath, "--json"],
				{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
			);
			return JSON.parse(stdout.read()) as { id: string };
		};
		const blocker = await createJson("issue", "Blocking issue");
		const issue = await createJson("issue", "Focused issue");
		const story = await createJson("userStory", "Fixed story");
		await runCli(["link", blocker.id, "blocks", issue.id, "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		await runCli(["link", issue.id, "fixes", story.id, "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		const stdout = createCapture();

		const exitCode = await runCli(
			["relations", issue.id, "--db", dbPath, "--json", "--view", "compact"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.read())).toEqual({
			entity: { id: issue.id, kind: "issue", status: "todo", title: "Focused issue" },
			incoming: [{ type: "blocks", entity: { id: blocker.id, kind: "issue", status: "todo", title: "Blocking issue" } }],
			outgoing: [{ type: "fixes", entity: { id: story.id, kind: "userStory", status: "ready", title: "Fixed story" } }]
		});
	});

	it("filters relations by direction and comma-separated types", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (kind: string, title: string): Promise<{ id: string }> => {
			const stdout = createCapture();
			await runCli(["create", kind, "--title", title, "--view", "full", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: stdout.stream
			});
			return JSON.parse(stdout.read()) as { id: string };
		};
		const blocker = await createJson("issue", "Blocking issue");
		const issue = await createJson("issue", "Focused issue");
		const story = await createJson("userStory", "Fixed story");
		await runCli(["link", blocker.id, "blocks", issue.id, "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		await runCli(["link", issue.id, "fixes", story.id, "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		const outgoingStdout = createCapture();
		const emptyStdout = createCapture();

		await runCli([
			"relations", issue.id,
			"--direction", "outgoing",
			"--type", "fixes,blocks",
			"--view", "compact",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: outgoingStdout.stream });
		await runCli([
			"relations", issue.id,
			"--direction", "incoming",
			"--type", "fixes",
			"--view", "compact",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: emptyStdout.stream });

		expect(JSON.parse(outgoingStdout.read())).toEqual({
			entity: { id: issue.id, kind: "issue", status: "todo", title: "Focused issue" },
			incoming: [],
			outgoing: [{ type: "fixes", entity: { id: story.id, kind: "userStory", status: "ready", title: "Fixed story" } }]
		});
		expect(JSON.parse(emptyStdout.read())).toEqual({
			entity: { id: issue.id, kind: "issue", status: "todo", title: "Focused issue" },
			incoming: [],
			outgoing: []
		});
	});

	it.each([
		{ command: ["list", "issue", "--status", "unknown"], message: "Invalid issue status: unknown" },
		{ command: ["list", "issue", "--limit", "0"], message: "--limit must be a positive integer: 0" },
		{ command: ["relations", "missing", "--direction", "sideways"], message: "Unknown relation direction: sideways" },
		{ command: ["relations", "missing", "--type", "unknown"], message: "Unknown relation type: unknown" }
	])("rejects invalid entity filter values before opening the store", async ({ command, message }) => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-filter.db");

		await expect(runCli(
			[...command, "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow(message);
		expect(existsSync(dbPath)).toBe(false);
	});

	it("renders a compact non-initiative show as compact details", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createStdout = createCapture();
		await runCli(
			["create", "issue", "--title", "Ordinary compact show", "--body", "Hidden body", "--view", "full", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createStdout.stream }
		);
		const issue = JSON.parse(createStdout.read()) as { id: string };
		const stdout = createCapture();

		const exitCode = await runCli(
			["show", issue.id, "--db", dbPath, "--json", "--view", "compact"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.read())).toEqual({
			entity: { id: issue.id, kind: "issue", status: "todo", title: "Ordinary compact show" },
			incoming: [],
			outgoing: []
		});
	});

	it("renders a compact initiative show as a compact bundle", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createStdout = createCapture();
		await runCli(
			["create", "initiative", "--title", "Initiative compact show", "--body", "Hidden initiative body", "--view", "full", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createStdout.stream }
		);
		const initiative = JSON.parse(createStdout.read()) as { id: string };
		const stdout = createCapture();

		const exitCode = await runCli(
			["show", initiative.id, "--db", dbPath, "--json", "--view", "compact"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);
		const payload = JSON.parse(stdout.read());

		expect(exitCode).toBe(0);
		expect(Object.keys(payload)).toEqual([
			"initiative", "entities", "prds", "userStories", "adrs", "issues",
			"fixLinks", "subIssueLinks", "blockerLinks", "constrainsLinks"
		]);
		expect(payload.initiative).toEqual({
			id: initiative.id,
			kind: "initiative",
			status: "draft",
			title: "Initiative compact show"
		});
		expect(payload.initiative).not.toHaveProperty("body");
		expect(payload.entities.every((record: object) => !Object.hasOwn(record, "body"))).toBe(true);
	});

	it("renders direct compact bundle JSON through the compact bundle contract", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createStdout = createCapture();
		await runCli(
			["create", "initiative", "--title", "Direct compact bundle", "--body", "Hidden bundle body", "--view", "full", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createStdout.stream }
		);
		const initiative = JSON.parse(createStdout.read()) as { id: string };
		const stdout = createCapture();

		const exitCode = await runCli(
			["bundle", initiative.id, "--db", dbPath, "--json", "--view", "compact"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);
		const payload = JSON.parse(stdout.read());

		expect(exitCode).toBe(0);
		expect(payload.initiative).toEqual({
			id: initiative.id,
			kind: "initiative",
			status: "draft",
			title: "Direct compact bundle"
		});
		expect(payload.entities.every((record: object) => !Object.hasOwn(record, "body"))).toBe(true);
	});

	it("defaults entity reads to compact JSON while preserving explicit full and human output", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (kind: string, title: string): Promise<{ id: string }> => {
			const stdout = createCapture();
			await runCli(
				["create", kind, "--title", title, "--body", "Verbose body", "--view", "full", "--db", dbPath, "--json"],
				{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
			);
			return JSON.parse(stdout.read()) as { id: string };
		};
		const initiative = await createJson("initiative", "Compatibility initiative");
		const issue = await createJson("issue", "Compatibility issue");
		const commands = [
			["list", "issue"],
			["relations", issue.id],
			["show", issue.id],
			["show", initiative.id],
			["bundle", initiative.id]
		];
		const run = async (args: string[]): Promise<string> => {
			const stdout = createCapture();
			const exitCode = await runCli(
				[...args, "--db", dbPath],
				{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
			);
			expect(exitCode).toBe(0);
			return stdout.read();
		};

		for (const command of commands) {
			expect(await run([...command, "--json", "--view", "compact"])).toBe(await run([...command, "--json"]));
			expect(await run([...command, "--json", "--view", "full"])).not.toBe(await run([...command, "--json"]));
			expect(await run([...command, "--view", "compact"])).toBe(await run(command));
			expect(await run([...command, "--view", "full"])).toBe(await run(command));
		}
	});

	it("creates a project -> epic -> initiative chain through the create command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");

		const projectOut = createCapture();
		const projectErr = createCapture();
		const projectExitCode = await runCli(
			["create", "project", "--title", "Platform", "--db", dbPath],
			{ cwd: root, stderr: projectErr.stream, stdout: projectOut.stream }
		);
		expect(projectExitCode).toBe(0);
		expect(projectErr.read()).toBe("");
		expect(projectOut.read()).toContain("project");

		const { db: afterProjectDb, executor: afterProject } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: "default-project"
		});
		const discovery = getProjectDiscovery(afterProject);
		const project = discovery.kind === "available"
			? discovery.projects.find((entry) => entry.project.title === "Platform")?.project
			: undefined;
		afterProjectDb.close();
		expect(project).toBeDefined();

		const epicOut = createCapture();
		const epicErr = createCapture();
		const epicExitCode = await runCli(
			["create", "epic", "--title", "Checkout revamp", "--parent", project!.id, "--db", dbPath],
			{ cwd: root, stderr: epicErr.stream, stdout: epicOut.stream }
		);
		expect(epicExitCode).toBe(0);
		expect(epicErr.read()).toBe("");
		expect(epicOut.read()).toContain("epic");

		const { db: afterEpicDb, executor: afterEpic } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: project!.id
		});
		const projectAfterEpic = getDatabaseSnapshot(afterEpic, { projectId: project!.id });
		const epic = projectAfterEpic.kind === "available"
			? projectAfterEpic.snapshot.entities.find((entity) => entity.kind === "epic" && entity.title === "Checkout revamp")
			: undefined;
		afterEpicDb.close();
		expect(epic).toBeDefined();

		const initiativeOut = createCapture();
		const initiativeErr = createCapture();
		const initiativeExitCode = await runCli(
			["create", "initiative", "--title", "Checkout redesign", "--parent", epic!.id, "--db", dbPath],
			{ cwd: root, stderr: initiativeErr.stream, stdout: initiativeOut.stream }
		);
		expect(initiativeExitCode).toBe(0);
		expect(initiativeErr.read()).toBe("");
		expect(initiativeOut.read()).toContain("Checkout redesign");

		const { db: afterInitiativeDb, executor: afterInitiative } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: project!.id
		});
		try {
			const projectAfterInitiative = getDatabaseSnapshot(afterInitiative, { projectId: project!.id });
			const initiative = projectAfterInitiative.kind === "available"
				? projectAfterInitiative.snapshot.entities.find((entity) => entity.kind === "initiative" && entity.title === "Checkout redesign")
				: undefined;
			expect(initiative).toBeDefined();

			const epicDetails = getEntityDetails(afterInitiative, epic!.id);
			const projectParent = epicDetails.incoming.find((entry) => entry.relationType === "contains");
			expect(projectParent?.entity.id).toBe(project!.id);

			const initiativeDetails = getEntityDetails(afterInitiative, initiative!.id);
			const epicParent = initiativeDetails.incoming.find((entry) => entry.relationType === "contains");
			expect(epicParent?.entity.id).toBe(epic!.id);
		} finally {
			afterInitiativeDb.close();
		}
	});

	it("creates a version under a project and tags it to an initiative through the create and link commands", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");

		const { db: seedDb, executor: seedExecutor } = await ensureDatabase(dbPath, { currentWorkingDirectory: root });
		const project = createEntity(seedExecutor, { kind: "project", title: "Platform" });
		const initiative = createEntity(seedExecutor, { kind: "initiative", title: "Checkout redesign" });
		seedDb.close();

		const versionOut = createCapture();
		const versionErr = createCapture();
		const versionExitCode = await runCli(
			["create", "version", "--title", "2.0", "--parent", project.id, "--db", dbPath],
			{ cwd: root, stderr: versionErr.stream, stdout: versionOut.stream }
		);
		expect(versionExitCode).toBe(0);
		expect(versionErr.read()).toBe("");
		expect(versionOut.read()).toContain("version");

		const { db: afterVersionDb, executor: afterVersion } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: project.id
		});
		const projectSnapshot = getDatabaseSnapshot(afterVersion, { projectId: project.id });
		const version = projectSnapshot.kind === "available"
			? projectSnapshot.snapshot.entities.find((entity) => entity.kind === "version" && entity.title === "2.0")
			: undefined;
		afterVersionDb.close();
		expect(version).toBeDefined();

		const linkOut = createCapture();
		const linkErr = createCapture();
		const linkExitCode = await runCli(
			["link", initiative.id, "taggedWith", version!.id, "--db", dbPath],
			{ cwd: root, stderr: linkErr.stream, stdout: linkOut.stream }
		);
		expect(linkExitCode).toBe(0);
		expect(linkErr.read()).toBe("");
		expect(linkOut.read()).toContain("taggedWith");

		const { db: afterLinkDb, executor: afterLink } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: project.id
		});
		try {
			const versionDetails = getEntityDetails(afterLink, version!.id);
			const projectParent = versionDetails.incoming.find((entry) => entry.relationType === "owns");
			expect(projectParent?.entity.id).toBe(project.id);

			const tagger = versionDetails.incoming.find((entry) => entry.relationType === "taggedWith");
			expect(tagger?.entity.id).toBe(initiative.id);
		} finally {
			afterLinkDb.close();
		}
	});

	it("creates initial links and edits an entity title and body through generic commands", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer" });
		const blocker = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Blocking issue" });
		const secondBlocker = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Second blocking issue" });
		db.close();

		const createExitCode = await runCli(
			[
				"create", "issue", "--title", "Initial title", "--parent", initiative.id,
				"--link", "blocks", blocker.id,
				"--link", "blocks", secondBlocker.id,
				"--db", dbPath
			],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		);
		expect(createExitCode).toBe(0);

		const { db: afterCreateDb, executor: afterCreate } = await ensureDatabase(dbPath);
		const created = listEntities(afterCreate, "issue").find((entity) => entity.title === "Initial title");
		expect(getEntityDetails(afterCreate, created!.id).outgoing).toEqual(expect.arrayContaining([
			expect.objectContaining({ entity: expect.objectContaining({ id: blocker.id }), relationType: "blocks" }),
			expect.objectContaining({ entity: expect.objectContaining({ id: secondBlocker.id }), relationType: "blocks" })
		]));
		afterCreateDb.close();

		const editExitCode = await runCli(
			["edit", created!.id, "--title", "Final title", "--body", "Final body", "--db", dbPath],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		);
		expect(editExitCode).toBe(0);

		const { db: afterEditDb, executor: afterEdit } = await ensureDatabase(dbPath);
		try {
			expect(getEntityDetails(afterEdit, created!.id).entity).toEqual(expect.objectContaining({ body: "Final body", title: "Final title" }));
			expect(materializeEntityRevision(afterEdit, { entityId: created!.id, revision: 1 })).toMatchObject({
				body: "",
				title: "Initial title"
			});
		} finally {
			afterEditDb.close();
		}

		const error = createCapture();
		await expect(runCli(["edit", created!.id, "--db", dbPath], { cwd: root, stderr: error.stream, stdout: createCapture().stream })).rejects.toThrow(
			"--title or --body is required for edit."
		);
	});

	it("materializes an earlier entity revision through the generic history command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const created = await store.createEntity({ kind: "issue", title: "Initial title", body: "Initial body" });
		await store.updateEntity({
			entityId: created.id,
			title: "Updated title",
			body: "Updated body",
			expectedRevision: created.revision,
			expectedContentHash: created.contentHash
		});
		await store.close();

		const stdout = createCapture();
		const exitCode = await runCli(
			["history", created.id, "--revision", "1", "--db", dbPath],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain(`${created.id} revision 1/2`);
		expect(stdout.read()).toContain("Initial title");
		expect(stdout.read()).toContain("Initial body");
	});

	it("materializes context and forgotten term revisions through the generic history command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const context1 = await store.upsertContext({ title: "Initial context", summary: "Initial summary." });
		await store.upsertContext({ title: "Current context", summary: "Current summary.", expectedRevision: context1.context.revision, expectedContentHash: context1.context.contentHash });
		const term1 = await store.defineContextTerm({ term: "Order", definition: "Initial definition." });
		const term2 = await store.defineContextTerm({ term: "Order", definition: "Current definition.", avoid: ["purchase"], expectedRevision: term1.term.revision, expectedContentHash: term1.term.contentHash });
		await store.forgetContextTerm({ term: "Order", expectedRevision: term2.term.revision, expectedContentHash: term2.term.contentHash });
		await store.close();

		const contextStdout = createCapture();
		expect(await runCli(["history", "--context", "default", "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: contextStdout.stream })).toBe(0);
		expect(contextStdout.read()).toContain("default context revision 1/2 Initial context");

		const termStdout = createCapture();
		expect(await runCli(["history", "--context", "default", "--term", "Order", "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: termStdout.stream })).toBe(0);
		expect(termStdout.read()).toContain("default term Order revision 1/3");
		expect(termStdout.read()).toContain("Initial definition.");
	});

	it("restores active and deleted entities as new heads through the generic restore command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const parent = await store.createEntity({ kind: "initiative", title: "Parent" });
		const created = await store.createEntity({ kind: "issue", title: "Initial", body: "Initial body", parentId: parent.id });
		await store.updateEntity({ entityId: created.id, title: "Edited", body: "Edited body", expectedRevision: created.revision, expectedContentHash: created.contentHash });
		await store.close();

		const firstStdout = createCapture();
		expect(await runCli(["restore", created.id, "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: firstStdout.stream })).toBe(0);
		expect(firstStdout.read()).toContain(`Restored ${created.id} revision 1 as revision 3`);

		const reopened = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const restoredHead = (await reopened.store.getEntityDetails(created.id)).entity;
		expect(restoredHead).toEqual(expect.objectContaining({ title: "Initial", body: "Initial body", revision: 3 }));
		await reopened.store.deleteEntity({ entityId: created.id });
		await reopened.store.close();

		const secondStdout = createCapture();
		expect(await runCli(["restore", created.id, "--revision", "3", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: secondStdout.stream })).toBe(0);
		expect(secondStdout.read()).toContain(`Restored ${created.id} revision 3 as revision 5`);

		const finalStore = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		try {
			expect((await finalStore.store.getEntityDetails(created.id)).entity).toEqual(expect.objectContaining({ title: "Initial", revision: 5 }));
			expect(await finalStore.store.materializeEntityRevision({ entityId: created.id, revision: 3 })).toEqual(expect.objectContaining({ restoredFromRevision: 1 }));
		} finally {
			await finalStore.store.close();
		}
	});

	it("restores context and forgotten term revisions through the generic restore command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const context1 = await store.upsertContext({ title: "Initial context", summary: "Initial summary." });
		await store.upsertContext({ title: "Current context", summary: "Current summary.", expectedRevision: context1.context.revision, expectedContentHash: context1.context.contentHash });
		const term1 = await store.defineContextTerm({ term: "Order", definition: "Initial definition." });
		const term2 = await store.defineContextTerm({ term: "Order", definition: "Current definition.", expectedRevision: term1.term.revision, expectedContentHash: term1.term.contentHash });
		await store.forgetContextTerm({ term: "Order", expectedRevision: term2.term.revision, expectedContentHash: term2.term.contentHash });
		await store.close();

		const contextStdout = createCapture();
		expect(await runCli(["restore", "--context", "default", "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: contextStdout.stream })).toBe(0);
		expect(contextStdout.read()).toContain("Restored default context revision 1 as revision 3");

		const termStdout = createCapture();
		expect(await runCli(["restore", "--context", "default", "--term", "Order", "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: termStdout.stream })).toBe(0);
		expect(termStdout.read()).toContain("Restored default term Order revision 1 as revision 4");

		const reopened = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		try {
			expect((await reopened.store.getContextDetails()).context).toEqual(expect.objectContaining({ title: "Initial context", revision: 3 }));
			expect((await reopened.store.getContextDetails()).terms).toEqual([expect.objectContaining({ term: "Order", definition: "Initial definition.", revision: 4 })]);
			expect(await reopened.store.materializeContextRevision({ revision: 3 })).toEqual(expect.objectContaining({ restoredFromRevision: 1 }));
			expect(await reopened.store.materializeContextTermRevision({ term: "Order", revision: 4 })).toEqual(expect.objectContaining({ restoredFromRevision: 1, tombstone: false }));
		} finally {
			await reopened.store.close();
		}
	});

	it("resurrects a forgotten context term through the context command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const io = { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream };

		expect(await runCli(["context", "define", "Order", "--definition", "Initial.", "--db", dbPath], io)).toBe(0);
		expect(await runCli(["context", "forget", "Order", "--db", dbPath], io)).toBe(0);
		expect(await runCli(["context", "forget", "Order", "--db", dbPath], io)).toBe(0);
		expect(await runCli(["context", "define", "Order", "--definition", "Restored.", "--db", dbPath], io)).toBe(0);

		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		try {
			expect((await store.getContextDetails()).terms).toEqual([
				expect.objectContaining({ term: "Order", definition: "Restored.", revision: 3 })
			]);
		} finally {
			await store.close();
		}
	});

	it("creates sub-issues through the existing create command and shows them in the bundle", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer" });
		const parentIssue = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Parent issue" });
		db.close();

		const createExitCode = await runCli(
			["create", "issue", "--title", "Sub-issue", "--parent", parentIssue.id, "--view", "full", "--db", dbPath, "--json"],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(createExitCode).toBe(0);
		expect(stderr.read()).toBe("");
		const subIssue = JSON.parse(stdout.read()) as { id: string; reference: string; title: string };
		expect(subIssue).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), reference: expect.stringMatching(/^ISS_[0-7][0-9A-HJKMNP-TV-Z]{25}$/), title: "Sub-issue" });

		const bundleStdout = createCapture();
		const bundleStderr = createCapture();
		const bundleExitCode = await runCli(["bundle", initiative.id, "--db", dbPath], {
			cwd: root,
			stderr: bundleStderr.stream,
			stdout: bundleStdout.stream
		});

		expect(bundleExitCode).toBe(0);
		expect(bundleStderr.read()).toBe("");
		expect(bundleStdout.read()).toContain("Sub-issues:");
		expect(bundleStdout.read()).toContain(`${parentIssue.id} -> ${subIssue.id}`);
	});

	it("exports one initiative to a grouped directory by default", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		const issue = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Render detail view", body: "Issue body" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["export", initiative.id, "--db", dbPath], {
			cwd: root,
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`Exported initiative to ${path.join(root, "agent-issues-export", initiative.id)}`);
		expect(existsSync(path.join(root, "agent-issues-export", initiative.id, "initiative.md"))).toBe(true);
		expect(existsSync(path.join(root, "agent-issues-export", initiative.id, "issues", `${issue.id}.md`))).toBe(true);
	});

	it("exports the whole project to a grouped directory by default", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer" });
		createEntity(executor, { kind: "adr", title: "Use SVG graphs" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["export", "project", "--db", dbPath], {
			cwd: root,
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`Exported project to ${path.join(root, "agent-issues-export", "project")}`);
		expect(existsSync(path.join(root, "agent-issues-export", "project", "project.md"))).toBe(true);
		expect(existsSync(path.join(root, "agent-issues-export", "project", "initiatives", initiative.id, "initiative.md"))).toBe(true);
	});

	it("emits single-file markdown when requested", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["export", initiative.id, "--single-file", "--db", dbPath], {
			cwd: root,
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("type: \"initiative-export\"");
		expect(stdout.read()).toContain(`# ${initiative.id} Console Viewer`);
	});

	it("writes single-file markdown to an explicit file path", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const outputPath = path.join(root, "exports", "initiative.md");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(
			["export", initiative.id, "--single-file", "--output", outputPath, "--db", dbPath],
			{
				cwd: root,
				stderr: stderr.stream,
				stdout: stdout.stream
			}
		);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`Exported initiative ${initiative.id} to ${outputPath}`);
		expect(readFileSync(outputPath, "utf8")).toContain("type: \"initiative-export\"");
	});

	it("stops a running live site through the cli", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();
		const port = await getAvailablePort();
		const { db } = await ensureDatabase(dbPath, { tenant: "test-tenant" });
		db.close();

		const handle = await startLiveSite({ currentWorkingDirectory: root, dbPath, port, tenant: "test-tenant" });
		liveSiteClosers.add(() => {
			if (handle.server.listening) {
				handle.close();
			}
		});

		await new Promise<void>((resolve) => {
			handle.server.once("listening", () => resolve());
		});

		const closePromise = new Promise<void>((resolve) => {
			handle.server.once("close", () => resolve());
		});

		const exitCode = await runCli(["stop-site", "--port", String(port)], {
			cwd: root,
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		await closePromise;
		liveSiteClosers.delete(handle.close);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`Stopped live site at http://127.0.0.1:${port}`);
	});

	it("serves an explicitly selected project snapshot through the seam", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const port = await getAvailablePort();
		const { db, executor } = await ensureDatabase(dbPath, { tenant: "test-tenant" });
		const project = createEntity(executor, { kind: "project", title: "Console Viewer" });
		const epic = createEntity(executor, { kind: "epic", title: "Console Epic", parentId: project.id });
		const initiative = createEntity(executor, { kind: "initiative", parentId: epic.id, title: "Console Viewer" });
		db.close();

		const handle = await startLiveSite({ currentWorkingDirectory: root, dbPath, port, tenant: "test-tenant" });
		liveSiteClosers.add(() => {
			if (handle.server.listening) {
				handle.close();
			}
		});

		await new Promise<void>((resolve) => {
			handle.server.once("listening", () => resolve());
		});

		try {
			const configResponse = await fetch(`http://127.0.0.1:${port}/site-config.json`);
			const config = await configResponse.json();
			expect(config.currentTenant).toBe("test-tenant");
			expect(config.dbPath).toBe(dbPath);
			expect(config.availableTenants.map((tenant: { id: string }) => tenant.id)).toContain("test-tenant");

			const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot?tenant=test-tenant&project=${project.id}`);
			const snapshot = await snapshotResponse.json();
			expect(snapshot.kind).toBe("available");
			expect(snapshot.snapshot.entities.map((entity: { id: string }) => entity.id)).toContain(initiative.id);

			const unavailableResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot?tenant=test-tenant&project=PROJ404`);
			expect(await unavailableResponse.json()).toEqual({ kind: "unavailable" });
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", () => resolve());
			});
			handle.close();
			await closePromise;
			liveSiteClosers.delete(handle.close);
		}
	});

	it("returns typed unavailable project discovery for an unknown tenant without bootstrapping it", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const port = await getAvailablePort();
		const { db } = await ensureDatabase(dbPath, { tenant: "known-tenant" });
		db.close();

		const handle = await startLiveSite({ currentWorkingDirectory: root, dbPath, port, tenant: "known-tenant" });
		liveSiteClosers.add(() => {
			if (handle.server.listening) {
				handle.close();
			}
		});
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/projects?tenant=missing-tenant`);
			expect(await response.json()).toEqual({ kind: "unavailable" });

			const { db: verificationDb, executor: verificationExecutor } = await ensureDatabase(dbPath, { tenant: "known-tenant" });
			try {
				expect(listEntities(verificationExecutor, "project").map((entity) => entity.reference)).toEqual([
					expect.stringMatching(/^PROJ_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
				]);
				expect(listTenants(verificationDb).map((tenant) => tenant.id)).toEqual(["known-tenant"]);
			} finally {
				verificationDb.close();
			}
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
			liveSiteClosers.delete(handle.close);
		}
	});

	it("broadcasts a snapshot-changed event through the seam after a local write (ISS191)", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const port = await getAvailablePort();
		const { db } = await ensureDatabase(dbPath, { tenant: "test-tenant" });
		db.close();

		const handle = await startLiveSite({ currentWorkingDirectory: root, dbPath, port, tenant: "test-tenant", pollIntervalMs: 20 });
		liveSiteClosers.add(() => {
			if (handle.server.listening) {
				handle.close();
			}
		});

		await new Promise<void>((resolve) => {
			handle.server.once("listening", () => resolve());
		});

		const listener = waitForSnapshotChangedEvent(`http://127.0.0.1:${port}/events`);

		try {
			const { db: writeDb, executor: writeExecutor } = await ensureDatabase(dbPath, { tenant: "test-tenant" });
			createEntity(writeExecutor, { kind: "initiative", title: "Live-refresh through the seam" });
			writeDb.close();

			const event = await Promise.race([
				listener.event,
				new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for snapshot-changed")), 5000))
			]);

			expect(event).toMatchObject({ type: "snapshot-changed" });
		} finally {
			listener.stop();
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", () => resolve());
			});
			handle.close();
			await closePromise;
			liveSiteClosers.delete(handle.close);
		}
	});

	it("reports when no live site is running on the selected port", async () => {
		const stdout = createCapture();
		const stderr = createCapture();
		const port = await getAvailablePort();

		const exitCode = await runCli(["stop-site", "--port", String(port)], {
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`No live site was running at http://127.0.0.1:${port}`);
	});

	it("reports when another server is listening on the selected port", async () => {
		const stdout = createCapture();
		const stderr = createCapture();
		const port = await getAvailablePort();
		const server = createServer();

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => resolve());
		});

		liveSiteClosers.add(() => {
			if (server.listening) {
				server.close();
			}
		});

		const exitCode = await runCli(["stop-site", "--port", String(port)], {
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`A server is listening at http://127.0.0.1:${port}, but it does not expose the agent-issues stop endpoint.`);
	});
});