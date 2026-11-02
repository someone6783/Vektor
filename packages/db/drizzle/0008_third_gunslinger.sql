CREATE TABLE `computer_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`action_id` text NOT NULL,
	`action` text NOT NULL,
	`stage` text NOT NULL,
	`jpeg` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `computer_artifacts_run_idx` ON `computer_artifacts` (`run_id`);