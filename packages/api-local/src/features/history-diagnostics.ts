import { EMPTY_HISTORY_MATERIALIZATION_DEPTHS, type HistoryMaterializationDepths, type HistoryRecordKind } from "@agent-issues/core";

import type { SqliteExecutor } from "../db/sqlite-executor.js";

const depthsByDatabase = new WeakMap<object, HistoryMaterializationDepths>();

export function getHistoryMaterializationDepths(executor: SqliteExecutor): HistoryMaterializationDepths {
	const existing = depthsByDatabase.get(executor.db);
	if (existing) {
		return existing;
	}

	const depths = { ...EMPTY_HISTORY_MATERIALIZATION_DEPTHS };
	depthsByDatabase.set(executor.db, depths);
	return depths;
}

export function recordHistoryMaterialization(executor: SqliteExecutor, kind: HistoryRecordKind, headRevision: number, targetRevision: number): void {
	const depths = getHistoryMaterializationDepths(executor);
	depths[kind] = Math.max(depths[kind], headRevision - targetRevision);
}
