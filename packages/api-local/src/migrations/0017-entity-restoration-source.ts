import { addEntityRestorationSourceColumn, type Migration } from "@agent-issues/core";

export const entityRestorationSourceMigration: Migration = {
	id: "0017-entity-restoration-source",
	up: addEntityRestorationSourceColumn
};