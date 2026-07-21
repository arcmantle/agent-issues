import { seedContextRevisionBaselines } from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

export const contextRevisionBaselinesMigration: Migration = {
	id: "0012-context-revision-baselines",
	up: seedContextRevisionBaselines
};