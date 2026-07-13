import type { AuthSessionStoreOptions } from "../auth/auth-session.js";
import { listAuthSessions } from "../auth/auth-session.js";
import { resolveBackendSelection } from "../cloud/backend-selection.js";
import type { CloudBinding, CloudBindingStoreOptions } from "../cloud/cloud-binding.js";
import type { DatabaseLocationOptions } from "../entity-store/database.js";
import { HttpStore } from "../storage-driver/http-store.js";
import { isSessionExpired } from "../storage-driver/open-storage-driver.js";
import { resolveProjectIdentity } from "../cloud/project-identity.js";
import { openSqliteStore } from "../storage-driver/sqlite-store.js";
import type { StorageDriver } from "../storage-driver/storage-driver.js";

export type OpenSynchronizeStoresOptions = {
	/** Only used for the local backend; ignored otherwise. */
	dbPath?: string;
	databaseOptions?: DatabaseLocationOptions;
	cloudBindingOptions?: CloudBindingStoreOptions;
	authSessionOptions?: AuthSessionStoreOptions;
	/** Injectable for tests; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
};

export type OpenSynchronizeStoresResult = {
	local: StorageDriver;
	cloud: StorageDriver;
	binding: CloudBinding;
};

/**
 * The seam-boundary entry point synchronize (ISS59) uses instead of
 * `openStorageDriver`: unlike every other command, synchronize always needs
 * BOTH the local `SqliteStore` and the cloud `HttpStore` open at once,
 * rather than picking one per the project's backend selection. Requires an
 * actual cloud binding (forcing `resolveBackendSelection`'s cloud path, so a
 * missing binding throws the exact same "agent-issues cloud bind" error
 * every other cloud-mode command already throws) and a valid cached session
 * for that binding's tenant (same "agent-issues auth login" error
 * `openStorageDriver` throws).
 */
export async function openSynchronizeStores(options: OpenSynchronizeStoresOptions = {}): Promise<OpenSynchronizeStoresResult> {
	const currentWorkingDirectory = options.databaseOptions?.currentWorkingDirectory ?? process.cwd();
	const { identity: projectIdentity } = resolveProjectIdentity(currentWorkingDirectory);

	const selection = resolveBackendSelection({
		projectIdentity,
		explicitBackend: "cloud",
		env: options.env,
		...options.cloudBindingOptions
	});

	if (selection.backend !== "cloud") {
		// Unreachable: `explicitBackend: "cloud"` either returns a cloud
		// selection or throws. Narrows the type for the rest of this function.
		throw new Error("Expected a cloud backend selection.");
	}

	const { binding } = selection;
	const session = (await listAuthSessions(options.authSessionOptions)).find((candidate) => candidate.tenantId === binding.tenantId);

	if (!session || isSessionExpired(session.expiresAt)) {
		throw new Error(
			`Project is cloud-bound to tenant "${binding.tenantId}" but there is no valid cached session. Run "agent-issues auth login" first.`
		);
	}

	const { store: local } = await openSqliteStore(options.dbPath, options.databaseOptions);
	const cloud = new HttpStore({ baseUrl: binding.cloudApiUrl, bearerToken: session.accessToken, tenantId: binding.tenantId });

	return { local, cloud, binding };
}
