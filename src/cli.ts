#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { main, runCli, type AgentIssuesContext } from "./cli/index.js";

export { runCli, type AgentIssuesContext };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main().then((exitCode) => {
		process.exitCode = exitCode;
	});
}