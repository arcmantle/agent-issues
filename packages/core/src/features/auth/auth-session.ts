import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { resolveAgentIssuesHomeDirectory } from "../entity-store/database.js";
import { getCredential, setCredential, type OsCredentialStoreOptions } from "../../utilities/os-credential-store.js";

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

export type AuthSessionStoreOptions = OsCredentialStoreOptions & {
	/**
	 * Overrides the directory checked for a pre-ISS185 plain-file session
	 * cache to migrate from. Production defaults to
	 * `resolveAgentIssuesHomeDirectory()` (`~/.agent-issues`); tests inject a
	 * temp directory so no real user state is touched.
	 */
	homeDirectory?: string;
};

const SERVICE = "agent-issues-auth";
const ACCOUNT = "sessions";
const LEGACY_AUTH_SESSION_FILENAME = "auth.json";

type AuthSessionFileShape = {
	currentTenantId?: string;
	sessions: Record<string, AuthSession>;
};

function resolveLegacyAuthSessionFilePath(options?: AuthSessionStoreOptions): string {
	const homeDirectory = options?.homeDirectory ?? resolveAgentIssuesHomeDirectory();
	return path.join(homeDirectory, LEGACY_AUTH_SESSION_FILENAME);
}

function parseAuthSessionFileShape(raw: string): AuthSessionFileShape {
	try {
		const parsed: unknown = JSON.parse(raw);
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

/**
 * Reads the cached sessions blob from the native OS credential store
 * (ISS185, ADR46). The very first read after upgrading past ISS185 instead
 * finds a pre-existing plain-file cache (if any) at the legacy location,
 * imports it into the credential store once, and deletes the plain file -
 * so upgrading users are not forced to re-authenticate.
 */
async function readAuthSessionFile(options?: AuthSessionStoreOptions): Promise<AuthSessionFileShape> {
	const stored = await getCredential(SERVICE, ACCOUNT, options);
	if (stored !== undefined) {
		return parseAuthSessionFileShape(stored);
	}

	const legacyFilePath = resolveLegacyAuthSessionFilePath(options);
	if (!existsSync(legacyFilePath)) {
		return { sessions: {} };
	}

	const legacyFile = parseAuthSessionFileShape(readFileSync(legacyFilePath, "utf8"));
	await setCredential(SERVICE, ACCOUNT, JSON.stringify(legacyFile), options);
	rmSync(legacyFilePath, { force: true });
	return legacyFile;
}

async function writeAuthSessionFile(file: AuthSessionFileShape, options?: AuthSessionStoreOptions): Promise<void> {
	await setCredential(SERVICE, ACCOUNT, JSON.stringify(file), options);
}

/** Persists a session and makes it the current tenant. */
export async function saveAuthSession(session: AuthSession, options?: AuthSessionStoreOptions): Promise<void> {
	const file = await readAuthSessionFile(options);
	file.sessions[session.tenantId] = session;
	file.currentTenantId = session.tenantId;
	await writeAuthSessionFile(file, options);
}

/** Returns the current tenant's cached session, or undefined if none is set. */
export async function getCurrentAuthSession(options?: AuthSessionStoreOptions): Promise<AuthSession | undefined> {
	const file = await readAuthSessionFile(options);
	if (!file.currentTenantId) return undefined;
	return file.sessions[file.currentTenantId];
}

/** Returns every cached session, regardless of which one is current. */
export async function listAuthSessions(options?: AuthSessionStoreOptions): Promise<AuthSession[]> {
	return Object.values((await readAuthSessionFile(options)).sessions);
}

/**
 * Removes a tenant's cached session. If it was the current tenant, clears
 * the current pointer too (there is no cached session left to fall back to).
 */
export async function removeAuthSession(tenantId: string, options?: AuthSessionStoreOptions): Promise<void> {
	const file = await readAuthSessionFile(options);
	delete file.sessions[tenantId];
	if (file.currentTenantId === tenantId) {
		file.currentTenantId = undefined;
	}
	await writeAuthSessionFile(file, options);
}

/**
 * Switches the current tenant pointer to an already-cached session, without
 * touching its accessToken (no re-auth needed to switch between tenants
 * that are both already logged in).
 */
export async function switchAuthSession(tenantId: string, options?: AuthSessionStoreOptions): Promise<AuthSession> {
	const file = await readAuthSessionFile(options);
	const session = file.sessions[tenantId];
	if (!session) {
		throw new Error(`No cached auth session for tenant "${tenantId}". Run "agent-issues auth login" first.`);
	}

	file.currentTenantId = tenantId;
	await writeAuthSessionFile(file, options);
	return session;
}
