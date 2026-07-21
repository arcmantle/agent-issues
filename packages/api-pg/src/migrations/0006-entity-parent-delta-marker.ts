import { addEntityParentDeltaMarker } from "@agent-issues/core";

import type { Migration } from "../db/migration-runner.js";

export const entityParentDeltaMarkerMigration: Migration = {
	id: "0006-entity-parent-delta-marker",
	up: addEntityParentDeltaMarker
};