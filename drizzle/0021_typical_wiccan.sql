CREATE TABLE `strategy_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` varchar(50) NOT NULL,
	`icon` varchar(50) NOT NULL DEFAULT 'Zap',
	`conditions` json NOT NULL,
	`tradingMode` varchar(20) NOT NULL DEFAULT 'both',
	`priority` int NOT NULL DEFAULT 0,
	`expectedPerformance` json,
	`timesCloned` int NOT NULL DEFAULT 0,
	`tags` json,
	`difficulty` varchar(20) NOT NULL DEFAULT 'beginner',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `strategy_templates_id` PRIMARY KEY(`id`)
);
