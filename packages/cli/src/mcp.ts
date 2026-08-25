#!/usr/bin/env node

import { resolveDatabasePath, type LocalDaemonStoreOptions } from "@agent-issues/api-local";

import { runDaemonProcess } from "./daemon/daemon-main.js";
import { LOCAL_DAEMON_SPAWN_FLAG, spawnLocalDaemon } from "./daemon/local-daemon-store.js";
import { resolveProjectIdentity } from "./project-identity.js";

type BundledMcpServer = {
	runMcpStdioServer: (options: LocalDaemonStoreOptions) => Promise<void>;
};

function shouldRunLocalDaemon(args: string[]): boolean {
	return args[0] === LOCAL_DAEMON_SPAWN_FLAG;
}

if (shouldRunLocalDaemon(process.argv.slice(2))) {
	runDaemonProcess();
} else {
	const { runMcpStdioServer } = (await import(new URL("./mcp-server/stdio.js", import.meta.url).href)) as BundledMcpServer;
	const dbPath = resolveDatabasePath();
	const workspaceRoot = process.cwd();
	const { identity: projectIdentity } = resolveProjectIdentity(workspaceRoot);
	void runMcpStdioServer({ dbPath, projectIdentity, spawn: () => spawnLocalDaemon({ dbPath }), workspaceRoot });
}