CREATE TABLE `ocpp_id_tags` (
	`id` int AUTO_INCREMENT NOT NULL,
	`id_tag` varchar(64) NOT NULL,
	`user_id` int NOT NULL,
	`ev_id` int,
	`status` enum('accepted','blocked','expired','invalid') NOT NULL DEFAULT 'accepted',
	`expiry_date` timestamp,
	`parent_id_tag` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ocpp_id_tags_id` PRIMARY KEY(`id`),
	CONSTRAINT `ocpp_id_tags_id_tag_unique` UNIQUE(`id_tag`)
);
--> statement-breakpoint
CREATE INDEX `ocpp_id_tags_user_idx` ON `ocpp_id_tags` (`user_id`);--> statement-breakpoint
CREATE TABLE `grid_protocol_instructions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` enum('openadr','sep2') NOT NULL,
	`external_id` varchar(128) NOT NULL,
	`modification_number` int NOT NULL DEFAULT 0,
	`program_ref` varchar(191),
	`event_status` varchar(32) NOT NULL,
	`priority` int,
	`start_time` timestamp NOT NULL,
	`duration_seconds` int NOT NULL,
	`target_watts` int,
	`target_percent` int,
	`decision` enum('opt_in','opt_out','recorded') NOT NULL,
	`decision_reason` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `grid_protocol_instructions_id` PRIMARY KEY(`id`),
	CONSTRAINT `grid_instruction_revision` UNIQUE(`source`,`external_id`,`modification_number`)
);
--> statement-breakpoint
CREATE INDEX `grid_instruction_start_idx` ON `grid_protocol_instructions` (`start_time`);
