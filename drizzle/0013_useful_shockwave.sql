CREATE TABLE `biometric_credentials` (
`id` int AUTO_INCREMENT NOT NULL,
`user_id` int NOT NULL,
`credential_id` varchar(512) NOT NULL,
`public_key` text NOT NULL,
`counter` int NOT NULL DEFAULT 0,
`device_type` varchar(50),
`device_name` varchar(255),
`last_used` timestamp,
`created_at` timestamp NOT NULL DEFAULT (now()),
`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
CONSTRAINT `biometric_credentials_id` PRIMARY KEY(`id`),
CONSTRAINT `biometric_credentials_credential_id_unique` UNIQUE(`credential_id`)
);
