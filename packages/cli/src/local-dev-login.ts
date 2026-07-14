import { LocalAuthProvider } from "@agent-issues/api-pg";

import type { DeviceCodeLoginResult } from "./cli/commands/auth.js";

/**
 * Local dev login (ADR21's client-side leg): issues a locally-signed dev
 * credential via `LocalAuthProvider` with no network call and no Azure
 * tenant. Unlike `entra-device-login.ts`, this has no HITL boundary - it is
 * fully deterministic and unit-tested, since there is no external identity
 * provider or human browser step involved. For local development and AFK
 * testing of the cloud auth path only; requires an explicit `secret` so it
 * can never be reached without an opt-in.
 */
export async function issueLocalDevSession(options: {
	tenantId: string;
	userId: string;
	secret: string;
	expiresInSeconds?: number;
}): Promise<DeviceCodeLoginResult> {
	const provider = new LocalAuthProvider({ secret: options.secret });
	const accessToken = await provider.issueToken(
		{ userId: options.userId, tenantId: options.tenantId },
		options.expiresInSeconds
	);
	const expiresAt = new Date(Date.now() + (options.expiresInSeconds ?? 3600) * 1000).toISOString();

	return {
		tenantId: options.tenantId,
		userId: options.userId,
		accessToken,
		expiresAt
	};
}
