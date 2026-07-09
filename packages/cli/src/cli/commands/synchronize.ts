import { openSynchronizeStores, synchronizeStores } from "@agent-issues/core";

import { renderSynchronize } from "../renderers.js";
import { BaseCommand } from "../shared.js";

/**
 * The explicit, user-invoked `synchronize` command (ISS41/ISS59, ADR15,
 * ADR16): converges the current project's local `SqliteStore` and cloud
 * `HttpStore` by merging their append-only history logs, resolving any
 * concurrent same-record edit by last-writer-wins. Never a background
 * process - one run, one report.
 */
export class SynchronizeCommand extends BaseCommand {
	public static paths = [["synchronize"]];

	public async execute(): Promise<number> {
		const { local, cloud, binding } = await openSynchronizeStores({ databaseOptions: { currentWorkingDirectory: this.context.cwd } });

		try {
			const summary = await synchronizeStores(local, cloud);
			const result = { command: "synchronize" as const, cloudApiUrl: binding.cloudApiUrl, tenantId: binding.tenantId, summary };

			this.print(result, renderSynchronize(result));
			return 0;
		} finally {
			await local.close();
			await cloud.close();
		}
	}
}
