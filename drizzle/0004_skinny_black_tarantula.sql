CREATE TABLE `payment_credentials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`gateway` enum('mpesa','airtel_money','tigo_pesa') NOT NULL,
	`environment` enum('sandbox','production') NOT NULL DEFAULT 'sandbox',
	`credentials` text NOT NULL,
	`is_active` enum('true','false') NOT NULL DEFAULT 'false',
	`is_validated` enum('true','false') NOT NULL DEFAULT 'false',
	`last_validated` timestamp,
	`validation_error` text,
	`created_by` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_credentials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payment_gateway_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`payment_id` int,
	`gateway` enum('mpesa','airtel_money','tigo_pesa') NOT NULL,
	`request_type` varchar(50) NOT NULL,
	`request_payload` text,
	`response_payload` text,
	`status_code` int,
	`status` enum('pending','success','failed','timeout') NOT NULL,
	`error_message` text,
	`ip_address` varchar(45),
	`user_agent` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payment_gateway_logs_id` PRIMARY KEY(`id`)
);
