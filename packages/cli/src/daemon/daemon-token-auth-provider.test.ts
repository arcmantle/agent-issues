import { describe, expect, it } from "vitest";

import { DaemonTokenAuthProvider } from "./daemon-token-auth-provider.js";

describe("DaemonTokenAuthProvider (ISS184)", () => {
	it("resolves to the well-known local tenant identity when the bearer token matches the daemon's own token", async () => {
		const provider = new DaemonTokenAuthProvider({ token: "the-daemon-token", tenantId: "local-alice" });

		await expect(provider.validateToken("the-daemon-token")).resolves.toEqual({ userId: "local", tenantId: "local-alice" });
	});

	it("accepts a 'Bearer <token>' prefixed header value", async () => {
		const provider = new DaemonTokenAuthProvider({ token: "the-daemon-token", tenantId: "local-alice" });

		await expect(provider.validateToken("Bearer the-daemon-token")).resolves.toEqual({ userId: "local", tenantId: "local-alice" });
	});

	it("rejects a token that does not match the daemon's own token", async () => {
		const provider = new DaemonTokenAuthProvider({ token: "the-daemon-token", tenantId: "local-alice" });

		await expect(provider.validateToken("some-other-token")).rejects.toThrow();
	});

	it("rejects a token whose length differs from the real token", async () => {
		const provider = new DaemonTokenAuthProvider({ token: "the-daemon-token", tenantId: "local-alice" });

		await expect(provider.validateToken("short")).rejects.toThrow();
	});
});
