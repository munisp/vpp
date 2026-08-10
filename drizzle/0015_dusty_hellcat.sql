ALTER TABLE `notification_preferences` ADD `push_trade_executed` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `push_trade_failed` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `push_system_alert` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `push_billing_alert` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `notification_sound` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `notification_frequency` enum('instant','hourly','daily') DEFAULT 'instant' NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `quiet_hours_enabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `quiet_hours_start` time DEFAULT '22:00:00';--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `quiet_hours_end` time DEFAULT '08:00:00';