import { spawn as spawnChildProcess, type ChildProcess, type SpawnOptions } from "node:child_process";

export const MCP_SERVER_FLAG = "--mcp";

export type AgentIssuesMcpProxyOptions = {
	spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
	stderr?: Pick<NodeJS.WriteStream, "write">;
	setExitCode?: (exitCode: number) => void;
};

export function runAgentIssuesMcpProxy(options: AgentIssuesMcpProxyOptions = {}): ChildProcess {
	const spawn = options.spawn ?? spawnChildProcess;
	const stderr = options.stderr ?? process.stderr;
	const setExitCode = options.setExitCode ?? ((exitCode) => {
		process.exitCode = exitCode;
	});
	const child = spawn("agent-issues", [MCP_SERVER_FLAG], { stdio: "inherit" });

	child.once("error", (error) => {
		stderr.write(`Cannot start agent-issues MCP server: ${error.message}\n`);
		setExitCode(1);
	});
	child.once("exit", (exitCode) => {
		setExitCode(exitCode ?? 1);
	});

	return child;
}