import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { isEntrypointInvocation, runCli } from "./cli.js";
import { main } from "./cli/index.js";
import { ensureDatabase } from "./database.js";
import { startLiveSite } from "./site/index.js";
import { createEntity, listEntities } from "./store.js";

let tempDir: string | null = null;
const liveSiteClosers = new Set<() => void>();

function createTempDir(): string {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-cli-"));
	return tempDir;
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

	it("treats a symlinked argv path as a direct invocation", () => {
		const root = createTempDir();
		const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
		const linkedPath = path.join(root, "agent-issues");

		symlinkSync(cliPath, linkedPath);

		expect(isEntrypointInvocation(pathToFileURL(cliPath).href, linkedPath)).toBe(true);
	});

	it("creates entities through clipanion-parsed options", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(
			["create", "initiative", "--title", "Ship clipanion", "--db", dbPath, "--tenant", "test-tenant"],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("initiative");

		const { db } = ensureDatabase(dbPath, { tenant: "test-tenant" });
		try {
			const initiatives = listEntities(db, "initiative");
			expect(initiatives).toHaveLength(1);
			expect(initiatives[0]?.title).toBe("Ship clipanion");
		} finally {
			db.close();
		}
	});

	it("creates sub-issues through the existing create command and shows them in the bundle", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();
		const { db } = ensureDatabase(dbPath, { tenant: "test-tenant" });
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const parentIssue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Parent issue" });
		db.close();

		const createExitCode = await runCli(
			["create", "issue", "--title", "Sub-issue", "--parent", parentIssue.id, "--db", dbPath, "--tenant", "test-tenant"],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(createExitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("Sub-issue");

		const bundleStdout = createCapture();
		const bundleStderr = createCapture();
		const bundleExitCode = await runCli(["bundle", initiative.id, "--db", dbPath, "--tenant", "test-tenant"], {
			cwd: root,
			stderr: bundleStderr.stream,
			stdout: bundleStdout.stream
		});

		expect(bundleExitCode).toBe(0);
		expect(bundleStderr.read()).toBe("");
		expect(bundleStdout.read()).toContain("Sub-issues:");
		expect(bundleStdout.read()).toContain(`${parentIssue.id} -> ISS2`);
	});

	it("exports one initiative to a grouped directory by default", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db } = ensureDatabase(dbPath, { tenant: "test-tenant" });
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail view", body: "Issue body" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["export", initiative.id, "--db", dbPath, "--tenant", "test-tenant"], {
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
		const { db } = ensureDatabase(dbPath, { tenant: "test-tenant" });
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		createEntity(db, { kind: "adr", title: "Use SVG graphs" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["export", "project", "--db", dbPath, "--tenant", "test-tenant"], {
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
		const { db } = ensureDatabase(dbPath, { tenant: "test-tenant" });
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["export", initiative.id, "--single-file", "--db", dbPath, "--tenant", "test-tenant"], {
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
		const { db } = ensureDatabase(dbPath, { tenant: "test-tenant" });
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(
			["export", initiative.id, "--single-file", "--output", outputPath, "--db", dbPath, "--tenant", "test-tenant"],
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
		const { db } = ensureDatabase(dbPath, { tenant: "test-tenant" });
		db.close();

		const handle = startLiveSite({ dbPath, port, tenant: "test-tenant" });
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