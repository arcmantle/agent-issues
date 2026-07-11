import type { AuthSessionStoreOptions } from "./auth-session.js";
import { listAuthSessions } from "./auth-session.js";
import { resolveBackendSelection } from "./backend-selection.js";
import type { CloudBindingStoreOptions } from "./cloud-binding.js";
import type { DatabaseLocationOptions } from "./database.js";
import { HttpStore } from "./http-store.js";
import { resolveProjectIdentity } from "./project-identity.js";
import { openSqliteStore } from "./sqlite-store.js";
import type { StorageDriver } from "./storage-driver.js";

export type OpenStorageDriverOptions = {
	/** Only used for the local backend; ignored when the project resolves to cloud. */
	dbPath?: string;
	databaseOptions?: DatabaseLocationOptions;
	cloudBindingOptions?: CloudBindingStoreOptions;
	authSessionOptions?: AuthSessionStoreOptions;
	/** Injectable for tests; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
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
};

/** Exported for `openSynchronizeStores` (ISS59), which enforces the same cloud-session precondition on both stores it opens. */
export function isSessionExpired(expiresAt: string): boolean {
	return Date.parse(expiresAt) <= Date.now();
}

/**
 * The single seam-boundary entry point (ADR13, ADR18) that turns a resolved
 * backend selection into an open `StorageDriver`: `SqliteStore` for local,
 * `HttpStore` (bearer token resolved from the cached auth session for the
 * binding's tenant, ISS32) for cloud. Callers never branch on backend
 * themselves - they call this once and get back whichever store applies.
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
		const { store, dbPath } = await openSqliteStore(options.dbPath, options.databaseOptions);
		return { store, backend: "local", dbPath };
	}

	const { binding } = selection;
	const session = listAuthSessions(options.authSessionOptions).find((candidate) => candidate.tenantId === binding.tenantId);

	if (!session || isSessionExpired(session.expiresAt)) {
		throw new Error(
			`Project is cloud-bound to tenant "${binding.tenantId}" but there is no valid cached session. Run "agent-issues auth login" first.`
		);
	}

	const store = new HttpStore({ baseUrl: binding.cloudApiUrl, bearerToken: session.accessToken, tenantId: binding.tenantId });
	return {
		store,
		backend: "cloud",
		dbPath: binding.cloudApiUrl,
		cloudConnection: { baseUrl: binding.cloudApiUrl, bearerToken: session.accessToken, tenantId: binding.tenantId }
	};
}
