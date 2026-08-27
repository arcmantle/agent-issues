import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";

let tempDir: string | null = null;

function createCapture(): { read: () => string; stream: PassThrough } {
	const stream = new PassThrough();
	let text = "";
	stream.on("data", (chunk) => {
		text += chunk.toString();
	});
	return { read: () => text, stream };
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("MCP CLI commands", () => {
	it("installs MCP configuration at an explicit target", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-cli-"));
		const targetFile = path.join(tempDir, ".vscode", "mcp.json");
		const stdout = createCapture();

		expect(await runCli(["install-mcp", "--target", targetFile, "--json"], {
			cwd: tempDir,
			stderr: createCapture().stream,
			stdout: stdout.stream
		})).toBe(0);

		expect(JSON.parse(stdout.read())).toMatchObject({
			targetFile,
			server: { name: "agent-issues", status: "installed" }
		});
		expect(JSON.parse(readFileSync(targetFile, "utf8"))).toMatchObject({
			servers: {
				"agent-issues": {
					command: "agent-issues-mcp",
					cwd: "${workspaceFolder}",
					env: { AGENT_ISSUES_PROJECT_IDENTITY: "${config:agentIssues.projectIdentity}" },
					type: "stdio"
				}
			}
		});
	});

	it("lists and uninstalls an installed MCP server", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-cli-"));
		const targetFile = path.join(tempDir, ".vscode", "mcp.json");
		const installOutput = createCapture();
		const listOutput = createCapture();
		const uninstallOutput = createCapture();
		const context = { cwd: tempDir, stderr: createCapture().stream };

		expect(await runCli(["install-mcp", "--target", targetFile, "--json"], { ...context, stdout: installOutput.stream })).toBe(0);
		expect(await runCli(["list-mcp", "--target", targetFile, "--json"], { ...context, stdout: listOutput.stream })).toBe(0);
		expect(await runCli(["uninstall-mcp", "--target", targetFile, "--json"], { ...context, stdout: uninstallOutput.stream })).toBe(0);

		expect(JSON.parse(installOutput.read()).server.status).toBe("installed");
		expect(JSON.parse(listOutput.read()).server.status).toBe("installed");
		expect(JSON.parse(uninstallOutput.read()).server.status).toBe("removed");
		expect(JSON.parse(readFileSync(targetFile, "utf8"))).toEqual({ servers: {} });
	});
});