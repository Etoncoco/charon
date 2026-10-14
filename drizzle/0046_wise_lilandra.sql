CREATE TABLE `account_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`vps_id` text NOT NULL,
	`provider` text NOT NULL,
	`number` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`logged_in` integer,
	`account_key` text,
	FOREIGN KEY (`vps_id`) REFERENCES `vps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_profiles_vps_provider_number` ON `account_profiles` (`vps_id`,`provider`,`number`);