import { addContextRestorationSourceColumns, type Migration } from "@agent-issues/core";

export const contextRestorationSourceMigration: Migration = {
	id: "0018-context-restoration-source",
	up: addContextRestorationSourceColumns
};