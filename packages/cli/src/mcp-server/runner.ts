import { resolveDatabasePath } from "@agent-issues/api-local";

import { spawnLocalDaemon } from "../daemon/local-daemon-store.js";
import { runMcpStdioServer } from "./stdio.js";

export const MCP_SERVER_FLAG = "--mcp";

export async function runMcpServer(): Promise<void> {
	const dbPath = resolveDatabasePath();
	const workspaceRoot = process.cwd();
	await runMcpStdioServer({ dbPath, spawn: () => spawnLocalDaemon({ dbPath }), workspaceRoot });
}