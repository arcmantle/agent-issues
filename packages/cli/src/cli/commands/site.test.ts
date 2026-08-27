import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { launchDetachedLiveSite } from "./site.js";

describe("launchDetachedLiveSite", () => {
	it("spawns a detached foreground server and returns after the OS accepts the child", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		child.unref = vi.fn();
		const spawnProcess = vi.fn(() => {
			queueMicrotask(() => child.emit("spawn"));
			return child;
		});

		const result = await launchDetachedLiveSite(
			{ cwd: "/workspace", dbPath: "/workspace/issues.db", entryPoint: "/workspace/cli.js", port: 4317 },
			spawnProcess
		);

		expect(spawnProcess).toHaveBeenCalledWith(
			process.execPath,
			["/workspace/cli.js", "site", "--foreground", "--port", "4317", "--db", "/workspace/issues.db"],
			expect.objectContaining({ cwd: "/workspace", detached: true, stdio: "ignore" })
		);
		expect(child.unref).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ port: 4317, started: true, url: "http://127.0.0.1:4317" });
	});

	it("reports an immediate spawn failure", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		child.unref = vi.fn();
		const spawnProcess = vi.fn(() => {
			queueMicrotask(() => child.emit("error", new Error("spawn failed")));
			return child;
		});

		await expect(
			launchDetachedLiveSite({ cwd: "/workspace", entryPoint: "/workspace/cli.js", port: 4317 }, spawnProcess)
		).rejects.toThrow("spawn failed");
		expect(child.unref).not.toHaveBeenCalled();
	});
});