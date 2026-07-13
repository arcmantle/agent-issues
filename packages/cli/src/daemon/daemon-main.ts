import { createLocalDaemonServer } from "./local-daemon-server.js";

/**
 * Parses an optional `--db <path>` out of argv (appended by `spawnLocalDaemon`,
 * `@agent-issues/core`, when a client requested a different db than the
 * currently-running daemon serves, ISS190) so a respawned daemon opens the
 * newly-requested db from its very first request instead of the default.
 */
function parseDbPathArg(argv: string[]): string | undefined {
	const flagIndex = argv.indexOf("--db");
	if (flagIndex === -1) return undefined;
	return argv[flagIndex + 1];
}

/**
 * The real entrypoint a self-respawned daemon process runs (ISS190,
 * ADR44): `spawnLocalDaemon` (`@agent-issues/core`) re-invokes this same
 * installed CLI with a hidden flag, and `cli.ts` recognizes that flag and
 * calls this instead of dispatching a normal command. No `authProvider`
 * override, so the daemon mints and persists its own token (ISS184); no
 * explicit `buildHash`, so it reads its own `dist/build-info.json`
 * (ISS188). The process stays alive because the daemon's own listening
 * HTTP server keeps the event loop open - it only exits via the daemon's
 * own idle-timeout or version/db-path-mismatch drain-then-exit.
 */
export function runDaemonProcess(): void {
	createLocalDaemonServer({ dbPath: parseDbPathArg(process.argv) });
}
