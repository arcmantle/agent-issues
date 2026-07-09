DROP INDEX `history_entries_tenant_entity_version_idx`;--> statement-breakpoint
CREATE INDEX `history_entries_tenant_entity_version_idx` ON `history_entries` (`tenant_id`,`entity_id`,`version`);