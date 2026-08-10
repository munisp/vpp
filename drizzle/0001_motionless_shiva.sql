CREATE TABLE `price_alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`alertType` varchar(20) NOT NULL,
	`targetPrice` int,
	`minPrice` int,
	`maxPrice` int,
	`isActive` boolean NOT NULL DEFAULT true,
	`notifyEmail` boolean NOT NULL DEFAULT true,
	`notifyPush` boolean NOT NULL DEFAULT true,
	`notifySMS` boolean NOT NULL DEFAULT false,
	`cooldownMinutes` int NOT NULL DEFAULT 60,
	`lastTriggeredAt` timestamp,
	`triggerCount` int NOT NULL DEFAULT 0,
	`maxTriggers` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `price_alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `referral_rewards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`referral_id` int NOT NULL,
	`user_id` int NOT NULL,
	`reward_type` enum('credits','cash','discount','tokens') NOT NULL,
	`amount` int NOT NULL,
	`currency` enum('NGN','TZS','USD','CREDITS') NOT NULL,
	`status` enum('pending','processed','failed') NOT NULL DEFAULT 'pending',
	`processed_at` timestamp,
	`description` text,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `referral_rewards_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `referrals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`referrer_id` int NOT NULL,
	`referral_code` varchar(20) NOT NULL,
	`referee_id` int,
	`referee_email` varchar(320),
	`referee_phone` varchar(20),
	`status` enum('pending','completed','rewarded','expired') NOT NULL DEFAULT 'pending',
	`reward_type` enum('credits','cash','discount','tokens') NOT NULL DEFAULT 'credits',
	`reward_amount` int NOT NULL DEFAULT 0,
	`reward_currency` enum('NGN','TZS','USD','CREDITS') NOT NULL DEFAULT 'CREDITS',
	`completed_at` timestamp,
	`rewarded_at` timestamp,
	`expires_at` timestamp,
	`source` varchar(100),
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `referrals_id` PRIMARY KEY(`id`),
	CONSTRAINT `referrals_referral_code_unique` UNIQUE(`referral_code`)
);
