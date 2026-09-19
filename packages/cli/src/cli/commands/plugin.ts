import { spawn } from "node:child_process";

import { Option } from "clipanion";

import { renderPluginInstall } from "../renderers.js";
import { BaseCommand, type PluginInstallRunner } from "../shared.js";

const MARKETPLACE = "arcmantle/agent-issues-plugin";
const PLUGIN = "agent-issues@agent-issues";

export const PLUGIN_HOSTS = ["claude", "copilot"] as const;

type PluginHost = typeof PLUGIN_HOSTS[number];

export class PluginInstallCommand extends BaseCommand {
	public static paths = [["plugin", "install"]];

	public host = Option.String({ name: "host" });

	public async execute(): Promise<number> {
		const host = parsePluginHost(this.host);
		const runner = this.context.pluginInstallDependencies?.run ?? runPluginInstallCommand;

		for (const args of getPluginInstallCommands(host)) {
			await runner(host, args, { quiet: this.asJson });
		}

		const result = {
			command: "plugin-install" as const,
			host,
			marketplace: MARKETPLACE,
			plugin: PLUGIN
		};
		this.print(result, renderPluginInstall(result));
		return 0;
	}
}

export function getPluginInstallCommands(host: PluginHost): string[][] {
	const commands = [
		["plugin", "marketplace", "add", MARKETPLACE],
		["plugin", "install", PLUGIN]
	];

	if (host === "claude") {
		commands[1].push("--scope", "user");
	}

	return commands;
}

function parsePluginHost(value: string): PluginHost {
	if (isPluginHost(value)) {
		return value;
	}

	throw new Error(`Unsupported plugin host: ${value}. Use copilot or claude.`);
}

function isPluginHost(value: string): value is PluginHost {
	return PLUGIN_HOSTS.some((host) => host === value);
}

const runPluginInstallCommand: PluginInstallRunner = async (command, args, options) => {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: options.quiet ? ["inherit", "pipe", "pipe"] : "inherit"
		});
		let errorOutput = "";

		child.stdout?.resume();
		child.stderr?.on("data", (chunk: Buffer) => {
			errorOutput += chunk.toString();
		});
		child.once("error", (error) => {
			reject(new Error(`Could not run ${command}: ${error.message}`));
		});
		child.once("close", (exitCode) => {
			if (exitCode === 0) {
				resolve();
				return;
			}

			const detail = errorOutput.trim();
			reject(new Error(`${command} ${args.join(" ")} exited with code ${exitCode ?? "unknown"}.${detail ? ` ${detail}` : ""}`));
		});
	});
};