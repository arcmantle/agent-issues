import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveAgentIssuesHomeDirectory } from "./database.js";

export type AuthSession = {
	tenantId: string;
	userId: string;
	displayName?: string;
	accessToken: string;
	expiresAt: string;
};

/** An AuthSession with the raw accessToken redacted - safe to print or log. */
export type AuthSessionView = Omit<AuthSession, "accessToken">;

/** Strips the raw accessToken so callers can safely display or log a session. */
export function toAuthSessionView(session: AuthSession): AuthSessionView {
	const { accessToken: _accessToken, ...view } = session;
	return view;
}

export type AuthSessionStoreOptions = {
	/**
	 * Overrides the directory the session file lives under. Production
	 * defaults to `resolveAgentIssuesHomeDirectory()` (`~/.agent-issues`);
	 * tests inject a temp directory so no real user state is touched.
	 */
	homeDirectory?: string;
};

const AUTH_SESSION_FILENAME = "auth.json";

type AuthSessionFileShape = {
	currentTenantId?: string;
	sessions: Record<string, AuthSession>;
};

function resolveAuthSessionFilePath(options?: AuthSessionStoreOptions): string {
	const homeDirectory = options?.homeDirectory ?? resolveAgentIssuesHomeDirectory();
	return path.join(homeDirectory, AUTH_SESSION_FILENAME);
}

function readAuthSessionFile(options?: AuthSessionStoreOptions): AuthSessionFileShape {
	const filePath = resolveAuthSessionFilePath(options);
	if (!existsSync(filePath)) return { sessions: {} };

	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return { sessions: {} };

		const { currentTenantId, sessions } = parsed as Partial<AuthSessionFileShape>;
		return {
			currentTenantId: typeof currentTenantId === "string" ? currentTenantId : undefined,
			sessions: sessions && typeof sessions === "object" ? sessions : {}
		};
	} catch {
		return { sessions: {} };
	}
}

function writeAuthSessionFile(file: AuthSessionFileShape, options?: AuthSessionStoreOptions): void {
	const filePath = resolveAuthSessionFilePath(options);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** Persists a session and makes it the current tenant. */
export function saveAuthSession(session: AuthSession, options?: AuthSessionStoreOptions): void {
	const file = readAuthSessionFile(options);
	file.sessions[session.tenantId] = session;
	file.currentTenantId = session.tenantId;
	writeAuthSessionFile(file, options);
}

/** Returns the current tenant's cached session, or undefined if none is set. */
export function getCurrentAuthSession(options?: AuthSessionStoreOptions): AuthSession | undefined {
	const file = readAuthSessionFile(options);
	if (!file.currentTenantId) return undefined;
	return file.sessions[file.currentTenantId];
}

/** Returns every cached session, regardless of which one is current. */
export function listAuthSessions(options?: AuthSessionStoreOptions): AuthSession[] {
	return Object.values(readAuthSessionFile(options).sessions);
}

/**
 * Removes a tenant's cached session. If it was the current tenant, clears
 * the current pointer too (there is no cached session left to fall back to).
 */
export function removeAuthSession(tenantId: string, options?: AuthSessionStoreOptions): void {
	const file = readAuthSessionFile(options);
	delete file.sessions[tenantId];
	if (file.currentTenantId === tenantId) {
		file.currentTenantId = undefined;
	}
	writeAuthSessionFile(file, options);
}

/**
 * Switches the current tenant pointer to an already-cached session, without
 * touching its accessToken (no re-auth needed to switch between tenants
 * that are both already logged in).
 */
export function switchAuthSession(tenantId: string, options?: AuthSessionStoreOptions): AuthSession {
	const file = readAuthSessionFile(options);
	const session = file.sessions[tenantId];
	if (!session) {
		throw new Error(`No cached auth session for tenant "${tenantId}". Run "agent-issues auth login" first.`);
	}

	file.currentTenantId = tenantId;
	writeAuthSessionFile(file, options);
	return session;
}
