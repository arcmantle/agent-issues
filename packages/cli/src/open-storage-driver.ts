import { HttpStore, type StorageDriver } from "@agent-issues/core";
import { openSqliteStore, resolveDatabasePath, type DatabaseLocationOptions } from "@agent-issues/api-local";
import { listAuthSessions, type AuthSessionStoreOptions } from "./auth-session.js";
import { resolveBackendSelection } from "./backend-selection.js";
import type { CloudBindingStoreOptions } from "./cloud-binding.js";
import { openLocalDaemonStore, type LocalDaemonStoreOptions } from "./daemon/local-daemon-store.js";
import { resolveProjectIdentity } from "./project-identity.js";

export type OpenStorageDriverOptions = {
	/** Only used for the local backend; ignored when the project resolves to cloud. */
	dbPath?: string;
	databaseOptions?: DatabaseLocationOptions;
	cloudBindingOptions?: CloudBindingStoreOptions;
	authSessionOptions?: AuthSessionStoreOptions;
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

/** Exported for `openSynchronizeStores` (ISS59), which enforces the same cloud-session precondition on both stores it opens. */
export function isSessionExpired(expiresAt: string): boolean {
	return Date.parse(expiresAt) <= Date.now();
}

/**
 * The single seam-boundary entry point (ADR13, ADR18) that turns a resolved
 * backend selection into an open `StorageDriver`: a daemon-routed
 * `LocalDaemonStore` for local (falling back to a direct `SqliteStore` via
 * `AGENT_ISSUES_NO_DAEMON=1` or on a daemon spawn/connect failure, ISS190,
 * ADR44), `HttpStore` (bearer token resolved from the cached auth session
 * for the binding's tenant, ISS32) for cloud. Callers never branch on
 * backend themselves - they call this once and get back whichever store
 * applies.
 */
export async function openStorageDriver(options: OpenStorageDriverOptions = {}): Promise<OpenStorageDriverResult> {
	const currentWorkingDirectory = options.databaseOptions?.currentWorkingDirectory ?? process.cwd();
	const { identity: projectIdentity } = resolveProjectIdentity(currentWorkingDirectory);

	const selection = resolveBackendSelection({
		projectIdentity,
		env: options.env,
		...options.cloudBindingOptions
	});

	if (selection.backend === "local") {
		const dbPath = resolveDatabasePath(options.dbPath, options.databaseOptions);
		const env = options.env ?? process.env;

		if (env[NO_DAEMON_ENV_VAR] === "1") {
			const { store } = await openSqliteStore(options.dbPath, options.databaseOptions);
			return { store, backend: "local", dbPath };
		}

		try {
			const store = await openLocalDaemonStore({
				...options.localDaemon,
				dbPath: options.localDaemon?.dbPath ?? dbPath,
				workspaceRoot: currentWorkingDirectory
			});
			return { store, backend: "local", dbPath };
		} catch (error) {
			const { store } = await openSqliteStore(options.dbPath, options.databaseOptions);
			const message = error instanceof Error ? error.message : String(error);
			return {
				store,
				backend: "local",
				dbPath,
				daemonFallbackWarning: `Could not reach the local daemon (${message}); falling back to direct SQLite access.`
			};
		}
	}

	const { binding } = selection;
	const session = (await listAuthSessions(options.authSessionOptions)).find((candidate) => candidate.tenantId === binding.tenantId);

	if (!session || isSessionExpired(session.expiresAt)) {
		throw new Error(
			`Project is cloud-bound to tenant "${binding.tenantId}" but there is no valid cached session. Run "agent-issues auth login" first.`
		);
	}

	const store = new HttpStore({
		baseUrl: binding.cloudApiUrl,
		bearerToken: session.accessToken,
		tenantId: binding.tenantId,
		projectIdentity
	});
	return {
		store,
		backend: "cloud",
		dbPath: binding.cloudApiUrl,
		cloudConnection: { baseUrl: binding.cloudApiUrl, bearerToken: session.accessToken, tenantId: binding.tenantId }
	};
}
