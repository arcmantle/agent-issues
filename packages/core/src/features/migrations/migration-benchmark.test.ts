import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MIGRATION_BENCHMARK } from "./migration-benchmark.js";

describe("migration benchmark contract", () => {
	it("keeps the checked-in review summary synchronized with executable thresholds", () => {
		const summary = readFileSync(new URL("../../../../../docs/migration-benchmark.md", import.meta.url), "utf8");

		expect(summary).toContain(`| SQLite fresh | ${MIGRATION_BENCHMARK.sqlite.fresh.backups} | ${MIGRATION_BENCHMARK.sqlite.fresh.legacyTransforms} |`);
		expect(summary).toContain(`| SQLite current-final | ${MIGRATION_BENCHMARK.sqlite.currentFinal.backups} | ${MIGRATION_BENCHMARK.sqlite.currentFinal.legacyTransforms} |`);
		expect(summary).toContain(`| SQLite legacy v7 | ${MIGRATION_BENCHMARK.sqlite.legacyV7.backups} | ${MIGRATION_BENCHMARK.sqlite.legacyV7.legacyTransforms} |`);
		expect(summary).toContain(`| Postgres legacy v7, ${MIGRATION_BENCHMARK.postgres.legacyV7.fixtureCopies[0]} fixture copy | ${MIGRATION_BENCHMARK.postgres.legacyV7.statementCounts[0]} |`);
		expect(summary).toContain(`| Postgres legacy v7, ${MIGRATION_BENCHMARK.postgres.legacyV7.fixtureCopies[1]} fixture copies | ${MIGRATION_BENCHMARK.postgres.legacyV7.statementCounts[1]} |`);
	});
});