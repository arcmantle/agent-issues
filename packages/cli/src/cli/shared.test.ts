import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));

afterEach(() => {
	mocks.readFile.mockReset();
});

describe("resolveMarkdownFileOption", () => {
	it("retries a body-file read after EAGAIN", async () => {
		const error = Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
		mocks.readFile.mockRejectedValueOnce(error).mockResolvedValueOnce("Body text");

		expect(await resolveMarkdownFileOption("body.md", "--body-file")).toBe("Body text");
		expect(mocks.readFile).toHaveBeenCalledTimes(2);
	});

	it("reads all piped stdin chunks", async () => {
		async function* pipe(): AsyncGenerator<string> {
			yield "## Purpose\n\n";
			yield "Piped body text\n";
		}

		expect(await resolveMarkdownFileOption("-", "--body-file", pipe())).toBe("## Purpose\n\nPiped body text\n");
	});
});

const openStorageDriverMock = vi.hoisted(() => vi.fn());
vi.mock("../open-storage-driver.js", () => ({ openStorageDriver: openStorageDriverMock }));

const readBuildContentHashMock = vi.hoisted(() => vi.fn(() => "test-build-hash"));
vi.mock("@agent-issues/api-local", () => ({ readBuildContentHash: readBuildContentHashMock }));

const { resolveMarkdownFileOption, withStore } = await import("./shared.js");

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
