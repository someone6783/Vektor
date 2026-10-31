CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`run_id` text,
	`occurrence_key` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `scheduled_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_runs_occurrence_idx` ON `job_runs` (`job_id`,`occurrence_key`);--> statement-breakpoint
CREATE INDEX `job_runs_run_idx` ON `job_runs` (`run_id`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`schedule` text NOT NULL,
	`cron` text NOT NULL,
	`timezone` text NOT NULL,
	`profile_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`prompt` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`catch_up` integer DEFAULT false NOT NULL,
	`include_history` integer DEFAULT false NOT NULL,
	`allow_truncation` integer DEFAULT false NOT NULL,
	`next_run_at` integer,
	`lease_owner` text,
	`lease_until` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`last_status` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scheduled_jobs_due_idx` ON `scheduled_jobs` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `scheduler_lease` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `include_history` integer DEFAULT true NOT NULL;
