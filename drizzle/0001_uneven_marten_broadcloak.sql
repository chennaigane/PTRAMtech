CREATE TABLE IF NOT EXISTS `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`team` text,
	`password_hash` text NOT NULL,
	`status` text NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created` integer NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_phone_unique` ON `users` (`phone`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workforce_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`details` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workforce_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`employee` text NOT NULL,
	`date` text NOT NULL,
	`data` text NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workforce_employee_date` ON `workforce_entries` (`employee`,`date`,`kind`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workforce_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workforce_profiles` (
	`employee` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);

--> statement-breakpoint
INSERT OR IGNORE INTO workforce_profiles(employee,data)
SELECT id,json_object('department',CASE WHEN team IN ('Marketing','Sales') THEN team ELSE 'Other' END,'other',CASE WHEN team IN ('Marketing','Sales') THEN '' ELSE 'Unassigned' END,'salary',NULL,'divisor',NULL,'otRate',NULL,'otMultiplier',NULL,'payrollAccess',json('false')) FROM users;
--> statement-breakpoint
UPDATE users SET role='Employee' WHERE role='Representative';
