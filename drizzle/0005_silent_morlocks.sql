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
