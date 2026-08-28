import { describe, expect, it, vi } from "vitest";

const openStorageDriverMock = vi.hoisted(() => vi.fn());
vi.mock("../open-storage-driver.js", () => ({ openStorageDriver: openStorageDriverMock }));

const readBuildContentHashMock = vi.hoisted(() => vi.fn(() => "test-build-hash"));
vi.mock("@agent-issues/api-local", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@agent-issues/api-local")>();
	return { ...actual, readBuildContentHash: readBuildContentHashMock };
});

const { startLiveSite } = await import("./server.js");

function fakeStore() {
	return { close: vi.fn(async () => {}), getSnapshotSignature: vi.fn(async () => "test-signature") } as never;
}

describe("startLiveSite (ISS190)", () => {
	it("forwards the provider search capability through the tenant-scoped site route", async () => {
		const getSearchCapability = vi.fn(async () => ({ state: "rebuilding" }));
		const store = {
			close: vi.fn(async () => {}),
			getSearchCapability,
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			listTenants: vi.fn(async () => [{ displayName: "Demo", id: "demo" }])
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/search/capability?tenant=demo`);

			expect(await response.json()).toEqual({ state: "rebuilding" });
			expect(getSearchCapability).toHaveBeenCalledOnce();
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("forwards a current-project search request and its final response", async () => {
		const responseBody = { results: [], state: "available" };
		const search = vi.fn(async () => responseBody);
		const store = {
			close: vi.fn(async () => {}),
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			search
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/search?query=roadmap&scope=current-project&project=PROJ1`);

			expect(await response.json()).toEqual(responseBody);
			expect(search).toHaveBeenCalledWith({ query: "roadmap", scope: { projectId: "PROJ1", type: "current-project" } });
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("rejects invalid search parameters before calling the storage provider", async () => {
		const search = vi.fn();
		const store = {
			close: vi.fn(async () => {}),
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			search
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/search?query=roadmap&scope=current-project&project=PROJ1&limit=0`);

			expect(response.status).toBe(400);
			expect(search).not.toHaveBeenCalled();
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("forwards all-project search filters and limits", async () => {
		const search = vi.fn(async () => ({ results: [], state: "unsupported" }));
		const store = {
			close: vi.fn(async () => {}),
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			search
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/search?query=roadmap&scope=all-projects&sourceTypes=entity,context&limit=20`);

			expect(await response.json()).toEqual({ results: [], state: "unsupported" });
			expect(search).toHaveBeenCalledWith({
				filters: { sourceTypes: ["entity", "context"] },
				limit: 20,
				query: "roadmap",
				scope: { type: "all-projects" }
			});
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("passes this install's build-content-hash to openStorageDriver's daemon routing", async () => {
		openStorageDriverMock.mockResolvedValue({ store: fakeStore(), dbPath: "/tmp/agent-issues.db", backend: "local" });

		const handle = await startLiveSite({ port: 0 });

		try {
			expect(openStorageDriverMock).toHaveBeenCalledWith(
				expect.objectContaining({ localDaemon: { buildHash: "test-build-hash" } })
			);
		} finally {
			handle.close();
		}
	});

	it("surfaces a visible warning on stderr when the daemon store falls back", async () => {
		openStorageDriverMock.mockResolvedValue({
			store: fakeStore(),
			dbPath: "/tmp/agent-issues.db",
			backend: "local",
			daemonFallbackWarning: "could not spawn the local daemon: boom"
		});
		const originalWrite = process.stderr.write.bind(process.stderr);
		const chunks: string[] = [];
		process.stderr.write = ((chunk: string) => {
			chunks.push(chunk.toString());
			return true;
		}) as typeof process.stderr.write;

		let handle;
		try {
			handle = await startLiveSite({ port: 0 });
		} finally {
			process.stderr.write = originalWrite;
		}

		expect(chunks.join("")).toContain("could not spawn the local daemon: boom");
		handle.close();
	});
});
