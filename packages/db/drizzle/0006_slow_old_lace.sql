CREATE TABLE `browser_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`origin` text NOT NULL,
	`jpeg` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `browser_artifacts_run_idx` ON `browser_artifacts` (`run_id`);--> statement-breakpoint
ALTER TABLE `profiles` ADD `browser_json` text DEFAULT '{"mode":"off","allowedOrigins":[],"localOrigins":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `browser_access` text DEFAULT 'off' NOT NULL;