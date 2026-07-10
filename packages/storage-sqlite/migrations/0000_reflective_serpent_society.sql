CREATE TABLE `blocked_identities` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`reason` text,
	`blocked_at` integer NOT NULL,
	`blocked_by` text
);
--> statement-breakpoint
CREATE TABLE `deposits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity_id` text NOT NULL,
	`amount` text NOT NULL,
	`currency` text NOT NULL,
	`txid` text NOT NULL,
	`vout` integer NOT NULL,
	`block_height` integer NOT NULL,
	`block_hash` text NOT NULL,
	`confirmations` integer NOT NULL,
	`detected_at` integer NOT NULL,
	`credited_at` integer,
	`reorged_at` integer,
	`origin` text DEFAULT 'real' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_deposits_txid_vout` ON `deposits` (`txid`,`vout`);--> statement-breakpoint
CREATE TABLE `identities` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`balance` text DEFAULT '0' NOT NULL,
	`created_at` integer NOT NULL,
	`first_deposit_at` integer,
	`last_request_at` integer
);
--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity_id` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`amount` text NOT NULL,
	`request_id` text,
	`deposit_id` integer,
	`balance_after` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ledger_identity` ON `ledger_entries` (`identity_id`,`id`);--> statement-breakpoint
CREATE TABLE `reconciliation_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_at` integer NOT NULL,
	`identities_checked` integer NOT NULL,
	`mismatches` integer NOT NULL,
	`detail_json` text,
	`duration_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spent_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`amount` text NOT NULL,
	`received_at` integer NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` text NOT NULL,
	`response_bytes` integer
);
--> statement-breakpoint
CREATE INDEX `idx_spent_requests_issued_at` ON `spent_requests` (`issued_at`);--> statement-breakpoint
CREATE INDEX `idx_spent_requests_identity` ON `spent_requests` (`identity_id`);--> statement-breakpoint
CREATE INDEX `idx_spent_requests_status_received` ON `spent_requests` (`status`,`received_at`);--> statement-breakpoint
CREATE TABLE `watcher_cursor` (
	`key` text PRIMARY KEY NOT NULL,
	`last_block` integer NOT NULL,
	`last_block_hash` text NOT NULL,
	`updated_at` integer NOT NULL
);
