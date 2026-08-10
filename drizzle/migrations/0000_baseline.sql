CREATE TABLE IF NOT EXISTS `achievements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` text,
	`icon` varchar(50),
	`category` enum('participation','performance','milestone','special') NOT NULL,
	`criteria_type` enum('events_participated','total_reduction','reliability_score','consecutive_events','compensation_earned') NOT NULL,
	`criteria_value` int NOT NULL,
	`reward_points` int NOT NULL DEFAULT 0,
	`reward_badge` varchar(50),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `achievements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`alertType` enum('system','trading','billing','maintenance') NOT NULL,
	`severity` enum('info','warning','error','critical') NOT NULL DEFAULT 'info',
	`title` varchar(255) NOT NULL,
	`message` text NOT NULL,
	`isRead` boolean NOT NULL DEFAULT false,
	`readAt` timestamp,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `assets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`assetType` enum('solar','battery','meter','generator','wind') NOT NULL,
	`name` varchar(255) NOT NULL,
	`capacity` int NOT NULL,
	`make` varchar(255),
	`model` varchar(255),
	`serialNumber` varchar(255),
	`installationDate` timestamp,
	`status` enum('active','inactive','maintenance','fault') NOT NULL DEFAULT 'active',
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `assets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_logs` (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `billings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`billingType` enum('postpaid','prepaid') NOT NULL,
	`periodStart` timestamp NOT NULL,
	`periodEnd` timestamp NOT NULL,
	`generationKwh` int NOT NULL DEFAULT 0,
	`consumptionKwh` int NOT NULL DEFAULT 0,
	`exportKwh` int NOT NULL DEFAULT 0,
	`exportRevenue` int NOT NULL DEFAULT 0,
	`selfConsumptionSavings` int NOT NULL DEFAULT 0,
	`totalValue` int NOT NULL DEFAULT 0,
	`consumerShare` int NOT NULL DEFAULT 0,
	`vppCommission` int NOT NULL DEFAULT 0,
	`status` enum('draft','issued','paid','overdue','cancelled') NOT NULL DEFAULT 'draft',
	`paidAt` timestamp,
	`paymentMethod` varchar(50),
	`transactionId` varchar(255),
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `biometric_credentials` (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `contracts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`contractType` enum('asset_aggregation','full_control','prepaid') NOT NULL,
	`revenueSharePercentage` int NOT NULL DEFAULT 70,
	`monthlyFee` int NOT NULL DEFAULT 0,
	`minimumRevenue` int NOT NULL DEFAULT 0,
	`startDate` timestamp NOT NULL,
	`endDate` timestamp,
	`status` enum('active','expired','cancelled') NOT NULL DEFAULT 'active',
	`signedAt` timestamp NOT NULL DEFAULT (now()),
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contracts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `demandResponseEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`operatorId` int NOT NULL,
	`eventName` varchar(255) NOT NULL,
	`eventType` enum('peak_shaving','load_shifting','emergency','economic') NOT NULL,
	`targetReduction` int NOT NULL,
	`startTime` timestamp NOT NULL,
	`endTime` timestamp NOT NULL,
	`compensationRate` int NOT NULL,
	`status` enum('scheduled','active','completed','cancelled') NOT NULL DEFAULT 'scheduled',
	`actualReduction` int,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `demandResponseEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `device_commands` (
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
CREATE TABLE IF NOT EXISTS `device_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`deviceId` int NOT NULL,
	`eventType` enum('connected','disconnected','error','warning','info') NOT NULL,
	`message` text NOT NULL,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `device_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `devices` (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dr_automation_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`template_id` int NOT NULL,
	`condition` enum('load_threshold','price_threshold','grid_frequency','renewable_percentage','time_based') NOT NULL,
	`operator` enum('greater_than','less_than','equals','between') NOT NULL,
	`threshold` int NOT NULL,
	`threshold_max` int,
	`active_hours_start` int,
	`active_hours_end` int,
	`active_days` varchar(50),
	`cooldown_minutes` int NOT NULL DEFAULT 120,
	`last_triggered` timestamp,
	`is_enabled` enum('true','false') NOT NULL DEFAULT 'true',
	`priority` int NOT NULL DEFAULT 5,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dr_automation_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dr_campaigns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`eventId` int,
	`targetSegments` text,
	`minScore` int,
	`maxParticipants` int,
	`bonusCompensation` int,
	`status` enum('draft','scheduled','active','completed','cancelled') NOT NULL DEFAULT 'draft',
	`scheduledStart` timestamp,
	`scheduledEnd` timestamp,
	`participantsInvited` int DEFAULT 0,
	`participantsAccepted` int DEFAULT 0,
	`totalReduction` int,
	`totalCompensation` int,
	`createdBy` int NOT NULL,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dr_campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `drCompensation` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`eventId` int NOT NULL,
	`responseId` int NOT NULL,
	`amount` int NOT NULL,
	`currency` enum('NGN','TZS','USD') NOT NULL,
	`status` enum('pending','paid','failed') NOT NULL DEFAULT 'pending',
	`paymentMethod` enum('mpesa','airtel_money','tigo_pesa','bank_transfer'),
	`paymentReference` varchar(255),
	`paidAt` timestamp,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drCompensation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dr_event_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`event_type` enum('peak_shaving','load_shifting','emergency','economic') NOT NULL,
	`default_duration` int NOT NULL,
	`default_target_reduction` int NOT NULL,
	`default_compensation_rate` int NOT NULL,
	`trigger_condition` enum('manual','peak_forecast','grid_stress','price_spike','renewable_surplus') NOT NULL,
	`trigger_threshold` int,
	`advance_notice_minutes` int NOT NULL DEFAULT 60,
	`notification_channels` text,
	`is_active` enum('true','false') NOT NULL DEFAULT 'true',
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dr_event_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dr_forecasts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`forecast_date` timestamp NOT NULL,
	`forecast_hour` int NOT NULL,
	`predicted_load` int NOT NULL,
	`predicted_peak` int NOT NULL,
	`dr_potential` int NOT NULL,
	`confidence` int NOT NULL,
	`grid_status` enum('normal','stressed','critical') NOT NULL,
	`temperature` int,
	`weather_condition` varchar(50),
	`recommended_action` enum('none','monitor','prepare_event','trigger_event') NOT NULL,
	`recommended_reduction` int,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dr_forecasts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `drParticipants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`enrolledAt` timestamp NOT NULL DEFAULT (now()),
	`status` enum('active','paused','cancelled') NOT NULL DEFAULT 'active',
	`autoOptIn` boolean NOT NULL DEFAULT true,
	`minCompensation` int,
	`maxReduction` int,
	`notificationPreferences` text,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drParticipants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `drResponses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventId` int NOT NULL,
	`userId` int NOT NULL,
	`participationStatus` enum('opted_in','opted_out','auto_enrolled') NOT NULL,
	`targetReduction` int,
	`actualReduction` int,
	`compensation` int,
	`responseTime` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drResponses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `grid_monitoring` (
	`id` int AUTO_INCREMENT NOT NULL,
	`timestamp` timestamp NOT NULL,
	`total_load` int NOT NULL,
	`peak_load` int NOT NULL,
	`average_load` int NOT NULL,
	`total_generation` int NOT NULL,
	`renewable_generation` int NOT NULL,
	`renewable_percentage` int NOT NULL,
	`frequency` int NOT NULL,
	`voltage` int NOT NULL,
	`grid_status` enum('normal','stressed','critical','emergency') NOT NULL,
	`spot_price` int,
	`forecast_price` int,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `grid_monitoring_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `leaderboard_entries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`period` enum('daily','weekly','monthly','all_time') NOT NULL,
	`period_start` timestamp NOT NULL,
	`period_end` timestamp NOT NULL,
	`rank` int NOT NULL,
	`score` int NOT NULL,
	`events_participated` int NOT NULL DEFAULT 0,
	`total_reduction` int NOT NULL DEFAULT 0,
	`compensation_earned` int NOT NULL DEFAULT 0,
	`reliability_score` int NOT NULL DEFAULT 0,
	`reward_amount` int,
	`reward_paid` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `leaderboard_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `marketPrices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`country` enum('nigeria','tanzania') NOT NULL,
	`priceType` enum('off_peak','shoulder','peak','super_peak') NOT NULL,
	`price` int NOT NULL,
	`timestamp` timestamp NOT NULL,
	`validUntil` timestamp NOT NULL,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `marketPrices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mqtt_broker_credentials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`environment` enum('sandbox','production') NOT NULL,
	`credentials` text NOT NULL,
	`is_active` enum('true','false') NOT NULL DEFAULT 'true',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mqtt_broker_credentials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notification_preferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`email_payment_received` boolean NOT NULL DEFAULT true,
	`email_trade_executed` boolean NOT NULL DEFAULT true,
	`email_trade_failed` boolean NOT NULL DEFAULT true,
	`email_system_alert` boolean NOT NULL DEFAULT true,
	`email_achievement_unlocked` boolean NOT NULL DEFAULT true,
	`email_dr_event_reminder` boolean NOT NULL DEFAULT true,
	`email_dr_event_created` boolean NOT NULL DEFAULT true,
	`email_leaderboard_rank_change` boolean NOT NULL DEFAULT true,
	`email_weekly_summary` boolean NOT NULL DEFAULT false,
	`email_monthly_summary` boolean NOT NULL DEFAULT false,
	`push_payment_received` boolean NOT NULL DEFAULT true,
	`push_achievement_unlocked` boolean NOT NULL DEFAULT true,
	`push_dr_event_reminder` boolean NOT NULL DEFAULT true,
	`push_dr_event_created` boolean NOT NULL DEFAULT true,
	`push_leaderboard_rank_change` boolean NOT NULL DEFAULT false,
	`push_trade_executed` boolean NOT NULL DEFAULT true,
	`push_trade_failed` boolean NOT NULL DEFAULT true,
	`push_system_alert` boolean NOT NULL DEFAULT true,
	`push_billing_alert` boolean NOT NULL DEFAULT true,
	`notification_sound` boolean NOT NULL DEFAULT true,
	`notification_frequency` enum('instant','hourly','daily') NOT NULL DEFAULT 'instant',
	`quiet_hours_enabled` boolean NOT NULL DEFAULT false,
	`quiet_hours_start` time DEFAULT '22:00:00',
	`quiet_hours_end` time DEFAULT '08:00:00',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notification_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `notification_preferences_user_id_unique` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `participant_scores` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`reliabilityScore` int NOT NULL,
	`responseTimeScore` int NOT NULL,
	`reductionAccuracyScore` int NOT NULL,
	`participationRateScore` int NOT NULL,
	`overallScore` int NOT NULL,
	`totalEventsParticipated` int NOT NULL DEFAULT 0,
	`totalEventsOptedOut` int NOT NULL DEFAULT 0,
	`averageReduction` int,
	`totalCompensationEarned` int NOT NULL DEFAULT 0,
	`maxCapacity` int,
	`averageResponseTime` int,
	`segment` enum('platinum','gold','silver','bronze','inactive') NOT NULL,
	`lastCalculated` timestamp NOT NULL DEFAULT (now()),
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `participant_scores_id` PRIMARY KEY(`id`),
	CONSTRAINT `participant_scores_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `participant_segments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` text,
	`minOverallScore` int,
	`minReliabilityScore` int,
	`minParticipationRate` int,
	`minCapacity` int,
	`priority` int NOT NULL DEFAULT 0,
	`compensationMultiplier` int NOT NULL DEFAULT 100,
	`isActive` boolean NOT NULL DEFAULT true,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `participant_segments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payment_credentials` (
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
CREATE TABLE IF NOT EXISTS `payment_gateway_logs` (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payment_reconciliations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`paymentId` int NOT NULL,
	`reconciliationDate` timestamp NOT NULL,
	`status` enum('matched','unmatched','discrepancy','manual_review') NOT NULL,
	`gatewayTransactionId` varchar(255),
	`gatewayAmount` int,
	`gatewayStatus` varchar(50),
	`gatewayTimestamp` timestamp,
	`dbAmount` int,
	`dbStatus` varchar(50),
	`dbTimestamp` timestamp,
	`amountDifference` int,
	`statusMismatch` boolean DEFAULT false,
	`timeDifference` int,
	`resolvedBy` int,
	`resolvedAt` timestamp,
	`resolutionNotes` text,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_reconciliations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`billingId` int,
	`paymentType` enum('invoice','token_purchase','monthly_fee') NOT NULL,
	`amount` int NOT NULL,
	`currency` enum('NGN','TZS','USD') NOT NULL,
	`paymentMethod` enum('mpesa','airtel_money','tigo_pesa','bank_transfer','card') NOT NULL,
	`phoneNumber` varchar(20),
	`accountNumber` varchar(100),
	`transactionId` varchar(255),
	`status` enum('pending','completed','failed','refunded') NOT NULL DEFAULT 'pending',
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`alertType` varchar(20) NOT NULL,
	`targetPrice` int,
	`minPrice` int,
	`maxPrice` int,
	`isActive` boolean NOT NULL DEFAULT true,
	`notifyEmail` boolean NOT NULL DEFAULT true,
	`notifyPush` boolean NOT NULL DEFAULT true,
	`notifySMS` boolean NOT NULL DEFAULT false,
	`cooldownMinutes` int NOT NULL DEFAULT 60,
	`lastTriggeredAt` timestamp,
	`triggerCount` int NOT NULL DEFAULT 0,
	`maxTriggers` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `price_alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_subscriptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`expiration_time` timestamp,
	`user_agent` text,
	`device_type` varchar(50),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `push_subscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reconciliation_audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reconciliationId` int NOT NULL,
	`action` enum('created','matched','flagged_discrepancy','manual_review','resolved','rejected') NOT NULL,
	`performedBy` int,
	`notes` text,
	`previousStatus` varchar(50),
	`newStatus` varchar(50),
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reconciliation_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reconciliation_reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reportDate` timestamp NOT NULL,
	`reportType` enum('daily','weekly','monthly') NOT NULL,
	`totalPayments` int NOT NULL,
	`matchedPayments` int NOT NULL,
	`unmatchedPayments` int NOT NULL,
	`discrepancies` int NOT NULL,
	`totalAmount` int NOT NULL,
	`matchedAmount` int NOT NULL,
	`discrepancyAmount` int NOT NULL,
	`gatewayBreakdown` text,
	`generatedBy` int,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	`reportFileUrl` varchar(500),
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reconciliation_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `referral_rewards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`referral_id` int NOT NULL,
	`user_id` int NOT NULL,
	`reward_type` enum('credits','cash','discount','tokens') NOT NULL,
	`amount` int NOT NULL,
	`currency` enum('NGN','TZS','USD','CREDITS') NOT NULL,
	`status` enum('pending','processed','failed') NOT NULL DEFAULT 'pending',
	`processed_at` timestamp,
	`description` text,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `referral_rewards_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `referrals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`referrer_id` int NOT NULL,
	`referral_code` varchar(20) NOT NULL,
	`referee_id` int,
	`referee_email` varchar(320),
	`referee_phone` varchar(20),
	`status` enum('pending','completed','rewarded','expired') NOT NULL DEFAULT 'pending',
	`reward_type` enum('credits','cash','discount','tokens') NOT NULL DEFAULT 'credits',
	`reward_amount` int NOT NULL DEFAULT 0,
	`reward_currency` enum('NGN','TZS','USD','CREDITS') NOT NULL DEFAULT 'CREDITS',
	`completed_at` timestamp,
	`rewarded_at` timestamp,
	`expires_at` timestamp,
	`source` varchar(100),
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `referrals_id` PRIMARY KEY(`id`),
	CONSTRAINT `referrals_referral_code_unique` UNIQUE(`referral_code`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `strategy_templates` (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `telemetry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assetId` int NOT NULL,
	`timestamp` timestamp NOT NULL,
	`power` int,
	`energy` int,
	`voltage` int,
	`current` int,
	`frequency` int,
	`stateOfCharge` int,
	`temperature` int,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `telemetry_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`paymentId` int NOT NULL,
	`tokenCode` varchar(50) NOT NULL,
	`energyKwh` int NOT NULL,
	`amount` int NOT NULL,
	`validUntil` timestamp NOT NULL,
	`status` enum('active','used','expired') NOT NULL DEFAULT 'active',
	`usedAt` timestamp,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `tokens_tokenCode_unique` UNIQUE(`tokenCode`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`tradeType` enum('export','import','p2p_sell','p2p_buy') NOT NULL,
	`tradingMode` enum('automatic','manual','p2p') NOT NULL DEFAULT 'automatic',
	`energy` int NOT NULL,
	`price` int NOT NULL,
	`totalAmount` int NOT NULL,
	`timestamp` timestamp NOT NULL,
	`status` enum('pending','executed','cancelled','failed') NOT NULL DEFAULT 'pending',
	`counterpartyId` int,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tradingPreferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`tradingMode` enum('automatic','manual','hybrid') NOT NULL DEFAULT 'automatic',
	`minExportPrice` int,
	`maxImportPrice` int,
	`minBatteryLevel` int NOT NULL DEFAULT 20,
	`maxBatteryLevel` int NOT NULL DEFAULT 90,
	`enableP2P` boolean NOT NULL DEFAULT false,
	`enableNotifications` boolean NOT NULL DEFAULT true,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tradingPreferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `tradingPreferences_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `trading_strategies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`isActive` boolean NOT NULL DEFAULT false,
	`conditions` json,
	`tradingMode` varchar(20) NOT NULL DEFAULT 'both',
	`priority` int NOT NULL DEFAULT 0,
	`performanceMetrics` json,
	`backtestResults` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastActivatedAt` timestamp,
	CONSTRAINT `trading_strategies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_achievements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`achievement_id` int NOT NULL,
	`unlocked_at` timestamp NOT NULL DEFAULT (now()),
	`notified` boolean NOT NULL DEFAULT false,
	`metadata` text,
	CONSTRAINT `user_achievements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`name` text,
	`email` varchar(320),
	`phone` varchar(20),
	`loginMethod` varchar(64),
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`country` enum('nigeria','tanzania') NOT NULL DEFAULT 'nigeria',
	`currency` enum('NGN','TZS','USD') NOT NULL DEFAULT 'NGN',
	`language` enum('en','ha','yo','ig','sw') NOT NULL DEFAULT 'en',
	`timezone` varchar(50) NOT NULL DEFAULT 'Africa/Lagos',
	`onboardingCompleted` boolean NOT NULL DEFAULT false,
	`onboardingStep` int NOT NULL DEFAULT 0,
	`onboardingSkipped` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_openId_unique` UNIQUE(`openId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `qr_code_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`operation_type` enum('scan','generate') NOT NULL,
	`payment_type` enum('merchant','p2p','bill','token') NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`currency` varchar(10) NOT NULL,
	`merchant_id` varchar(255),
	`merchant_name` varchar(255),
	`recipient_id` varchar(255),
	`recipient_name` varchar(255),
	`bill_id` varchar(255),
	`bill_type` varchar(100),
	`reference` varchar(255),
	`description` text,
	`qr_code_data` text NOT NULL,
	`qr_code_image` text,
	`status` enum('pending','completed','failed','expired') NOT NULL DEFAULT 'pending',
	`scanned_at` timestamp,
	`generated_at` timestamp,
	`completed_at` timestamp,
	`expires_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `qr_code_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `anomaly_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`asset_id` int NOT NULL,
	`detected_at` timestamp NOT NULL,
	`anomaly_type` enum('power_deviation','efficiency_drop','temperature_abnormal','communication_loss','voltage_anomaly','frequency_deviation','soc_inconsistency','performance_degradation') NOT NULL,
	`severity` enum('low','medium','high','critical') NOT NULL,
	`detection_method` varchar(50),
	`confidence_score` int,
	`measured_value` int,
	`expected_value` int,
	`deviation_percent` int,
	`estimated_impact` text,
	`recommended_action` enum('monitor','schedule_inspection','immediate_inspection','reduce_load','shutdown') NOT NULL DEFAULT 'monitor',
	`status` enum('open','acknowledged','investigating','resolved','false_positive') NOT NULL DEFAULT 'open',
	`resolved_at` timestamp,
	`resolution_notes` text,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `anomaly_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `carbon_credits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`credit_type` enum('rec','carbon_offset','green_certificate','i_rec') NOT NULL,
	`certificate_id` varchar(100),
	`energy_mwh` int,
	`carbon_tonnes` int,
	`generation_source` varchar(100),
	`generation_period_start` timestamp,
	`generation_period_end` timestamp,
	`registry` varchar(100),
	`registry_url` varchar(255),
	`status` enum('pending','issued','transferred','retired','cancelled') NOT NULL DEFAULT 'pending',
	`blockchain_proof` varchar(66),
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `carbon_credits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `charging_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ev_id` int NOT NULL,
	`station_id` int NOT NULL,
	`user_id` int NOT NULL,
	`session_id` varchar(64) NOT NULL,
	`start_time` timestamp NOT NULL,
	`end_time` timestamp,
	`start_soc_percent` int,
	`end_soc_percent` int,
	`energy_delivered_wh` int NOT NULL DEFAULT 0,
	`energy_exported_wh` int NOT NULL DEFAULT 0,
	`max_power_kw` int,
	`avg_power_kw` int,
	`session_type` enum('standard_charge','smart_charge','v2g','v2h') NOT NULL DEFAULT 'standard_charge',
	`target_soc_percent` int,
	`departure_time` timestamp,
	`total_cost` int,
	`total_revenue` int,
	`status` enum('starting','charging','discharging','paused','completed','failed') NOT NULL DEFAULT 'starting',
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `charging_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `charging_sessions_session_id_unique` UNIQUE(`session_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `charging_stations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int,
	`site_id` int,
	`station_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`latitude` decimal(10,7),
	`longitude` decimal(10,7),
	`address` text,
	`connector_type` enum('type1','type2','chademo','ccs1','ccs2','tesla') NOT NULL,
	`max_power_kw` int NOT NULL,
	`v2g_capable` boolean NOT NULL DEFAULT false,
	`ocpp_version` enum('1.6','2.0','2.0.1'),
	`ocpp_endpoint` varchar(255),
	`status` enum('available','occupied','charging','discharging','faulted','offline') NOT NULL DEFAULT 'offline',
	`last_heartbeat` timestamp,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `charging_stations_id` PRIMARY KEY(`id`),
	CONSTRAINT `charging_stations_station_id_unique` UNIQUE(`station_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `community_allocations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`community_id` int NOT NULL,
	`period_start` timestamp NOT NULL,
	`period_end` timestamp NOT NULL,
	`total_generation_wh` int NOT NULL DEFAULT 0,
	`total_consumption_wh` int NOT NULL DEFAULT 0,
	`total_export_wh` int NOT NULL DEFAULT 0,
	`total_import_wh` int NOT NULL DEFAULT 0,
	`total_revenue` int NOT NULL DEFAULT 0,
	`total_cost` int NOT NULL DEFAULT 0,
	`net_value` int NOT NULL DEFAULT 0,
	`member_allocations` text NOT NULL,
	`status` enum('calculated','approved','distributed','disputed') NOT NULL DEFAULT 'calculated',
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `community_allocations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `community_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`community_id` int NOT NULL,
	`user_id` int NOT NULL,
	`role` enum('member','prosumer','admin','operator') NOT NULL DEFAULT 'member',
	`joined_at` timestamp NOT NULL DEFAULT (now()),
	`contributed_capacity_kw` int NOT NULL DEFAULT 0,
	`share_percentage` int,
	`auto_participate` boolean NOT NULL DEFAULT true,
	`priority_level` int NOT NULL DEFAULT 5,
	`status` enum('pending','active','suspended','left') NOT NULL DEFAULT 'pending',
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `community_members_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `compliance_checks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`rule_id` int NOT NULL,
	`entity_type` enum('user','asset','community','system') NOT NULL,
	`entity_id` int,
	`checked_at` timestamp NOT NULL,
	`status` enum('compliant','non_compliant','warning','not_applicable') NOT NULL,
	`findings` text,
	`recommended_actions` text,
	`resolved_at` timestamp,
	`resolution_notes` text,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `compliance_checks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `compliance_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`rule_code` varchar(50) NOT NULL,
	`rule_name` varchar(255) NOT NULL,
	`jurisdiction` varchar(100) NOT NULL,
	`regulatory_body` varchar(255),
	`rule_type` enum('data_retention','privacy','reporting','technical_standard','market_participation','safety') NOT NULL,
	`description` text NOT NULL,
	`requirements` text NOT NULL,
	`applies_to_asset_types` text,
	`applies_to_service_types` text,
	`enforcement_date` timestamp,
	`penalty_description` text,
	`is_active` boolean NOT NULL DEFAULT true,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `compliance_rules_id` PRIMARY KEY(`id`),
	CONSTRAINT `compliance_rules_rule_code_unique` UNIQUE(`rule_code`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `der_capabilities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`asset_id` int NOT NULL,
	`max_power_export` int,
	`max_power_import` int,
	`min_power_export` int,
	`min_power_import` int,
	`ramp_rate_up` int,
	`ramp_rate_down` int,
	`max_soc` int,
	`min_soc` int,
	`round_trip_efficiency` int,
	`response_time_ms` int,
	`minimum_run_time` int,
	`minimum_off_time` int,
	`can_provide_frequency_response` boolean NOT NULL DEFAULT false,
	`can_provide_voltage_support` boolean NOT NULL DEFAULT false,
	`can_provide_reserves` boolean NOT NULL DEFAULT false,
	`can_provide_peak_shaving` boolean NOT NULL DEFAULT true,
	`protocols` text,
	`certifications` text,
	`grid_code_compliance` text,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `der_capabilities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `der_constraints` (
	`id` int AUTO_INCREMENT NOT NULL,
	`asset_id` int NOT NULL,
	`valid_from` timestamp NOT NULL,
	`valid_until` timestamp NOT NULL,
	`constraint_type` enum('max_power','min_power','max_energy','min_soc','max_soc','unavailable','must_run','user_preference') NOT NULL,
	`constraint_value` int,
	`priority` int NOT NULL DEFAULT 5,
	`source` enum('user','operator','system','safety','grid_code') NOT NULL,
	`reason` text,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `der_constraints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dispatch_schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`schedule_id` varchar(64) NOT NULL,
	`schedule_start` timestamp NOT NULL,
	`schedule_end` timestamp NOT NULL,
	`interval_minutes` int NOT NULL DEFAULT 15,
	`optimization_run_id` varchar(64),
	`objective_function` enum('minimize_cost','maximize_revenue','minimize_emissions','maximize_self_consumption','balance_grid') NOT NULL,
	`status` enum('draft','optimized','approved','dispatching','completed','cancelled') NOT NULL DEFAULT 'draft',
	`total_expected_revenue` int,
	`total_expected_cost` int,
	`total_expected_emissions_saved` int,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dispatch_schedules_id` PRIMARY KEY(`id`),
	CONSTRAINT `dispatch_schedules_schedule_id_unique` UNIQUE(`schedule_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dispatch_setpoints` (
	`id` int AUTO_INCREMENT NOT NULL,
	`schedule_id` int NOT NULL,
	`asset_id` int NOT NULL,
	`interval_start` timestamp NOT NULL,
	`interval_end` timestamp NOT NULL,
	`target_power_watts` int NOT NULL,
	`target_soc_percent` int,
	`service_product_id` int,
	`status` enum('scheduled','dispatched','acknowledged','executing','completed','failed','skipped') NOT NULL DEFAULT 'scheduled',
	`actual_power_watts` int,
	`actual_soc_percent` int,
	`dispatched_at` timestamp,
	`acknowledged_at` timestamp,
	`completed_at` timestamp,
	`deviation_watts` int,
	`performance_score` int,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dispatch_setpoints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `edge_commands` (
	`id` int AUTO_INCREMENT NOT NULL,
	`gateway_id` int NOT NULL,
	`command_id` varchar(64) NOT NULL,
	`idempotency_key` varchar(64) NOT NULL,
	`target_device_id` int,
	`target_asset_id` int,
	`command_type` enum('set_power','set_soc_target','start_charging','stop_charging','enable_v2g','disable_v2g','emergency_stop','update_config') NOT NULL,
	`command_payload` text NOT NULL,
	`priority` int NOT NULL DEFAULT 5,
	`valid_until` timestamp NOT NULL,
	`status` enum('queued','sent','acknowledged','executing','completed','failed','expired') NOT NULL DEFAULT 'queued',
	`queued_at` timestamp NOT NULL DEFAULT (now()),
	`sent_at` timestamp,
	`acknowledged_at` timestamp,
	`completed_at` timestamp,
	`response_payload` text,
	`error_message` text,
	`response_signature` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `edge_commands_id` PRIMARY KEY(`id`),
	CONSTRAINT `edge_commands_command_id_unique` UNIQUE(`command_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `edge_gateways` (
	`id` int AUTO_INCREMENT NOT NULL,
	`gateway_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`site_id` int,
	`community_id` int,
	`hardware_model` varchar(100),
	`firmware_version` varchar(50),
	`primary_protocol` enum('mqtt','grpc','https') NOT NULL DEFAULT 'mqtt',
	`connection_endpoint` varchar(255),
	`can_operate_offline` boolean NOT NULL DEFAULT true,
	`local_storage_capacity_mb` int,
	`max_managed_devices` int,
	`certificate_fingerprint` varchar(64),
	`last_certificate_rotation` timestamp,
	`status` enum('online','offline','degraded','maintenance') NOT NULL DEFAULT 'offline',
	`last_heartbeat` timestamp,
	`offline_mode` boolean NOT NULL DEFAULT false,
	`pending_commands_count` int NOT NULL DEFAULT 0,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `edge_gateways_id` PRIMARY KEY(`id`),
	CONSTRAINT `edge_gateways_gateway_id_unique` UNIQUE(`gateway_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `electric_vehicles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`vin` varchar(17),
	`make` varchar(100),
	`model` varchar(100),
	`year` int,
	`battery_capacity_kwh` int,
	`usable_battery_kwh` int,
	`max_charging_power_kw` int,
	`max_discharging_power_kw` int,
	`v2g_capable` boolean NOT NULL DEFAULT false,
	`v2h_capable` boolean NOT NULL DEFAULT false,
	`bidirectional_protocol` enum('none','chademo','ccs_v2g','iso15118') NOT NULL DEFAULT 'none',
	`current_soc_percent` int,
	`last_known_location` varchar(255),
	`is_plugged_in` boolean NOT NULL DEFAULT false,
	`is_charging` boolean NOT NULL DEFAULT false,
	`min_soc_percent` int NOT NULL DEFAULT 2000,
	`target_soc_percent` int NOT NULL DEFAULT 8000,
	`status` enum('active','inactive','maintenance') NOT NULL DEFAULT 'active',
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `electric_vehicles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `emissions_factors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`region` varchar(50) NOT NULL,
	`timestamp` timestamp NOT NULL,
	`valid_until` timestamp NOT NULL,
	`marginal_emissions` int NOT NULL,
	`average_emissions` int NOT NULL,
	`renewable_percent` int,
	`coal_percent` int,
	`gas_percent` int,
	`nuclear_percent` int,
	`data_source` varchar(100),
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `emissions_factors_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `energy_communities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`community_code` varchar(50) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`community_type` enum('residential','commercial','mixed','microgrid','virtual') NOT NULL,
	`region` varchar(100),
	`grid_connection_point` varchar(100),
	`governance_model` enum('cooperative','utility_managed','peer_to_peer','hybrid') NOT NULL DEFAULT 'cooperative',
	`has_shared_battery` boolean NOT NULL DEFAULT false,
	`has_shared_solar` boolean NOT NULL DEFAULT false,
	`shared_capacity_kw` int,
	`can_island` boolean NOT NULL DEFAULT false,
	`islanding_mode` enum('grid_tied','islanded','transitioning') NOT NULL DEFAULT 'grid_tied',
	`allocation_method` enum('equal_share','proportional_capacity','proportional_consumption','dynamic_pricing','custom') NOT NULL DEFAULT 'proportional_capacity',
	`status` enum('forming','active','suspended','dissolved') NOT NULL DEFAULT 'forming',
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `energy_communities_id` PRIMARY KEY(`id`),
	CONSTRAINT `energy_communities_community_code_unique` UNIQUE(`community_code`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forecast_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`forecast_type` enum('load','solar_generation','wind_generation','price','emissions','ev_availability') NOT NULL,
	`scope_type` enum('asset','user','community','region') NOT NULL,
	`scope_id` int,
	`region` varchar(50),
	`model_version` varchar(50) NOT NULL,
	`model_type` varchar(50),
	`features` text,
	`forecast_horizon_hours` int NOT NULL,
	`interval_minutes` int NOT NULL DEFAULT 15,
	`mae_value` int,
	`rmse_value` int,
	`mape_value` int,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `forecast_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `forecast_runs_run_id_unique` UNIQUE(`run_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forecast_values` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`forecast_time` timestamp NOT NULL,
	`p10_value` int NOT NULL,
	`p50_value` int NOT NULL,
	`p90_value` int NOT NULL,
	`mean_value` int,
	`confidence_score` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `forecast_values_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `grid_service_products` (
	`id` int AUTO_INCREMENT NOT NULL,
	`service_code` varchar(50) NOT NULL,
	`service_name` varchar(255) NOT NULL,
	`service_type` enum('energy_arbitrage','capacity','frequency_regulation','spinning_reserve','non_spinning_reserve','voltage_support','reactive_power','congestion_relief','peak_shaving','load_shifting','demand_response','black_start') NOT NULL,
	`market_region` varchar(50) NOT NULL,
	`min_capacity_kw` int,
	`max_response_time_ms` int,
	`min_duration_minutes` int,
	`telemetry_interval_seconds` int,
	`compensation_type` enum('energy_only','capacity_only','capacity_plus_energy','performance_based') NOT NULL,
	`base_rate_cents` int,
	`performance_multiplier` int,
	`is_active` boolean NOT NULL DEFAULT true,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `grid_service_products_id` PRIMARY KEY(`id`),
	CONSTRAINT `grid_service_products_service_code_unique` UNIQUE(`service_code`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `model_drift_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`model_id` int NOT NULL,
	`detected_at` timestamp NOT NULL,
	`drift_type` enum('data_drift','concept_drift','performance_degradation') NOT NULL,
	`psi_score` int,
	`kl_divergence` int,
	`current_mae` int,
	`baseline_mae` int,
	`severity` enum('low','medium','high','critical') NOT NULL,
	`action_taken` enum('none','alert_sent','retrain_triggered','model_rolled_back') NOT NULL DEFAULT 'none',
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `model_drift_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `model_registry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`model_name` varchar(100) NOT NULL,
	`model_version` varchar(50) NOT NULL,
	`model_type` enum('load_forecast','generation_forecast','price_forecast','anomaly_detection','optimization') NOT NULL,
	`artifact_path` varchar(500),
	`artifact_hash` varchar(64),
	`training_data_start` timestamp,
	`training_data_end` timestamp,
	`training_duration_seconds` int,
	`validation_mae` int,
	`validation_rmse` int,
	`validation_mape` int,
	`status` enum('training','validating','staging','production','deprecated','failed') NOT NULL DEFAULT 'training',
	`deployed_at` timestamp,
	`deprecated_at` timestamp,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `model_registry_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `service_enrollments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`asset_id` int NOT NULL,
	`service_product_id` int NOT NULL,
	`user_id` int NOT NULL,
	`enrolled_capacity_kw` int NOT NULL,
	`status` enum('pending','active','suspended','terminated') NOT NULL DEFAULT 'pending',
	`enrolled_at` timestamp NOT NULL DEFAULT (now()),
	`effective_from` timestamp NOT NULL,
	`effective_until` timestamp,
	`total_dispatches_count` int NOT NULL DEFAULT 0,
	`successful_dispatches_count` int NOT NULL DEFAULT 0,
	`performance_score` int NOT NULL DEFAULT 100,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `service_enrollments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settlement_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`event_hash` varchar(64) NOT NULL,
	`previous_hash` varchar(64) NOT NULL,
	`sequence_number` bigint NOT NULL,
	`event_type` enum('dispatch_completed','service_delivered','measurement_verified','compensation_calculated','payment_initiated','payment_completed','dispute_raised','dispute_resolved','adjustment_applied') NOT NULL,
	`user_id` int NOT NULL,
	`counterparty_id` int,
	`source_type` varchar(50) NOT NULL,
	`source_id` int NOT NULL,
	`energy_wh` int,
	`power_kw` int,
	`duration_minutes` int,
	`rate_per_unit` int,
	`gross_amount` int,
	`fees` int,
	`net_amount` int,
	`currency` enum('NGN','TZS','USD') NOT NULL,
	`measurement_method` varchar(50),
	`baseline_method` varchar(50),
	`verification_status` enum('pending','verified','disputed','adjusted') NOT NULL DEFAULT 'pending',
	`event_data` text NOT NULL,
	`blockchain_tx_hash` varchar(66),
	`anchored_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `settlement_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `settlement_events_event_hash_unique` UNIQUE(`event_hash`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settlement_periods` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`period_start` timestamp NOT NULL,
	`period_end` timestamp NOT NULL,
	`total_energy_exported_wh` int NOT NULL DEFAULT 0,
	`total_energy_imported_wh` int NOT NULL DEFAULT 0,
	`total_services_delivered` int NOT NULL DEFAULT 0,
	`gross_revenue` int NOT NULL DEFAULT 0,
	`platform_fees` int NOT NULL DEFAULT 0,
	`grid_charges` int NOT NULL DEFAULT 0,
	`net_revenue` int NOT NULL DEFAULT 0,
	`emissions_saved_grams` int NOT NULL DEFAULT 0,
	`renewable_energy_wh` int NOT NULL DEFAULT 0,
	`status` enum('open','closed','invoiced','paid','disputed') NOT NULL DEFAULT 'open',
	`period_hash` varchar(64),
	`event_count` int NOT NULL DEFAULT 0,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `settlement_periods_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `battery_health_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assetId` int NOT NULL,
	`userId` int NOT NULL,
	`windowStart` timestamp,
	`windowEnd` timestamp,
	`sampleCount` int NOT NULL,
	`fullCycleEquivalentsMilli` int,
	`roundTripEfficiencyPct100` int,
	`estimatedSohPct100` int,
	`weeklyDegradationSlopePct100` int,
	`chargeEnergyWh` int,
	`dischargeEnergyWh` int,
	`warrantyRisk` boolean NOT NULL DEFAULT false,
	`warrantyRiskReasons` json NOT NULL,
	`insufficientData` boolean NOT NULL DEFAULT false,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `battery_health_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `carbon_certificates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`sequence` int NOT NULL,
	`certificateHash` varchar(64) NOT NULL,
	`region` varchar(50) NOT NULL,
	`energyWh` int NOT NULL,
	`emissionFactorGramsPerKwh` int NOT NULL,
	`emissionFactorSource` enum('live') NOT NULL,
	`co2AvoidedGrams` int NOT NULL,
	`periodStart` timestamp NOT NULL,
	`periodEnd` timestamp NOT NULL,
	`status` enum('minted','retired') NOT NULL DEFAULT 'minted',
	`metadata` text,
	`mintedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `carbon_certificates_id` PRIMARY KEY(`id`),
	CONSTRAINT `carbon_certificates_certificateHash_unique` UNIQUE(`certificateHash`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dynamic_tariffs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`country` enum('nigeria','tanzania') NOT NULL,
	`version` int NOT NULL,
	`status` enum('published','superseded') NOT NULL DEFAULT 'published',
	`effectiveFrom` timestamp NOT NULL,
	`periods` json NOT NULL,
	`learnedFrom` json NOT NULL,
	`publishedBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dynamic_tariffs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `energy_advisor_reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`kind` enum('recommendations','weekly_digest') NOT NULL,
	`periodStart` timestamp NOT NULL,
	`periodEnd` timestamp NOT NULL,
	`facts` json NOT NULL,
	`llmAvailable` boolean NOT NULL,
	`llmModel` varchar(100),
	`llmError` text,
	`recommendations` json NOT NULL,
	`ruleBasedTips` json NOT NULL,
	`digest` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `energy_advisor_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `p2p_matches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`buyOrderId` int NOT NULL,
	`sellOrderId` int NOT NULL,
	`buyerId` int NOT NULL,
	`sellerId` int NOT NULL,
	`energyWh` int NOT NULL,
	`priceCentsPerKwh` int NOT NULL,
	`totalAmountCents` int NOT NULL,
	`executedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `p2p_matches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ntl_flags` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assetId` int NOT NULL,
	`userId` int NOT NULL,
	`flagType` enum('divergence','bypass_signature','combined') NOT NULL,
	`status` enum('suspected','under_review','confirmed','cleared') NOT NULL DEFAULT 'suspected',
	`riskScore` int NOT NULL,
	`evidence` text NOT NULL,
	`windowStart` timestamp NOT NULL,
	`windowEnd` timestamp NOT NULL,
	`investigatedBy` int,
	`investigatedAt` timestamp,
	`resolutionNotes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ntl_flags_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_alert_dispatch_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`priceAlertId` int NOT NULL,
	`userId` int NOT NULL,
	`country` enum('nigeria','tanzania') NOT NULL,
	`priceType` enum('off_peak','shoulder','peak','super_peak') NOT NULL,
	`observedPrice` int NOT NULL,
	`pushSent` boolean NOT NULL DEFAULT false,
	`smsSent` boolean NOT NULL DEFAULT false,
	`smsTo` varchar(20),
	`error` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `price_alert_dispatch_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `price_alert_market_scopes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`priceAlertId` int NOT NULL,
	`country` enum('nigeria','tanzania') NOT NULL,
	`priceType` enum('off_peak','shoulder','peak','super_peak') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `price_alert_market_scopes_id` PRIMARY KEY(`id`),
	CONSTRAINT `price_alert_market_scopes_priceAlertId_unique` UNIQUE(`priceAlertId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `regulator_reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`generatedBy` int NOT NULL,
	`periodStart` timestamp NOT NULL,
	`periodEnd` timestamp NOT NULL,
	`checksum` varchar(64) NOT NULL,
	`sourceJson` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `regulator_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sms_command_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int,
	`phoneNumber` varchar(20) NOT NULL,
	`resolvedVia` enum('users_phone','payments_phone','unresolved') NOT NULL,
	`direction` enum('inbound') NOT NULL DEFAULT 'inbound',
	`rawText` text NOT NULL,
	`parsedCommand` varchar(32) NOT NULL,
	`replyText` text,
	`replySent` boolean NOT NULL DEFAULT false,
	`replyError` text,
	`providerMessageId` varchar(100),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sms_command_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `allocation_entries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`community_id` int NOT NULL,
	`user_id` int NOT NULL,
	`share_bps` int NOT NULL,
	`generation_wh` int NOT NULL,
	`consumption_wh` int NOT NULL,
	`allocated_value_cents` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `allocation_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `allocation_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`community_id` int NOT NULL,
	`period_start` timestamp NOT NULL,
	`period_end` timestamp NOT NULL,
	`rule_type` varchar(40) NOT NULL,
	`total_generation_wh` int NOT NULL,
	`total_consumption_wh` int NOT NULL,
	`surplus_wh` int NOT NULL,
	`deficit_wh` int NOT NULL,
	`export_price_cents` int NOT NULL,
	`import_price_cents` int NOT NULL,
	`net_value_cents` int NOT NULL,
	`status` enum('computed','finalized') NOT NULL DEFAULT 'computed',
	`run_by` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `allocation_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dr_event_forecasts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`forecast_date` timestamp NOT NULL,
	`weekday` int NOT NULL,
	`likelihood_percent` int NOT NULL,
	`history_frequency_percent` int NOT NULL,
	`demand_trend_percent` int,
	`heat_factor_percent` int,
	`weather_used` boolean NOT NULL DEFAULT false,
	`history_event_count` int NOT NULL,
	`metadata` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dr_event_forecasts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dr_participant_recommendations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`forecast_id` int,
	`event_id` int,
	`recommended_for_date` timestamp,
	`user_id` int NOT NULL,
	`rank_position` int NOT NULL,
	`score_milli` int NOT NULL,
	`compliance_percent` int,
	`flexibility_kw10` int NOT NULL,
	`no_show_count` int NOT NULL,
	`outcome` enum('pending','participated','no_show','declined') NOT NULL DEFAULT 'pending',
	`outcome_recorded_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dr_participant_recommendations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `energy_wallets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`balance_cents` int,
	`low_balance_threshold_cents` int,
	`auto_top_up` boolean NOT NULL DEFAULT false,
	`top_up_amount_cents` int,
	`preferred_method` enum('mpesa','airtel_money','tigo_pesa'),
	`phone_number` varchar(20),
	`last_computed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `energy_wallets_id` PRIMARY KEY(`id`),
	CONSTRAINT `energy_wallets_user_id_unique` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `grid_anomaly_scores` (
	`id` int AUTO_INCREMENT NOT NULL,
	`asset_id` int NOT NULL,
	`metric` enum('power','voltage','frequency') NOT NULL,
	`hour_of_day` int NOT NULL,
	`window_start` timestamp NOT NULL,
	`window_end` timestamp NOT NULL,
	`sample_count` int NOT NULL,
	`baseline_mean_milli` int,
	`baseline_std_milli` int,
	`baseline_samples` int NOT NULL,
	`observed_mean_milli` int NOT NULL,
	`z_score_milli` int,
	`combined_score_milli` int,
	`severity` enum('low','medium','high','critical'),
	`anomaly_event_id` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `grid_anomaly_scores_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pool_allocation_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`community_id` int NOT NULL,
	`rule_type` enum('proportional_consumption','equal','proportional_generation','custom_weights') NOT NULL,
	`custom_weights` text,
	`updated_by` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pool_allocation_rules_id` PRIMARY KEY(`id`),
	CONSTRAINT `pool_allocation_rules_community_id_unique` UNIQUE(`community_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `v2g_schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`ev_id` int NOT NULL,
	`departure_time` timestamp NOT NULL,
	`target_soc_percent` int NOT NULL,
	`min_soc_reserve_percent` int NOT NULL,
	`start_soc_percent` int NOT NULL,
	`battery_capacity_kwh10` int NOT NULL,
	`allow_v2g` boolean NOT NULL DEFAULT false,
	`price_source` enum('market_prices','ml_forecast') NOT NULL,
	`schedule_json` text NOT NULL,
	`energy_to_charge_kwh10` int NOT NULL,
	`expected_cost_cents` int NOT NULL,
	`naive_baseline_cost_cents` int NOT NULL,
	`expected_revenue_cents` int NOT NULL DEFAULT 0,
	`status` enum('draft','active','completed','cancelled') NOT NULL DEFAULT 'draft',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `v2g_schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wallet_balance_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`balance_cents` int NOT NULL,
	`payments_completed_cents` int NOT NULL,
	`billings_issued_cents` int NOT NULL,
	`token_purchases_cents` int NOT NULL,
	`reason` varchar(50) NOT NULL,
	`computed_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `wallet_balance_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wallet_top_up_attempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`amount_cents` int NOT NULL,
	`method` enum('mpesa','airtel_money','tigo_pesa') NOT NULL,
	`phone_number` varchar(20) NOT NULL,
	`trigger_type` enum('auto','manual') NOT NULL,
	`status` enum('initiated','failed','completed') NOT NULL,
	`gateway_transaction_id` varchar(255),
	`gateway_checkout_id` varchar(255),
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`completed_at` timestamp,
	CONSTRAINT `wallet_top_up_attempts_id` PRIMARY KEY(`id`)
);
