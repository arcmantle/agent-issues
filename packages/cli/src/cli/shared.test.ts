import { describe, expect, it, vi } from "vitest";

const openStorageDriverMock = vi.hoisted(() => vi.fn());
vi.mock("@agent-issues/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@agent-issues/core")>();
	return { ...actual, openStorageDriver: openStorageDriverMock };
});

const readBuildContentHashMock = vi.hoisted(() => vi.fn(() => "test-build-hash"));
vi.mock("../build-info.js", () => ({ readBuildContentHash: readBuildContentHashMock }));

const { withStore } = await import("./shared.js");

function fakeStore() {
	return { close: vi.fn(async () => {}) } as never;
}

describe("withStore (ISS190)", () => {
	it("passes this install's build-content-hash to openStorageDriver's daemon routing", async () => {
		openStorageDriverMock.mockResolvedValue({ store: fakeStore(), dbPath: "/tmp/agent-issues.db" });

		await withStore(undefined, undefined, async () => undefined);

		expect(openStorageDriverMock).toHaveBeenCalledWith(
			expect.objectContaining({ localDaemon: { buildHash: "test-build-hash" } })
		);
	});

	it("surfaces a visible warning on stderr when the daemon store falls back", async () => {
		openStorageDriverMock.mockResolvedValue({
			store: fakeStore(),
			dbPath: "/tmp/agent-issues.db",
			daemonFallbackWarning: "could not spawn the local daemon: boom"
		});
		const originalWrite = process.stderr.write.bind(process.stderr);
		const chunks: string[] = [];
		process.stderr.write = ((chunk: string) => {
			chunks.push(chunk.toString());
			return true;
		}) as typeof process.stderr.write;

		try {
			await withStore(undefined, undefined, async () => undefined);
		} finally {
			process.stderr.write = originalWrite;
		}

		expect(chunks.join("")).toContain("could not spawn the local daemon: boom");
	});

	it("stays silent when there is no fallback warning", async () => {
		openStorageDriverMock.mockResolvedValue({ store: fakeStore(), dbPath: "/tmp/agent-issues.db" });
		const originalWrite = process.stderr.write.bind(process.stderr);
		const chunks: string[] = [];
		process.stderr.write = ((chunk: string) => {
			chunks.push(chunk.toString());
			return true;
		}) as typeof process.stderr.write;

		try {
			await withStore(undefined, undefined, async () => undefined);
		} finally {
			process.stderr.write = originalWrite;
		}

		expect(chunks.join("")).toBe("");
	});
});
