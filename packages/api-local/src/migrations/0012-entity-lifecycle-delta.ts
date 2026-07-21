import { addEntityLifecycleDeltaColumns, type Migration } from "@agent-issues/core";

export const entityLifecycleDeltaMigration: Migration = {
	id: "0012-entity-lifecycle-delta",
	up: addEntityLifecycleDeltaColumns
};