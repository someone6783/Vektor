CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	`included` integer DEFAULT true NOT NULL,
	`extracted_text` text DEFAULT '' NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_channel_idx` ON `attachments` (`channel_id`);--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`message_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_attachments_pair_idx` ON `message_attachments` (`message_id`,`attachment_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `context_json` text;