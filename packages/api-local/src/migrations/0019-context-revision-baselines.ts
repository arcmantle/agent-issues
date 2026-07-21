import { seedContextRevisionBaselines, type Migration } from "@agent-issues/core";

export const contextRevisionBaselinesMigration: Migration = {
	id: "0019-context-revision-baselines",
	up: seedContextRevisionBaselines
};