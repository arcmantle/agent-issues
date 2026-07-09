CREATE TABLE `history_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer NOT NULL,
	`author` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`body_source` text NOT NULL,
	`status` text NOT NULL,
	`parent_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_entries_tenant_entity_version_idx` ON `history_entries` (`tenant_id`,`entity_id`,`version`);