CREATE TABLE `project_migrations` (
	`tenant_id` text NOT NULL,
	`legacy_tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `legacy_tenant_id`)
);
