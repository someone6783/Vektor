ALTER TABLE `runs` ADD `provider` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `provider_calls` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `job_id` text;
--> statement-breakpoint
UPDATE `runs` SET `job_id` = (SELECT `job_id` FROM `job_runs` WHERE `job_runs`.`run_id` = `runs`.`id` LIMIT 1);
