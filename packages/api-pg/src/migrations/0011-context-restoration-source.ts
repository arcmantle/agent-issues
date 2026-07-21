import { addContextRestorationSourceColumns } from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

export const contextRestorationSourceMigration: Migration = {
	id: "0011-context-restoration-source",
	up: addContextRestorationSourceColumns
};