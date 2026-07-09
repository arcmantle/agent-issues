CREATE TABLE `context_terms` (
	`tenant_id` text NOT NULL,
	`context_key` text NOT NULL,
	`term` text NOT NULL,
	`definition` text NOT NULL,
	`avoid_terms` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `context_key`, `term`),
	FOREIGN KEY (`tenant_id`,`context_key`) REFERENCES `contexts`(`tenant_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_terms_tenant_context_key_idx` ON `context_terms` (`tenant_id`,`context_key`);--> statement-breakpoint
CREATE TABLE `contexts` (
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`scope_entity_id` text,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `key`),
	FOREIGN KEY (`tenant_id`,`scope_entity_id`) REFERENCES `entities`(`tenant_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contexts_tenant_scope_entity_id_idx` ON `contexts` (`tenant_id`,`scope_entity_id`) WHERE scope_entity_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `counters` (
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`next_value` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`body_source` text DEFAULT 'authored' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `handoffs` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`entity_id` text NOT NULL,
	`initiative_id` text,
	`summary` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`,`entity_id`) REFERENCES `entities`(`tenant_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`,`initiative_id`) REFERENCES `entities`(`tenant_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `handoffs_tenant_initiative_id_idx` ON `handoffs` (`tenant_id`,`initiative_id`);--> statement-breakpoint
CREATE INDEX `handoffs_tenant_entity_id_idx` ON `handoffs` (`tenant_id`,`entity_id`);--> statement-breakpoint
CREATE TABLE `metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relations` (
	`tenant_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `from_id`, `to_id`, `type`),
	FOREIGN KEY (`tenant_id`,`from_id`) REFERENCES `entities`(`tenant_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`,`to_id`) REFERENCES `entities`(`tenant_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relations_tenant_to_id_idx` ON `relations` (`tenant_id`,`to_id`);