#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { main, runCli, type AgentIssuesContext } from "./cli/index.js";

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

if (isEntrypointInvocation(import.meta.url, process.argv[1])) {
	void main().then((exitCode) => {
		process.exitCode = exitCode;
	});
}