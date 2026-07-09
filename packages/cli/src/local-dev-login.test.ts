import { describe, expect, it } from "vitest";

import { issueLocalDevSession } from "./local-dev-login.js";

describe("issueLocalDevSession", () => {
	it("issues a session whose accessToken validates back to the same identity", async () => {
		const session = await issueLocalDevSession({ tenantId: "local-dev", userId: "user-1", secret: "test-secret" });

		expect(session.tenantId).toBe("local-dev");
		expect(session.userId).toBe("user-1");
		expect(typeof session.accessToken).toBe("string");
		expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
	});
});
