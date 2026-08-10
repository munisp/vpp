CREATE TABLE `achievements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` text,
	`icon` varchar(50),
	`category` enum('participation','performance','milestone','special') NOT NULL,
	`criteria_type` enum('events_participated','total_reduction','reliability_score','consecutive_events','compensation_earned') NOT NULL,
	`criteria_value` int NOT NULL,
	`reward_points` int NOT NULL DEFAULT 0,
	`reward_badge` varchar(50),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `achievements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `leaderboard_entries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`period` enum('daily','weekly','monthly','all_time') NOT NULL,
	`period_start` timestamp NOT NULL,
	`period_end` timestamp NOT NULL,
	`rank` int NOT NULL,
	`score` int NOT NULL,
	`events_participated` int NOT NULL DEFAULT 0,
	`total_reduction` int NOT NULL DEFAULT 0,
	`compensation_earned` int NOT NULL DEFAULT 0,
	`reliability_score` int NOT NULL DEFAULT 0,
	`reward_amount` int,
	`reward_paid` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `leaderboard_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_achievements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`achievement_id` int NOT NULL,
	`unlocked_at` timestamp NOT NULL DEFAULT (now()),
	`notified` boolean NOT NULL DEFAULT false,
	`metadata` text,
	CONSTRAINT `user_achievements_id` PRIMARY KEY(`id`)
);
