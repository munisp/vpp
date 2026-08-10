CREATE TABLE `demandResponseEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`operatorId` int NOT NULL,
	`eventName` varchar(255) NOT NULL,
	`eventType` enum('peak_shaving','frequency_regulation','emergency') NOT NULL,
	`targetReduction` int NOT NULL,
	`startTime` timestamp NOT NULL,
	`endTime` timestamp NOT NULL,
	`compensationRate` int NOT NULL,
	`status` enum('scheduled','active','completed','cancelled') NOT NULL DEFAULT 'scheduled',
	`actualReduction` int,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `demandResponseEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `drCompensation` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`eventId` int NOT NULL,
	`responseId` int NOT NULL,
	`amount` int NOT NULL,
	`currency` enum('NGN','TZS','USD') NOT NULL,
	`status` enum('pending','paid','failed') NOT NULL DEFAULT 'pending',
	`paymentMethod` enum('mpesa','airtel_money','tigo_pesa','bank_transfer'),
	`paymentReference` varchar(255),
	`paidAt` timestamp,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drCompensation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `drParticipants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`enrolledAt` timestamp NOT NULL DEFAULT (now()),
	`status` enum('active','paused','cancelled') NOT NULL DEFAULT 'active',
	`autoOptIn` boolean NOT NULL DEFAULT true,
	`minCompensation` int,
	`maxReduction` int,
	`notificationPreferences` text,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drParticipants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `drResponses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventId` int NOT NULL,
	`userId` int NOT NULL,
	`participationStatus` enum('opted_in','opted_out','auto_enrolled') NOT NULL,
	`targetReduction` int,
	`actualReduction` int,
	`compensation` int,
	`responseTime` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drResponses_id` PRIMARY KEY(`id`)
);
