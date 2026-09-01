import { HttpStore, resolveWellKnownLocalTenantId, type HttpStoreOptions } from "@agent-issues/core";
import { readDaemonToken, type DaemonTokenStoreOptions } from "../auth/daemon-token.js";
import {
	callDaemonWithVersionHandshakeRetry,
	ensureDaemonRunning,
	type CallDaemonWithVersionHandshakeRetryOptions
} from "./daemon-lifecycle.js";

export type LocalDaemonStoreOptions = Omit<CallDaemonWithVersionHandshakeRetryOptions, "spawn"> & {
	spawn?: CallDaemonWithVersionHandshakeRetryOptions["spawn"];
	buildHash?: string;
	dbPath?: string;
	credentialStoreOptions?: DaemonTokenStoreOptions;
	workspaceRoot?: string;
	projectIdentity?: string;
	correlationId?: string;
};

type ResolvedLocalDaemonStoreOptions = LocalDaemonStoreOptions & Pick<CallDaemonWithVersionHandshakeRetryOptions, "spawn">;

export class LocalDaemonStore extends HttpStore {
	public constructor(lifecycleOptions: ResolvedLocalDaemonStoreOptions, httpOptions: Omit<HttpStoreOptions, "baseUrl">) {
		super({ ...httpOptions, baseUrl: "http://127.0.0.1:0" });
		this.lifecycleOptions = lifecycleOptions;
	}

	protected lifecycleOptions: ResolvedLocalDaemonStoreOptions;

	protected override async call<T>(method: string, params?: unknown): Promise<T> {
		const dbPath = this.lifecycleOptions.dbPath;
		let attempt = 0;
		return callDaemonWithVersionHandshakeRetry(this.lifecycleOptions, async (port) => {
			if (attempt > 0) {
				const freshToken = await readDaemonToken({ ...this.lifecycleOptions.credentialStoreOptions, dbPath });
				if (freshToken) this.options.bearerToken = freshToken;
			}
			attempt++;
			this.options.baseUrl = `http://127.0.0.1:${port}`;
			return super.call<T>(method, params);
		});
	}
}

export async function openLocalDaemonStore(options: LocalDaemonStoreOptions): Promise<LocalDaemonStore> {
	const lifecycleOptions: ResolvedLocalDaemonStoreOptions = {
		...options,
		spawn: options.spawn ?? (() => {
			throw new Error("Cannot start the local daemon because no spawn function was supplied.");
		})
	};
	await ensureDaemonRunning(lifecycleOptions);
	const token = await readDaemonToken({ ...options.credentialStoreOptions, dbPath: options.dbPath });
	if (!token) throw new Error("Local daemon is running but no daemon token was found in the OS credential store.");

	return new LocalDaemonStore(lifecycleOptions, {
		bearerToken: token,
		tenantId: resolveWellKnownLocalTenantId(),
		buildHash: options.buildHash,
		correlationId: options.correlationId,
		dbPath: options.dbPath,
		projectIdentity: options.projectIdentity,
		workspaceRoot: options.workspaceRoot
	});
}