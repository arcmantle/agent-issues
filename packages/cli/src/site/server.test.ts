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
