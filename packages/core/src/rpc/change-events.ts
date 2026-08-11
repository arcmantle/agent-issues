import type { ServerResponse } from "node:http";

/**
 * Per-tenant SSE broadcaster (ADR13's "change-notification channel"): after
 * each committed `PgStore` write dispatched through the JSON-RPC gate, only
 * subscribers for that write's tenant (ADR9) receive a `snapshot-changed`
 * event - matching the shape the site's local `/events` live-refresh
 * consumer already expects (`packages/cli/src/site/server.ts`).
 */
export class ChangeEventBroadcaster {
	private readonly subscribersByTenant = new Map<string, Set<ServerResponse>>();

	subscribe(tenantId: string, response: ServerResponse): () => void {
		let subscribers = this.subscribersByTenant.get(tenantId);
		if (!subscribers) {
			subscribers = new Set();
			this.subscribersByTenant.set(tenantId, subscribers);
		}
		subscribers.add(response);

		return () => {
			subscribers.delete(response);
			if (subscribers.size === 0) {
				this.subscribersByTenant.delete(tenantId);
			}
		};
	}

	publishSnapshotChanged(tenantId: string): void {
		const subscribers = this.subscribersByTenant.get(tenantId);
		if (!subscribers || subscribers.size === 0) {
			return;
		}

		const payload = JSON.stringify({ type: "snapshot-changed", at: new Date().toISOString() });
		for (const subscriber of subscribers) {
			subscriber.write(`data: ${payload}\n\n`);
		}
	}
}
