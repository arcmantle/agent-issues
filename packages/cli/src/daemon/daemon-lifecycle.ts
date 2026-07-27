import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";

import { DaemonHandshakeMismatchError } from "@agent-issues/core";
import { readDaemonState, resolveDaemonFilePath, type DaemonState, type DaemonStateStoreOptions } from "@agent-issues/api-local";

/**
 * Probes whether a local daemon is actually reachable on `port`, via a bare
 * TCP connect - no HTTP request, no auth/version handshake (those are
 * ISS184/ISS188's concern, layered on top once a connection succeeds). Used
 * to decide whether a state file's advertised `port` still points at a live
 * process before reusing it, since the process that wrote it may have died
 * without cleaning up (crash, kill -9, etc).
 */
export function isDaemonReachable(port: number, options?: { host?: string; timeoutMs?: number }): Promise<boolean> {
	const host = options?.host ?? "127.0.0.1";
	const timeoutMs = options?.timeoutMs ?? 500;

	return new Promise((resolve) => {
		const socket = new Socket();

		const finish = (reachable: boolean) => {
			socket.destroy();
			resolve(reachable);
		};

		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.connect(port, host);
	});
}

function resolveDaemonSpawnLockFilePath(options?: DaemonStateStoreOptions): string {
	// Keyed the same way `daemon-state.ts`'s state file is (ISS192), so a
	// spawn race is only ever resolved between callers targeting the SAME
	// db path - a caller for a different db path never waits on another
	// db's in-flight spawn.
	return resolveDaemonFilePath("daemon", ".lock", options);
}

/**
 * Exclusive-creates a lockfile (`wx` flag - fails if it already exists) so
 * only one of several near-simultaneous callers gets to spawn a daemon; a
 * losing caller gets `false` back and should instead poll the state file
 * (`readDaemonState`) for the winner's daemon to finish starting up.
 */
export function tryAcquireDaemonSpawnLock(options?: DaemonStateStoreOptions): boolean {
	const filePath = resolveDaemonSpawnLockFilePath(options);
	try {
		writeFileSync(filePath, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

function reclaimAbandonedDaemonSpawnLock(options?: DaemonStateStoreOptions): boolean {
	const filePath = resolveDaemonSpawnLockFilePath(options);
	try {
		const ownerPid = Number.parseInt(readFileSync(filePath, "utf8"), 10);
		if (Number.isInteger(ownerPid) && ownerPid > 0) {
			try {
				process.kill(ownerPid, 0);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
			}
		} else if (Date.now() - statSync(filePath).mtimeMs < 1000) {
			return false;
		}

		unlinkSync(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Releases a previously-acquired spawn lock. Safe to call even if no lock is held. */
export function releaseDaemonSpawnLock(options?: DaemonStateStoreOptions): void {
	const filePath = resolveDaemonSpawnLockFilePath(options);
	if (existsSync(filePath)) {
		unlinkSync(filePath);
	}
}

export type EnsureDaemonRunningOptions = DaemonStateStoreOptions & {
	/**
	 * Starts the daemon process (expected to be a detached, unref'd spawn -
	 * see `openUrl` in `site/server.ts` for the established pattern). Fire
	 * and forget: `ensureDaemonRunning` learns the daemon is up by polling
	 * for its state file, not from this function's return value. Core has
	 * no knowledge of the CLI's own entrypoint, so callers must supply it.
	 */
	spawn: () => void;
	/** Total time to wait for a reachable daemon state to appear after losing or winning the spawn race. Default 5000ms. */
	waitTimeoutMs?: number;
	/** Interval between polls while waiting. Default 50ms. */
	pollIntervalMs?: number;
};

export type EnsureDaemonRunningResult = {
	port: number;
	/** True only if this call is the one that actually invoked `spawn` (as opposed to reusing a live daemon or waiting out a concurrent caller's spawn). */
	spawned: boolean;
};

async function waitForReachableDaemonState(
	options: Pick<EnsureDaemonRunningOptions, "homeDirectory" | "waitTimeoutMs" | "pollIntervalMs">,
): Promise<DaemonState> {
	const waitTimeoutMs = options.waitTimeoutMs ?? 5000;
	const pollIntervalMs = options.pollIntervalMs ?? 50;
	const deadline = Date.now() + waitTimeoutMs;

	for (;;) {
		const state = readDaemonState(options);
		if (state && (await isDaemonReachable(state.port))) return state;

		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for a reachable local daemon after ${waitTimeoutMs}ms`);
		}

		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

/**
 * Ties the state file, liveness probe, and spawn-race lock together into a
 * single "give me a live daemon's port" call (ADR44): reuses an already-
 * running daemon when its recorded state file still points at a reachable
 * port, otherwise spawns a new one - unless another caller is already
 * spawning, in which case this call waits for that caller's daemon instead
 * of starting a redundant second process.
 */
export async function ensureDaemonRunning(options: EnsureDaemonRunningOptions): Promise<EnsureDaemonRunningResult> {
	const existing = readDaemonState(options);
	if (existing && (await isDaemonReachable(existing.port))) {
		return { port: existing.port, spawned: false };
	}

	let ownsSpawnLock = tryAcquireDaemonSpawnLock(options);
	if (!ownsSpawnLock && reclaimAbandonedDaemonSpawnLock(options)) {
		ownsSpawnLock = tryAcquireDaemonSpawnLock(options);
	}

	if (!ownsSpawnLock) {
		try {
			const state = await waitForReachableDaemonState(options);
			return { port: state.port, spawned: false };
		} catch (error) {
			if (!reclaimAbandonedDaemonSpawnLock(options) || !tryAcquireDaemonSpawnLock(options)) throw error;
			ownsSpawnLock = true;
		}
	}

	try {
		options.spawn();
		const state = await waitForReachableDaemonState(options);
		return { port: state.port, spawned: true };
	} finally {
		releaseDaemonSpawnLock(options);
	}
}

export type CallDaemonWithVersionHandshakeRetryOptions = EnsureDaemonRunningOptions & {
	/** Interval to poll whether the stale daemon has become unreachable. Default 50ms. */
	drainPollIntervalMs?: number;
	/** Total time to wait for the stale daemon to finish draining before giving up on the retry. Default 5000ms. */
	drainTimeoutMs?: number;
};

async function waitForDaemonToDrain(
	port: number,
	options: Pick<CallDaemonWithVersionHandshakeRetryOptions, "drainPollIntervalMs" | "drainTimeoutMs">,
): Promise<void> {
	const pollIntervalMs = options.drainPollIntervalMs ?? 50;
	const timeoutMs = options.drainTimeoutMs ?? 5000;
	const deadline = Date.now() + timeoutMs;

	while (await isDaemonReachable(port)) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for the stale local daemon on port ${port} to finish draining after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

/**
 * The client-side half of the version/db-path handshake (ISS188/ADR45,
 * ISS190): calls `ensureDaemonRunning` for a port and attempts `sendRequest`
 * against it. A `DaemonHandshakeMismatchError` (build-hash stale, or fronting
 * the wrong db) means the daemon this call reached is incompatible with what
 * this process wants - rather than hard-killing it (it may be mid-request
 * for another terminal), it's already draining (ADR45's drain-then-exit).
 * This waits for that daemon to actually become unreachable, then calls
 * `ensureDaemonRunning` again - which naturally spawns a fresh one, since the
 * stale daemon and its state file are now gone - and retries the request
 * exactly once against the new daemon. Any other error propagates
 * immediately, untouched.
 */
export async function callDaemonWithVersionHandshakeRetry<T>(
	options: CallDaemonWithVersionHandshakeRetryOptions,
	sendRequest: (port: number) => Promise<T>,
): Promise<T> {
	const first = await ensureDaemonRunning(options);
	try {
		return await sendRequest(first.port);
	} catch (error) {
		if (!(error instanceof DaemonHandshakeMismatchError)) throw error;

		await waitForDaemonToDrain(first.port, options);
		const retried = await ensureDaemonRunning(options);
		return sendRequest(retried.port);
	}
}

