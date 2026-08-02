CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `body_photos` (
	`owner_id` text NOT NULL,
	`date` text NOT NULL,
	`angle` text NOT NULL,
	`object_key` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `date`, `angle`)
);
--> statement-breakpoint
CREATE TABLE `body_records` (
	`owner_id` text NOT NULL,
	`date` text NOT NULL,
	`weight` real NOT NULL,
	`fat` real,
	`bmi` real,
	`muscle` real,
	`fasting` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `date`)
);
