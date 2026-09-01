import { resolveDatabasePath } from "@agent-issues/api-local";

import { spawnLocalDaemon } from "./daemon/local-daemon-store.js";
import { runMcpStdioServer } from "./mcp-server/stdio.js";
import { resolveProjectIdentity } from "./project-identity.js";

export const MCP_SERVER_FLAG = "--mcp";

export async function runMcpServer(): Promise<void> {
	const dbPath = resolveDatabasePath();
	const workspaceRoot = process.cwd();
	const { identity: projectIdentity } = resolveProjectIdentity(workspaceRoot);
	await runMcpStdioServer({ dbPath, projectIdentity, spawn: () => spawnLocalDaemon({ dbPath }), workspaceRoot });
}