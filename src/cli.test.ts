import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { ensureDatabase } from "./database.js";
import { listEntities } from "./store.js";

let tempDir: string | null = null;

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
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

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
});