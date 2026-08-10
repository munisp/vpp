CREATE TABLE `achievements` (
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
CREATE TABLE `alerts` (
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
CREATE TABLE `assets` (
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
--> statement-breakpoint
CREATE TABLE `billings` (
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
--> statement-breakpoint
CREATE TABLE `contracts` (
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
CREATE TABLE `demandResponseEvents` (
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
--> statement-breakpoint
CREATE TABLE `dr_automation_rules` (
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
CREATE TABLE `dr_campaigns` (
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
CREATE TABLE `drCompensation` (
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
CREATE TABLE `dr_event_templates` (
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
CREATE TABLE `dr_forecasts` (
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
CREATE TABLE `drParticipants` (
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
CREATE TABLE `drResponses` (
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
CREATE TABLE `grid_monitoring` (
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
CREATE TABLE `leaderboard_entries` (
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
CREATE TABLE `marketPrices` (
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
CREATE TABLE `notification_preferences` (
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
CREATE TABLE `participant_scores` (
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
CREATE TABLE `participant_segments` (
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
--> statement-breakpoint
CREATE TABLE `payment_reconciliations` (
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
CREATE TABLE `payments` (
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
CREATE TABLE `price_alerts` (
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
CREATE TABLE `push_subscriptions` (
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
CREATE TABLE `reconciliation_audit_logs` (
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
CREATE TABLE `reconciliation_reports` (
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
CREATE TABLE `referral_rewards` (
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
CREATE TABLE `referrals` (
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
CREATE TABLE `strategy_templates` (
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
CREATE TABLE `telemetry` (
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
CREATE TABLE `tokens` (
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
CREATE TABLE `trades` (
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
CREATE TABLE `tradingPreferences` (
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
CREATE TABLE `trading_strategies` (
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
CREATE TABLE `user_achievements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`achievement_id` int NOT NULL,
	`unlocked_at` timestamp NOT NULL DEFAULT (now()),
	`notified` boolean NOT NULL DEFAULT false,
	`metadata` text,
	CONSTRAINT `user_achievements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
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
CREATE TABLE `qr_code_history` (
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
