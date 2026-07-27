import { HttpStore, type StorageDriver } from "@agent-issues/core";
import { openSqliteStore, type DatabaseLocationOptions } from "@agent-issues/api-local";
import { getActiveSavedLogin, type SavedLoginStoreOptions } from "./auth-session.js";
import { isSessionExpired } from "./open-storage-driver.js";
import { resolveProjectIdentity } from "./project-identity.js";

export type OpenSynchronizeStoresOptions = {
	/** The local source database path. */
	dbPath?: string;
	databaseOptions?: DatabaseLocationOptions;
	authSessionOptions?: SavedLoginStoreOptions;
};

export type OpenSynchronizeStoresResult = {
	local: StorageDriver;
	cloud: StorageDriver;
	destination: { name: string; serviceUrl: string; tenantId: string };
};

/**
 * Opens the local source and the globally active remote saved login as the
 * synchronization destination. Synchronization cannot target the local login
 * because its source is already local.
 */
export async function openSynchronizeStores(options: OpenSynchronizeStoresOptions = {}): Promise<OpenSynchronizeStoresResult> {
	const currentWorkingDirectory = options.databaseOptions?.currentWorkingDirectory ?? process.cwd();
	const { identity: projectIdentity } = resolveProjectIdentity(currentWorkingDirectory);
	const activeLogin = await getActiveSavedLogin(options.authSessionOptions);

	if (activeLogin.kind === "local") {
		throw new Error('Synchronization requires an active remote saved login. Run "agent-issues auth switch <name>" or "agent-issues auth login" first.');
	}

	if (isSessionExpired(activeLogin.expiresAt)) {
		throw new Error(
			`Saved login "${activeLogin.name}" has expired. Run "agent-issues auth login --name ${activeLogin.name} --url ${activeLogin.serviceUrl}" to refresh it.`
		);
	}

	const { store: local } = await openSqliteStore(options.dbPath, { ...options.databaseOptions, projectIdentity });
	const cloud = new HttpStore({
		baseUrl: activeLogin.serviceUrl,
		bearerToken: activeLogin.accessToken,
		tenantId: activeLogin.tenantId,
		projectIdentity
	});

	return {
		local,
		cloud,
		destination: { name: activeLogin.name, serviceUrl: activeLogin.serviceUrl, tenantId: activeLogin.tenantId }
	};
}
