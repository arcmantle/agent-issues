import { readFileSync } from "node:fs";
import type { Writable } from "node:stream";

import { Command, Option, type BaseContext } from "clipanion";

import { openStorageDriver, type ContextDirectoryView, type DatabaseLocationOptions, type StorageDriver } from "@agent-issues/core";

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
	public prettyJson = Option.Boolean("--pretty", false);

	protected print(payload: object, text: string) {
		printOutput(this.context.stdout, this.asJson, this.prettyJson, payload, text);
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

/**
 * Opens the storage-driver seam for one command invocation and closes it
 * afterwards, replacing the repeated `ensureDatabase` + try/finally pattern
 * every command used before the seam existed (ADR11, ADR13). Delegates to
 * `openStorageDriver` (ADR18) to pick `SqliteStore` or `HttpStore` per the
 * resolved backend, so commands never branch on backend themselves. Hands
 * the resolved `dbPath` back too, since a few commands echo it in their
 * output (the cloud API URL in cloud mode, per `OpenStorageDriverResult`).
 */
export async function withStore<T>(
	dbPath: string | undefined,
	options: DatabaseLocationOptions | undefined,
	fn: (store: StorageDriver, dbPath: string) => Promise<T>
): Promise<T> {
	const { store, dbPath: resolvedDbPath } = await openStorageDriver({ dbPath, databaseOptions: options });

	try {
		return await fn(store, resolvedDbPath);
	} finally {
		await store.close();
	}
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

export function stringifyJson(value: unknown, pretty: boolean): string {
	return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

export function printOutput(output: Writable, asJson: boolean, prettyJson: boolean, payload: object, text: string) {
	if (asJson) {
		output.write(`${stringifyJson(payload, prettyJson)}\n`);
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
