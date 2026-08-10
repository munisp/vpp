CREATE TABLE `trading_strategies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`isActive` boolean NOT NULL DEFAULT false,
	`conditions` json,
	`tradingMode` text NOT NULL DEFAULT ('both'),
	`priority` int NOT NULL DEFAULT 0,
	`performanceMetrics` json,
	`backtestResults` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastActivatedAt` timestamp,
	CONSTRAINT `trading_strategies_id` PRIMARY KEY(`id`)
);
