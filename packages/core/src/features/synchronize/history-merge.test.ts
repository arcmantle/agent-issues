import { describe, expect, it } from "vitest";

import type { HistoryEntryRecord } from "../entity-store/domain.js";
import { entitiesNeedingLiveCacheUpdate, mergeHistoryLogs } from "./history-merge.js";

function entry(overrides: Partial<HistoryEntryRecord> & Pick<HistoryEntryRecord, "id" | "entityId" | "version" | "createdAt">): HistoryEntryRecord {
	return {
		author: "system",
		title: "Untitled",
		body: "",
		bodySource: "authored",
		status: "todo",
		parentId: null,
		...overrides
	};
}

describe("mergeHistoryLogs", () => {
	it("unions disjoint entries from both sides without dropping any", () => {
		const local = [entry({ id: "h1", entityId: "ISS1", version: 1, createdAt: "2024-01-01T00:00:00.000Z" })];
		const cloud = [entry({ id: "h2", entityId: "ISS2", version: 1, createdAt: "2024-01-01T00:00:00.000Z" })];

		const { union } = mergeHistoryLogs(local, cloud);

		expect(union.map((e) => e.id).sort()).toEqual(["h1", "h2"]);
	});

	it("deduplicates entries present on both sides by id", () => {
		const shared = entry({ id: "h1", entityId: "ISS1", version: 1, createdAt: "2024-01-01T00:00:00.000Z" });

		const { union } = mergeHistoryLogs([shared], [shared]);

		expect(union).toHaveLength(1);
	});

	it("is idempotent: merging an already-unioned log with itself changes nothing", () => {
		const local = [
			entry({ id: "h1", entityId: "ISS1", version: 1, createdAt: "2024-01-01T00:00:00.000Z" }),
			entry({ id: "h2", entityId: "ISS1", version: 2, createdAt: "2024-01-02T00:00:00.000Z" })
		];

		const first = mergeHistoryLogs(local, []);
		const second = mergeHistoryLogs(first.union, first.union);

		expect(second.union.map((e) => e.id).sort()).toEqual(first.union.map((e) => e.id).sort());
		expect(second.union).toHaveLength(first.union.length);
	});

	it("resolves the latest entry per entity by highest version", () => {
		const local = [
			entry({ id: "h1", entityId: "ISS1", version: 1, createdAt: "2024-01-01T00:00:00.000Z" }),
			entry({ id: "h2", entityId: "ISS1", version: 2, createdAt: "2024-01-02T00:00:00.000Z", title: "Newer" })
		];

		const { latestByEntity } = mergeHistoryLogs(local, []);

		expect(latestByEntity.get("ISS1")?.id).toBe("h2");
		expect(latestByEntity.get("ISS1")?.title).toBe("Newer");
	});

	it("breaks a concurrent-edit tie (same version) by newest createdAt, keeping the loser in the union", () => {
		const local = [entry({ id: "h1", entityId: "ISS1", version: 2, createdAt: "2024-01-02T00:00:00.000Z", title: "Local edit" })];
		const cloud = [entry({ id: "h2", entityId: "ISS1", version: 2, createdAt: "2024-01-03T00:00:00.000Z", title: "Cloud edit" })];

		const { union, latestByEntity } = mergeHistoryLogs(local, cloud);

		expect(latestByEntity.get("ISS1")?.id).toBe("h2");
		expect(latestByEntity.get("ISS1")?.title).toBe("Cloud edit");
		expect(union.map((e) => e.id).sort()).toEqual(["h1", "h2"]);
	});

	it("given two identical logs, reports zero entities needing a live-cache update", () => {
		const local = [entry({ id: "h1", entityId: "ISS1", version: 1, createdAt: "2024-01-01T00:00:00.000Z", title: "Same" })];

		const { latestByEntity } = mergeHistoryLogs(local, local);
		const currentFacts = new Map([
			["ISS1", { title: "Same", body: "", bodySource: "authored" as const, status: "todo", parentId: null }]
		]);

		expect(entitiesNeedingLiveCacheUpdate(latestByEntity, currentFacts)).toEqual([]);
	});

	it("reports an entity whose current facts differ from the resolved-latest entry", () => {
		const local = [entry({ id: "h1", entityId: "ISS1", version: 1, createdAt: "2024-01-01T00:00:00.000Z", title: "Resolved title" })];

		const { latestByEntity } = mergeHistoryLogs(local, []);
		const currentFacts = new Map([
			["ISS1", { title: "Stale title", body: "", bodySource: "authored" as const, status: "todo", parentId: null }]
		]);

		expect(entitiesNeedingLiveCacheUpdate(latestByEntity, currentFacts)).toEqual(["ISS1"]);
	});

	it("reports an entity with no current facts entry (new-to-this-side) as needing an update", () => {
		const local = [entry({ id: "h1", entityId: "ISS1", version: 1, createdAt: "2024-01-01T00:00:00.000Z" })];

		const { latestByEntity } = mergeHistoryLogs(local, []);

		expect(entitiesNeedingLiveCacheUpdate(latestByEntity, new Map())).toEqual(["ISS1"]);
	});
});
