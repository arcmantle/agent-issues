import { readFileSync } from "node:fs";
import type { Writable } from "node:stream";

import { Command, Option, type BaseContext } from "clipanion";

import type { ContextDirectoryView } from "../context-store.js";

export type AgentIssuesContext = BaseContext & {
	cwd: string;
};

export type BodyInputOptions = {
	body?: string;
	bodyFile?: string;
};

export const CONTEXT_SUBCOMMANDS = new Set(["list", "show", "search", "conflicts", "set", "define", "forget"]);

export abstract class BaseCommand extends Command<AgentIssuesContext> {
	public asJson = Option.Boolean("--json", false);

	protected print(payload: object, text: string) {
		printOutput(this.context.stdout, this.asJson, payload, text);
	}
}

export abstract class TenantCommand extends BaseCommand {
	public dbPath = Option.String("--db");
	public tenant = Option.String("--tenant");
}

export abstract class MutableTenantCommand extends TenantCommand {
	public force = Option.Boolean("--force", false);
}

export abstract class BodyTenantCommand extends TenantCommand {
	public body = Option.String("--body");
	public bodyFile = Option.String("--body-file");

	protected requireBody(message: string): string {
		return requireBodyOption({ body: this.body, bodyFile: this.bodyFile }, message);
	}

	protected resolveBody(): string | undefined {
		return resolveBodyOption({ body: this.body, bodyFile: this.bodyFile });
	}
}

export abstract class TargetCommand extends BaseCommand {
	public force = Option.Boolean("--force", false);
	public target = Option.String("--target");
}

export function parseContextView(value: string | undefined): ContextDirectoryView {
	if (!value) {
		return "all";
	}

	if (value === "all" || value === "global" || value === "initiatives") {
		return value;
	}

	throw new Error(`Unknown context view: ${value}`);
}

export function parseCsvOption(value: string | undefined): string[] {
	if (!value) {
		return [];
	}

	return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

export function parsePortOption(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsedPort = Number(value);
	if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
		throw new Error(`Invalid port: ${value}`);
	}

	return parsedPort;
}

export function printOutput(output: Writable, asJson: boolean, payload: object, text: string) {
	if (asJson) {
		output.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}

	output.write(`${text}\n`);
}

export function requirePositional(positionals: string[], index: number, usage: string): string {
	const value = positionals[index];

	if (!value) {
		throw new Error(`Missing argument. Usage: ${usage}`);
	}

	return value;
}

export function requireOption(value: string | undefined, message: string): string {
	if (!value) {
		throw new Error(message);
	}

	return value;
}

export function requireBodyOption(options: BodyInputOptions, message: string): string {
	const body = resolveBodyOption(options);
	if (body === undefined) {
		throw new Error(message);
	}

	return body;
}

export function resolveBodyOption(options: BodyInputOptions): string | undefined {
	if (options.body !== undefined && options.bodyFile !== undefined) {
		throw new Error("Use either --body or --body-file, not both.");
	}

	if (options.body !== undefined) {
		return options.body;
	}

	if (options.bodyFile === undefined) {
		return undefined;
	}

	if (options.bodyFile === "-") {
		return readFileSync(0, "utf8");
	}

	try {
		return readFileSync(options.bodyFile, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read --body-file ${options.bodyFile}: ${message}`);
	}
}
