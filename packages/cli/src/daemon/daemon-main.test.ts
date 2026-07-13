import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runDaemonProcess } from "./daemon-main.js";

const createLocalDaemonServerMock = vi.hoisted(() => vi.fn());
vi.mock("./local-daemon-server.js", () => ({ createLocalDaemonServer: createLocalDaemonServerMock }));

/**
 * The self-respawned daemon process's real entrypoint (ISS190): what
 * `spawnLocalDaemon` (`@agent-issues/core`) actually launches. Kept
 * intentionally thin - just starts the real daemon server and lets the
 * event loop (the listening HTTP server) keep the process alive; the
 * daemon's own idle-timeout/drain-then-exit logic is what eventually calls
 * `process.exit`, already covered by `local-daemon-server.test.ts`.
 */
describe("runDaemonProcess (ISS190)", () => {
	beforeEach(() => {
		createLocalDaemonServerMock.mockClear();
	});

	it("starts the real local daemon server with no auth-provider override, so it mints its own token", () => {
		createLocalDaemonServerMock.mockReturnValue({ server: { address: () => ({ port: 0 }) as AddressInfo } });

		runDaemonProcess();

		expect(createLocalDaemonServerMock).toHaveBeenCalledOnce();
		const [options] = createLocalDaemonServerMock.mock.calls[0] as [Record<string, unknown>];
		expect(options.authProvider).toBeUndefined();
	});

	it("forwards a --db <path> argv flag as the server's dbPath (ISS190)", () => {
		createLocalDaemonServerMock.mockReturnValue({ server: { address: () => ({ port: 0 }) as AddressInfo } });
		const originalArgv = process.argv;
		process.argv = [...originalArgv.slice(0, 2), "--agent-issues-run-daemon", "--db", "/tmp/other.db"];

		try {
			runDaemonProcess();
		} finally {
			process.argv = originalArgv;
		}

		const [options] = createLocalDaemonServerMock.mock.calls[0] as [Record<string, unknown>];
		expect(options.dbPath).toBe("/tmp/other.db");
	});

	it("leaves dbPath undefined when no --db flag is present in argv", () => {
		createLocalDaemonServerMock.mockReturnValue({ server: { address: () => ({ port: 0 }) as AddressInfo } });
		const originalArgv = process.argv;
		process.argv = [...originalArgv.slice(0, 2), "--agent-issues-run-daemon"];

		try {
			runDaemonProcess();
		} finally {
			process.argv = originalArgv;
		}

		const [options] = createLocalDaemonServerMock.mock.calls[0] as [Record<string, unknown>];
		expect(options.dbPath).toBeUndefined();
	});
});
