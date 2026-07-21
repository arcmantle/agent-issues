import { addEntityLifecycleDeltaColumns } from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

export const entityLifecycleDeltaMigration: Migration = {
	id: "0005-entity-lifecycle-delta",
	up: addEntityLifecycleDeltaColumns
};