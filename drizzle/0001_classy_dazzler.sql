CREATE TABLE `alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`alertType` enum('system','trading','billing','maintenance') NOT NULL,
	`severity` enum('info','warning','error','critical') NOT NULL DEFAULT 'info',
	`title` varchar(255) NOT NULL,
	`message` text NOT NULL,
	`isRead` boolean NOT NULL DEFAULT false,
	`readAt` timestamp,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`assetType` enum('solar','battery','meter','generator','wind') NOT NULL,
	`name` varchar(255) NOT NULL,
	`capacity` int NOT NULL,
	`make` varchar(255),
	`model` varchar(255),
	`serialNumber` varchar(255),
	`installationDate` timestamp,
	`status` enum('active','inactive','maintenance','fault') NOT NULL DEFAULT 'active',
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `assets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `billings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`billingType` enum('postpaid','prepaid') NOT NULL,
	`periodStart` timestamp NOT NULL,
	`periodEnd` timestamp NOT NULL,
	`generationKwh` int NOT NULL DEFAULT 0,
	`consumptionKwh` int NOT NULL DEFAULT 0,
	`exportKwh` int NOT NULL DEFAULT 0,
	`exportRevenue` int NOT NULL DEFAULT 0,
	`selfConsumptionSavings` int NOT NULL DEFAULT 0,
	`totalValue` int NOT NULL DEFAULT 0,
	`consumerShare` int NOT NULL DEFAULT 0,
	`vppCommission` int NOT NULL DEFAULT 0,
	`status` enum('draft','issued','paid','overdue','cancelled') NOT NULL DEFAULT 'draft',
	`paidAt` timestamp,
	`paymentMethod` varchar(50),
	`transactionId` varchar(255),
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`contractType` enum('asset_aggregation','full_control','prepaid') NOT NULL,
	`revenueSharePercentage` int NOT NULL DEFAULT 70,
	`monthlyFee` int NOT NULL DEFAULT 0,
	`minimumRevenue` int NOT NULL DEFAULT 0,
	`startDate` timestamp NOT NULL,
	`endDate` timestamp,
	`status` enum('active','expired','cancelled') NOT NULL DEFAULT 'active',
	`signedAt` timestamp NOT NULL DEFAULT (now()),
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contracts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `marketPrices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`country` enum('nigeria','tanzania') NOT NULL,
	`priceType` enum('off_peak','shoulder','peak','super_peak') NOT NULL,
	`price` int NOT NULL,
	`timestamp` timestamp NOT NULL,
	`validUntil` timestamp NOT NULL,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `marketPrices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`billingId` int,
	`paymentType` enum('invoice','token_purchase','monthly_fee') NOT NULL,
	`amount` int NOT NULL,
	`currency` enum('NGN','TZS','USD') NOT NULL,
	`paymentMethod` enum('mpesa','airtel_money','tigo_pesa','bank_transfer','card') NOT NULL,
	`phoneNumber` varchar(20),
	`accountNumber` varchar(100),
	`transactionId` varchar(255),
	`status` enum('pending','completed','failed','refunded') NOT NULL DEFAULT 'pending',
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `telemetry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assetId` int NOT NULL,
	`timestamp` timestamp NOT NULL,
	`power` int,
	`energy` int,
	`voltage` int,
	`current` int,
	`frequency` int,
	`stateOfCharge` int,
	`temperature` int,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `telemetry_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`paymentId` int NOT NULL,
	`tokenCode` varchar(50) NOT NULL,
	`energyKwh` int NOT NULL,
	`amount` int NOT NULL,
	`validUntil` timestamp NOT NULL,
	`status` enum('active','used','expired') NOT NULL DEFAULT 'active',
	`usedAt` timestamp,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `tokens_tokenCode_unique` UNIQUE(`tokenCode`)
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`tradeType` enum('export','import','p2p_sell','p2p_buy') NOT NULL,
	`tradingMode` enum('automatic','manual','p2p') NOT NULL DEFAULT 'automatic',
	`energy` int NOT NULL,
	`price` int NOT NULL,
	`totalAmount` int NOT NULL,
	`timestamp` timestamp NOT NULL,
	`status` enum('pending','executed','cancelled','failed') NOT NULL DEFAULT 'pending',
	`counterpartyId` int,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tradingPreferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`tradingMode` enum('automatic','manual','hybrid') NOT NULL DEFAULT 'automatic',
	`minExportPrice` int,
	`maxImportPrice` int,
	`minBatteryLevel` int NOT NULL DEFAULT 20,
	`maxBatteryLevel` int NOT NULL DEFAULT 90,
	`enableP2P` boolean NOT NULL DEFAULT false,
	`enableNotifications` boolean NOT NULL DEFAULT true,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tradingPreferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `tradingPreferences_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `phone` varchar(20);--> statement-breakpoint
ALTER TABLE `users` ADD `country` enum('nigeria','tanzania') DEFAULT 'nigeria' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `currency` enum('NGN','TZS','USD') DEFAULT 'NGN' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `language` enum('en','ha','yo','ig','sw') DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `timezone` varchar(50) DEFAULT 'Africa/Lagos' NOT NULL;