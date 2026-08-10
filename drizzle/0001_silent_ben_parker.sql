CREATE TABLE `mqtt_broker_credentials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`environment` enum('sandbox','production') NOT NULL,
	`credentials` text NOT NULL,
	`is_active` enum('true','false') NOT NULL DEFAULT 'true',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mqtt_broker_credentials_id` PRIMARY KEY(`id`)
);
