ALTER TABLE `notification_preferences` MODIFY COLUMN `email_weekly_summary` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `notification_preferences` MODIFY COLUMN `email_monthly_summary` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `email_trade_executed` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `email_trade_failed` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `email_system_alert` boolean DEFAULT true NOT NULL;