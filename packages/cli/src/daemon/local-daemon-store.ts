import { spawn as spawnChildProcess } from "node:child_process";

import {
	callDaemonWithVersionHandshakeRetry,
	ensureDaemonRunning,
	type CallDaemonWithVersionHandshakeRetryOptions
} from "./daemon-lifecycle.js";
import { HttpStore, resolveWellKnownLocalTenantId, type HttpStoreOptions } from "@agent-issues/core";
import { readDaemonToken, type DaemonTokenStoreOptions } from "@agent-issues/api-local";

/**
 * Hidden argv flag a self-respawned daemon process recognizes (ISS190): the
 * CLI's entrypoint checks for this before ordinary command dispatch and
 * runs the daemon instead of a normal command. Exported so core and the CLI
 * entrypoint agree on the exact same literal without either hardcoding it
 * independently.
 */
export const LOCAL_DAEMON_SPAWN_FLAG = "--agent-issues-run-daemon";

/**
 * Default `spawn` for the local daemon (ISS190, ADR44): re-invokes this
 * exact running script (`process.argv[1]`) as a detached, unref'd child
 * with the hidden daemon flag appended. Core has no knowledge of which
 * package's entrypoint is actually running - it doesn't need to, since
 * "this same install, running itself again in daemon mode" always resolves
 * correctly regardless of which CLI/site-server process happened to invoke
 * it. When `dbPath` is supplied (a client requesting a different `--db`
 * than the currently-running daemon serves), it's appended so the freshly
 * spawned daemon opens that db instead of the default.
 */
export function spawnLocalDaemon(options?: { dbPath?: string }): void {
	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot spawn the local daemon: no process entrypoint (process.argv[1]) is available.");
	}

	const args = [entrypoint, LOCAL_DAEMON_SPAWN_FLAG];
	if (options?.dbPath !== undefined) {
		args.push("--db", options.dbPath);
	}

	spawnChildProcess(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
}

export type LocalDaemonStoreOptions = Omit<CallDaemonWithVersionHandshakeRetryOptions, "spawn"> & {
	/** Defaults to `spawnLocalDaemon` (curried with `dbPath`, below) when omitted; tests inject a fake spawn instead of launching a real child process. */
	spawn?: CallDaemonWithVersionHandshakeRetryOptions["spawn"];
	/**
	 * This process's own build-content-hash (ADR45); supplied by the CLI,
	 * since core cannot read the CLI package's own `dist/build-info.json`.
	 * Sent as a header on every request so the daemon can detect a stale
	 * connection and drain (ISS188).
	 */
	buildHash?: string;
	/**
	 * The db path this process wants the daemon to serve (ISS190). Sent as
	 * a header on every request so the daemon can detect it's fronting a
	 * different database and drain-then-respawn against this one instead;
	 * also threaded into the default `spawn` so a freshly-spawned daemon
	 * opens this db from its very first request.
	 */
	dbPath?: string;
	/** Pass-through to the native OS credential store reading the daemon's token (ADR46); tests inject a fake runner instead of touching a real native tool. */
	credentialStoreOptions?: DaemonTokenStoreOptions;
	/** The caller's workspace root, forwarded to the daemon on every RPC request so it resolves this workspace's project instead of the daemon process's cwd. */
	workspaceRoot?: string;
};

/**
 * An `HttpStore` pointed at the local daemon instead of the cloud API
 * (ISS190, ADR44): every call first resolves a live daemon port via
 * `ensureDaemonRunning` (cheap once the daemon is already up - it only
 * re-probes the cached state file) and, if that daemon turns out to be
 * running a stale build or fronting the wrong db, retries exactly once
 * against a freshly-spawned one via `callDaemonWithVersionHandshakeRetry`
 * (ISS188, ADR45; ISS190), re-pointing its own `baseUrl` at whichever port
 * the retry resolves to. The retry also re-reads the daemon token before
 * resending: a freshly-spawned daemon mints and persists its own new token
 * independently (ISS184), so the token this store was originally opened
 * with is stale the moment a respawn actually happens.
 */
export class LocalDaemonStore extends HttpStore {
	public constructor(private readonly lifecycleOptions: LocalDaemonStoreOptions, httpOptions: Omit<HttpStoreOptions, "baseUrl">) {
		// `baseUrl` is a placeholder - `call()` always re-resolves and
		// overwrites it with the live daemon's actual port before use.
		super({ ...httpOptions, baseUrl: "http://127.0.0.1:0" });
	}

	protected override async call<T>(method: string, params?: unknown): Promise<T> {
		const dbPath = this.lifecycleOptions.dbPath;
		let attempt = 0;
		return callDaemonWithVersionHandshakeRetry(
			{ ...this.lifecycleOptions, spawn: this.lifecycleOptions.spawn ?? (() => spawnLocalDaemon({ dbPath })) },
			async (port) => {
				if (attempt > 0) {
					const freshToken = await readDaemonToken(this.lifecycleOptions.credentialStoreOptions);
					if (freshToken) this.options.bearerToken = freshToken;
				}
				attempt++;

				this.options.baseUrl = `http://127.0.0.1:${port}`;
				return super.call<T>(method, params);
			}
		);
	}
}

/**
 * Ensures a local daemon is running (ISS189) and returns a `LocalDaemonStore`
 * authenticated with its own minted token (ISS184). Throws if the daemon is
 * reachable but no token can be read - a daemon without a readable token is
 * unusable, since every subsequent request would be rejected as
 * unauthenticated anyway.
 */
export async function openLocalDaemonStore(options?: LocalDaemonStoreOptions): Promise<LocalDaemonStore> {
	const lifecycleOptions: CallDaemonWithVersionHandshakeRetryOptions = {
		...options,
		spawn: options?.spawn ?? (() => spawnLocalDaemon({ dbPath: options?.dbPath }))
	};
	await ensureDaemonRunning(lifecycleOptions);

	const token = await readDaemonToken(options?.credentialStoreOptions);
	if (!token) {
		throw new Error("Local daemon is running but no daemon token was found in the OS credential store.");
	}

	return new LocalDaemonStore(lifecycleOptions, {
		bearerToken: token,
		tenantId: resolveWellKnownLocalTenantId(),
		buildHash: options?.buildHash,
		dbPath: options?.dbPath,
		workspaceRoot: options?.workspaceRoot
	});
}
