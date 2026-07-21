import { EMPTY_HISTORY_MATERIALIZATION_DEPTHS, type HistoryMaterializationDepths, type HistoryRecordKind } from "@agent-issues/core";
import type { Pool } from "pg";

const depthsByPool = new WeakMap<Pool, Map<string, HistoryMaterializationDepths>>();

export function getHistoryMaterializationDepths(pool: Pool, tenantId: string): HistoryMaterializationDepths {
	let depthsByTenant = depthsByPool.get(pool);
	if (!depthsByTenant) {
		depthsByTenant = new Map();
		depthsByPool.set(pool, depthsByTenant);
	}

	const existing = depthsByTenant.get(tenantId);
	if (existing) {
		return existing;
	}

	const depths = { ...EMPTY_HISTORY_MATERIALIZATION_DEPTHS };
	depthsByTenant.set(tenantId, depths);
	return depths;
}

export function recordHistoryMaterialization(pool: Pool, tenantId: string, kind: HistoryRecordKind, headRevision: number, targetRevision: number): void {
	const depths = getHistoryMaterializationDepths(pool, tenantId);
	depths[kind] = Math.max(depths[kind], headRevision - targetRevision);
}
