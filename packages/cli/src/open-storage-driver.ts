import { HttpStore, type StorageDriver } from "@agent-issues/core";
import { openLocalDaemonStore, openSqliteStore, resolveDatabasePath, type LocalDaemonStoreOptions, type DatabaseLocationOptions } from "@agent-issues/api-local";
import { getActiveSavedLogin, type SavedLoginStoreOptions } from "./auth-session.js";
import { BUILD_MODE } from "./build-mode.js";
import { spawnLocalDaemon } from "./daemon/local-daemon-store.js";
import { resolveProjectIdentity } from "./project-identity.js";

export type OpenStorageDriverOptions = {
	/** Only used when the active login is local. */
	dbPath?: string;
	databaseOptions?: DatabaseLocationOptions;
	authSessionOptions?: SavedLoginStoreOptions;
	/** Injectable for tests; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/**
	 * Local-daemon routing overrides (ISS190, ADR44): all optional and
	 * defaulted for production use (real spawn, real OS credential store).
	 * Tests override these so no real background process or credential
	 * tool is ever touched.
	 */
	localDaemon?: LocalDaemonStoreOptions;
};

export type OpenStorageDriverResult = {
	store: StorageDriver;
	backend: "local" | "cloud";
	/** The SQLite file path in local mode, or the cloud API base URL in cloud mode - kept as one field so callers that already echo it keep the same output shape (ADR13). */
	dbPath: string;
	/**
	 * Only set when `backend` is `"cloud"` - the raw base URL/bearer token
	 * behind the `HttpStore` this call opened. Ordinary `StorageDriver`
	 * callers never need this; it exists for the site server's `/events`
	 * relay (ISS56), which must subscribe to the cloud API's own SSE channel
	 * directly rather than through a `StorageDriver` method.
	 */
	cloudConnection?: { baseUrl: string; bearerToken: string; tenantId: string };
	/**
	 * Set only when the local daemon could not be spawned/reached and this
	 * call fell back to a direct in-process `SqliteStore` instead (ISS190's
	 * escape hatch). Callers that print CLI output should surface this so
	 * the fallback is visible rather than silent - a hard failure would be
	 * worse than a slower direct-SQLite command.
	 */
	daemonFallbackWarning?: string;
};

const NO_DAEMON_ENV_VAR = "AGENT_ISSUES_NO_DAEMON";

export function assertNoDaemonAllowed(
	env: Record<string, string | undefined>,
	buildMode: "development" | "production" = BUILD_MODE
): void {
	if (env[NO_DAEMON_ENV_VAR] === "1" && buildMode === "production") {
		throw new Error(`${NO_DAEMON_ENV_VAR} is only available in development builds.`);
	}
}

/** Exported for `openSynchronizeStores`, which enforces the same saved-login expiry precondition. */
export function isSessionExpired(expiresAt: string): boolean {
	return Date.parse(expiresAt) <= Date.now();
}

/**
 * Opens a `StorageDriver` for the globally active saved login: a daemon-routed
 * `LocalDaemonStore` for local (falling back to direct SQLite), or an
 * authenticated `HttpStore` for remote. Callers do not choose the destination.
 */
export async function openStorageDriver(options: OpenStorageDriverOptions = {}): Promise<OpenStorageDriverResult> {
	const env = options.env ?? process.env;
	assertNoDaemonAllowed(env);

	const currentWorkingDirectory = options.databaseOptions?.currentWorkingDirectory ?? process.cwd();
	const { identity: projectIdentity } = resolveProjectIdentity(currentWorkingDirectory);
	const activeLogin = await getActiveSavedLogin(options.authSessionOptions);

	if (activeLogin.kind === "local") {
		const dbPath = resolveDatabasePath(options.dbPath, options.databaseOptions);

		if (env[NO_DAEMON_ENV_VAR] === "1") {
			const { store } = await openSqliteStore(options.dbPath, { ...options.databaseOptions, projectIdentity });
			return { store, backend: "local", dbPath };
		}

		try {
			const store = await openLocalDaemonStore({
				...options.localDaemon,
				spawn: options.localDaemon?.spawn ?? (() => spawnLocalDaemon({ dbPath: options.localDaemon?.dbPath ?? dbPath })),
				dbPath: options.localDaemon?.dbPath ?? dbPath,
				projectIdentity,
				workspaceRoot: currentWorkingDirectory
			});
			return { store, backend: "local", dbPath };
		} catch (error) {
			const { store } = await openSqliteStore(options.dbPath, { ...options.databaseOptions, projectIdentity });
			const message = error instanceof Error ? error.message : String(error);
			return {
				store,
				backend: "local",
				dbPath,
				daemonFallbackWarning: `Could not reach the local daemon (${message}); falling back to direct SQLite access.`
			};
		}
	}

	if (isSessionExpired(activeLogin.expiresAt)) {
		throw new Error(
			`Saved login "${activeLogin.name}" has expired. Run "agent-issues auth login --name ${activeLogin.name} --url ${activeLogin.serviceUrl}" to refresh it.`
		);
	}

	const store = new HttpStore({
		baseUrl: activeLogin.serviceUrl,
		bearerToken: activeLogin.accessToken,
		tenantId: activeLogin.tenantId,
		projectIdentity
	});
	return {
		store,
		backend: "cloud",
		dbPath: activeLogin.serviceUrl,
		cloudConnection: { baseUrl: activeLogin.serviceUrl, bearerToken: activeLogin.accessToken, tenantId: activeLogin.tenantId }
	};
}
