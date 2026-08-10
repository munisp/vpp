CREATE TABLE `audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`user_name` varchar(255),
	`user_role` enum('user','admin') NOT NULL,
	`action` enum('create','update','delete','approve','reject','suspend','activate','login','logout','payment','trade','export','import','configure') NOT NULL,
	`entity_type` enum('user','asset','trade','payment','billing','alert','device','dr_event','market_price','payment_credential','system_config') NOT NULL,
	`entity_id` varchar(255),
	`entity_name` varchar(255),
	`changes` text,
	`description` text,
	`ip_address` varchar(45),
	`user_agent` varchar(500),
	`status` enum('success','failure','pending') NOT NULL DEFAULT 'success',
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
