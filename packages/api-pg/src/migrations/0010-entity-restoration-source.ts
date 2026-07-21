import { addEntityRestorationSourceColumn } from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

export const entityRestorationSourceMigration: Migration = {
	id: "0010-entity-restoration-source",
	up: addEntityRestorationSourceColumn
};