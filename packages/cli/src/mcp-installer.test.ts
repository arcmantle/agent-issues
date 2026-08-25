import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installMcp, listMcp, uninstallMcp } from "./mcp-installer.js";

let tempDir: string | null = null;

function createConfigFile(): string {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-install-"));
	return path.join(tempDir, "mcp.json");
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("MCP installer", () => {
	it("adds its server without replacing unrelated server configuration", () => {
		const targetFile = createConfigFile();
		writeFileSync(targetFile, `${JSON.stringify({ servers: { existing: { command: "other-mcp" } } }, null, "\t")}\n`);

		const result = installMcp({ targetFile });

		expect(result.server.status).toBe("installed");
		expect(JSON.parse(readFileSync(targetFile, "utf8"))).toEqual({
			servers: {
				existing: { command: "other-mcp" },
				"agent-issues": {
					command: "agent-issues-mcp",
					cwd: "${workspaceFolder}",
					type: "stdio"
				}
			}
		});
	});

	it("removes only the server entry that it installed", () => {
		const targetFile = createConfigFile();
		writeFileSync(targetFile, `${JSON.stringify({ servers: { existing: { command: "other-mcp" } } }, null, "\t")}\n`);
		installMcp({ targetFile });

		const result = uninstallMcp({ targetFile });

		expect(result.server.status).toBe("removed");
		expect(JSON.parse(readFileSync(targetFile, "utf8"))).toEqual({
			servers: {
				existing: { command: "other-mcp" }
			}
		});
	});

	it("reports an installer-owned server as installed", () => {
		const targetFile = createConfigFile();
		installMcp({ targetFile });

		const result = listMcp({ targetFile });

		expect(result.server).toEqual({ name: "agent-issues", status: "installed" });
	});

	it("preserves a user-owned server entry and does not remove it", () => {
		const targetFile = createConfigFile();
		const userOwnedServer = { command: "custom-agent-issues-mcp", type: "stdio" };
		writeFileSync(targetFile, `${JSON.stringify({ servers: { "agent-issues": userOwnedServer } }, null, "\t")}\n`);

		expect(installMcp({ targetFile }).server.status).toBe("skipped");
		expect(listMcp({ targetFile }).server.status).toBe("partial");
		expect(uninstallMcp({ targetFile }).server.status).toBe("missing");
		expect(JSON.parse(readFileSync(targetFile, "utf8"))).toEqual({ servers: { "agent-issues": userOwnedServer } });
	});

	it("replaces a colliding server entry with force", () => {
		const targetFile = createConfigFile();
		writeFileSync(targetFile, `${JSON.stringify({ servers: { "agent-issues": { command: "custom-agent-issues-mcp" } } }, null, "\t")}\n`);

		const result = installMcp({ targetFile, force: true });

		expect(result.server.status).toBe("updated");
		expect(listMcp({ targetFile }).server.status).toBe("installed");
		expect(JSON.parse(readFileSync(targetFile, "utf8"))).toEqual({
			servers: {
				"agent-issues": {
					command: "agent-issues-mcp",
					cwd: "${workspaceFolder}",
					type: "stdio"
				}
			}
		});
	});

	it("rejects configuration with a non-object servers value", () => {
		const targetFile = createConfigFile();
		writeFileSync(targetFile, `${JSON.stringify({ servers: [] }, null, "\t")}\n`);

		expect(() => installMcp({ targetFile })).toThrow(/servers/);
		expect(JSON.parse(readFileSync(targetFile, "utf8"))).toEqual({ servers: [] });
	});
});