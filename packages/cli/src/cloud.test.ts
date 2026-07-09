import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCloudBinding } from "@agent-issues/core";

import { runCli } from "./cli.js";

function createCapture() {
	const stream = new PassThrough();
	let text = "";
	stream.on("data", (chunk) => {
		text += chunk.toString();
	});
	return { stream, read: () => text };
}

describe("cloud CLI commands", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let projectDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-cli-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-project-"));
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { force: true, recursive: true });
		rmSync(projectDirectory, { force: true, recursive: true });
	});

	it("reports no binding for a project that has never been bound", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["cloud", "status"], { stdout: stdout.stream, stderr: stderr.stream, cwd: projectDirectory });

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("local");
	});

	it("binds a project, then status reports cloud with the bound URL and tenant", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const bindExitCode = await runCli(["cloud", "bind", "--url", "https://api.example.com", "--tenant-id", "tenant-a"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			cwd: projectDirectory
		});
		expect(bindExitCode).toBe(0);

		const statusStdout = createCapture();
		const statusExitCode = await runCli(["cloud", "status", "--json"], {
			stdout: statusStdout.stream,
			stderr: stderr.stream,
			cwd: projectDirectory
		});

		expect(statusExitCode).toBe(0);
		const status = JSON.parse(statusStdout.read());
		expect(status.backend).toBe("cloud");
		expect(status.projectIdentity).toEqual(expect.any(String));
		expect(status.binding).toEqual({
			cloudApiUrl: "https://api.example.com",
			tenantId: "tenant-a"
		});
	});

	it("persists the binding keyed by the resolved project identity", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		await runCli(["cloud", "bind", "--url", "https://api.example.com", "--tenant-id", "tenant-a"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			cwd: projectDirectory
		});

		const projectIdentity = path.basename(projectDirectory).toLowerCase();
		expect(getCloudBinding(projectIdentity)).toEqual({
			projectIdentity,
			cloudApiUrl: "https://api.example.com",
			tenantId: "tenant-a"
		});
	});

	it("unbinds a project, returning status to local", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		await runCli(["cloud", "bind", "--url", "https://api.example.com", "--tenant-id", "tenant-a"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			cwd: projectDirectory
		});

		const unbindExitCode = await runCli(["cloud", "unbind"], { stdout: stdout.stream, stderr: stderr.stream, cwd: projectDirectory });
		expect(unbindExitCode).toBe(0);

		const statusStdout = createCapture();
		await runCli(["cloud", "status", "--json"], { stdout: statusStdout.stream, stderr: stderr.stream, cwd: projectDirectory });

		expect(JSON.parse(statusStdout.read()).backend).toBe("local");
	});

	it("unbinding a project with no binding is a harmless no-op", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["cloud", "unbind"], { stdout: stdout.stream, stderr: stderr.stream, cwd: projectDirectory });

		expect(exitCode).toBe(0);
	});

	it("an env var override is reflected in status without changing the underlying binding", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		await runCli(["cloud", "bind", "--url", "https://api.example.com", "--tenant-id", "tenant-a"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			cwd: projectDirectory
		});

		const originalBackendEnv = process.env.AGENT_ISSUES_BACKEND;
		process.env.AGENT_ISSUES_BACKEND = "local";
		try {
			const statusStdout = createCapture();
			await runCli(["cloud", "status", "--json"], { stdout: statusStdout.stream, stderr: stderr.stream, cwd: projectDirectory });
			expect(JSON.parse(statusStdout.read()).backend).toBe("local");
		} finally {
			if (originalBackendEnv === undefined) {
				delete process.env.AGENT_ISSUES_BACKEND;
			} else {
				process.env.AGENT_ISSUES_BACKEND = originalBackendEnv;
			}
		}
	});
});
