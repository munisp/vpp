CREATE TABLE `device_commands` (
	`id` int AUTO_INCREMENT NOT NULL,
	`deviceId` int NOT NULL,
	`command` varchar(100) NOT NULL,
	`payload` text,
	`status` enum('pending','sent','acknowledged','failed') NOT NULL DEFAULT 'pending',
	`sentAt` timestamp,
	`acknowledgedAt` timestamp,
	`response` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `device_commands_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `device_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`deviceId` int NOT NULL,
	`eventType` enum('connected','disconnected','error','warning','info') NOT NULL,
	`message` text NOT NULL,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `device_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assetId` int NOT NULL,
	`deviceId` varchar(255) NOT NULL,
	`deviceType` enum('smart_meter','inverter','battery_controller','sensor') NOT NULL,
	`manufacturer` varchar(255),
	`model` varchar(255),
	`firmwareVersion` varchar(50),
	`mqttClientId` varchar(255),
	`mqttUsername` varchar(255),
	`mqttPasswordHash` text,
	`status` enum('online','offline','error','maintenance') NOT NULL DEFAULT 'offline',
	`lastSeen` timestamp,
	`lastMessageAt` timestamp,
	`telemetryInterval` int NOT NULL DEFAULT 5,
	`enabled` boolean NOT NULL DEFAULT true,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `devices_id` PRIMARY KEY(`id`),
	CONSTRAINT `devices_deviceId_unique` UNIQUE(`deviceId`)
);
