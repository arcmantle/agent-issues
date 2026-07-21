import { addEntityParentDeltaMarker, type Migration } from "@agent-issues/core";

export const entityParentDeltaMarkerMigration: Migration = {
	id: "0013-entity-parent-delta-marker",
	up: addEntityParentDeltaMarker
};