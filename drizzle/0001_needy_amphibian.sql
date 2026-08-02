CREATE TABLE `ai_coach_profiles` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`source_date` text,
	`model` text NOT NULL,
	`result_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `body_records` ADD `metrics_json` text;