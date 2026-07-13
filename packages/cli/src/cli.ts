#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LOCAL_DAEMON_SPAWN_FLAG } from "@agent-issues/core";

import { main, runCli, type AgentIssuesContext } from "./cli/index.js";
import { runDaemonProcess } from "./daemon/daemon-main.js";

export { runCli, type AgentIssuesContext };

export function isEntrypointInvocation(moduleUrl: string, argvPath: string | undefined): boolean {
	if (!argvPath) {
		return false;
	}

	return resolveInvocationPath(fileURLToPath(moduleUrl)) === resolveInvocationPath(argvPath);
}

function resolveInvocationPath(filePath: string): string {
	try {
		return realpathSync.native(filePath);
	} catch {
		return filePath;
	}
}

/**
 * A self-respawned local daemon process (ISS190) re-invokes this same entrypoint with a
 * hidden flag as its first argument, instead of a normal command. Recognizing it here lets
 * `spawnLocalDaemon()` in `@agent-issues/core` re-exec whichever script is currently running
 * without needing any knowledge of the CLI's command-dispatch internals.
 */
export function shouldRunLocalDaemon(args: string[]): boolean {
	return args[0] === LOCAL_DAEMON_SPAWN_FLAG;
}

if (isEntrypointInvocation(import.meta.url, process.argv[1])) {
	if (shouldRunLocalDaemon(process.argv.slice(2))) {
		runDaemonProcess();
	} else {
		void main().then((exitCode) => {
			process.exitCode = exitCode;
		});
	}
}