import { userInfo } from "node:os";

import { Option } from "clipanion";

import {
	getCurrentAuthSession,
	removeAuthSession,
	saveAuthSession,
	switchAuthSession,
	toAuthSessionView,
	type AuthSession,
	type AuthSessionStoreOptions
} from "@agent-issues/core";

import { renderAuthLogin, renderAuthLogout, renderAuthStatus, renderAuthSwitch } from "../renderers.js";
import { BaseCommand, requireOption, requirePositional } from "../shared.js";

export type DeviceCodeLoginResult = {
	tenantId: string;
	userId: string;
	displayName?: string;
	accessToken: string;
	expiresAt: string;
};

/** Reports the human-readable device-code instructions Entra returns (e.g. "go to microsoft.com/devicelogin and enter code ABCD-EFGH"). */
export type DeviceCodePrompt = (message: string) => void;

/**
 * Runs the interactive Entra ID device-code exchange and resolves the
 * identity + token it produced. The real implementation
 * (`../../entra-device-login.js`) is the genuine HITL gap this repo cannot
 * exercise: it requires a human to complete a device-code login in a
 * browser against a real Azure tenant (ISS32's acceptance criteria).
 */
export type DeviceCodeLoginFn = (options: {
	tenantId: string;
	clientId: string;
	onDeviceCode: DeviceCodePrompt;
}) => Promise<DeviceCodeLoginResult>;

/**
 * Orchestrates login end to end: run the device-code exchange, then persist
 * the resulting session as current. Kept standalone from `AuthLoginCommand`
 * so tests can inject a fake `deviceCodeLogin` and verify the orchestration
 * (prompt forwarding, session persistence) without a real Azure tenant.
 */
export async function performLogin(
	options: { tenantId: string; clientId: string },
	deviceCodeLogin: DeviceCodeLoginFn,
	onDeviceCode: DeviceCodePrompt,
	storeOptions?: AuthSessionStoreOptions
): Promise<AuthSession> {
	const result = await deviceCodeLogin({ tenantId: options.tenantId, clientId: options.clientId, onDeviceCode });
	const session: AuthSession = {
		tenantId: result.tenantId,
		userId: result.userId,
		displayName: result.displayName,
		accessToken: result.accessToken,
		expiresAt: result.expiresAt
	};

	saveAuthSession(session, storeOptions);
	return session;
}

export class AuthLoginCommand extends BaseCommand {
	public static paths = [["auth", "login"]];

	public local = Option.Boolean("--local", false);
	public tenantId = Option.String("--tenant-id");
	public clientId = Option.String("--client-id");
	public userId = Option.String("--user-id");
	public secret = Option.String("--secret");

	public async execute(): Promise<number> {
		const session = this.local ? await this.loginLocal() : await this.loginEntra();

		const view = toAuthSessionView(session);
		this.print({ command: "auth-login" as const, session: view }, renderAuthLogin(view));
		return 0;
	}

	private async loginEntra(): Promise<AuthSession> {
		const tenantId = requireOption(
			this.tenantId ?? process.env.AGENT_ISSUES_ENTRA_TENANT_ID,
			"`auth login` requires --tenant-id (or AGENT_ISSUES_ENTRA_TENANT_ID). See docs/auth-entra-id-setup.md."
		);
		const clientId = requireOption(
			this.clientId ?? process.env.AGENT_ISSUES_ENTRA_CLIENT_ID,
			"`auth login` requires --client-id (or AGENT_ISSUES_ENTRA_CLIENT_ID). See docs/auth-entra-id-setup.md."
		);

		const { acquireEntraDeviceCodeSession } = await import("../../entra-device-login.js");

		return performLogin({ tenantId, clientId }, acquireEntraDeviceCodeSession, (message) => {
			this.context.stdout.write(`${message}\n`);
		});
	}

	private async loginLocal(): Promise<AuthSession> {
		const tenantId = this.tenantId ?? process.env.AGENT_ISSUES_LOCAL_AUTH_TENANT_ID ?? "local-dev";
		const userId = this.userId ?? process.env.AGENT_ISSUES_LOCAL_AUTH_USER_ID ?? userInfo().username;
		const secret = requireOption(
			this.secret ?? process.env.AGENT_ISSUES_LOCAL_AUTH_SECRET,
			"`auth login --local` requires --secret (or AGENT_ISSUES_LOCAL_AUTH_SECRET). See docs/local-dev-setup.md."
		);

		const { issueLocalDevSession } = await import("../../local-dev-login.js");

		const localDevLogin: DeviceCodeLoginFn = ({ tenantId: sessionTenantId }) =>
			issueLocalDevSession({ tenantId: sessionTenantId, userId, secret });

		return performLogin({ tenantId, clientId: "local" }, localDevLogin, () => {});
	}
}

export class AuthLogoutCommand extends BaseCommand {
	public static paths = [["auth", "logout"]];

	public tenantId = Option.String("--tenant-id");

	public async execute(): Promise<number> {
		const current = getCurrentAuthSession();
		const tenantId = this.tenantId ?? current?.tenantId;

		if (!tenantId) {
			this.print({ command: "auth-logout" as const, loggedOut: false }, "Not logged in.");
			return 0;
		}

		removeAuthSession(tenantId);
		this.print({ command: "auth-logout" as const, loggedOut: true, tenantId }, renderAuthLogout(tenantId));
		return 0;
	}
}

export class AuthStatusCommand extends BaseCommand {
	public static paths = [["auth", "status"]];

	public async execute(): Promise<number> {
		const current = getCurrentAuthSession();

		if (!current) {
			this.print(
				{ command: "auth-status" as const, loggedIn: false },
				"Not logged in. Run `agent-issues auth login --tenant-id <id> --client-id <id>`."
			);
			return 0;
		}

		const view = toAuthSessionView(current);
		this.print({ command: "auth-status" as const, loggedIn: true, session: view }, renderAuthStatus(view));
		return 0;
	}
}

export class AuthSwitchCommand extends BaseCommand {
	public static paths = [["auth", "switch"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		const tenantId = requirePositional(this.positionals, 0, "auth switch <tenantId>");
		const session = switchAuthSession(tenantId);
		const view = toAuthSessionView(session);
		this.print({ command: "auth-switch" as const, session: view }, renderAuthSwitch(view));
		return 0;
	}
}
