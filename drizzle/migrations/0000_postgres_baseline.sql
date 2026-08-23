CREATE TYPE "public"."alerts_alert_type" AS ENUM('system', 'trading', 'billing', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."alerts_severity" AS ENUM('info', 'warning', 'error', 'critical');--> statement-breakpoint
CREATE TYPE "public"."assets_approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."assets_asset_type" AS ENUM('solar', 'battery', 'meter', 'generator', 'wind');--> statement-breakpoint
CREATE TYPE "public"."assets_status" AS ENUM('active', 'inactive', 'maintenance', 'fault');--> statement-breakpoint
CREATE TYPE "public"."billings_billing_type" AS ENUM('postpaid', 'prepaid');--> statement-breakpoint
CREATE TYPE "public"."billings_status" AS ENUM('draft', 'issued', 'paid', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."contracts_contract_type" AS ENUM('asset_aggregation', 'full_control', 'prepaid');--> statement-breakpoint
CREATE TYPE "public"."contracts_status" AS ENUM('active', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."demandResponseEvents_event_type" AS ENUM('peak_shaving', 'load_shifting', 'emergency', 'economic');--> statement-breakpoint
CREATE TYPE "public"."demandResponseEvents_status" AS ENUM('scheduled', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."device_commands_status" AS ENUM('pending', 'sent', 'acknowledged', 'failed');--> statement-breakpoint
CREATE TYPE "public"."device_logs_event_type" AS ENUM('connected', 'disconnected', 'error', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "public"."devices_device_type" AS ENUM('smart_meter', 'inverter', 'battery_controller', 'sensor');--> statement-breakpoint
CREATE TYPE "public"."devices_status" AS ENUM('online', 'offline', 'error', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."dr_automation_rules_condition" AS ENUM('load_threshold', 'price_threshold', 'grid_frequency', 'renewable_percentage', 'time_based');--> statement-breakpoint
CREATE TYPE "public"."dr_automation_rules_is_enabled" AS ENUM('true', 'false');--> statement-breakpoint
CREATE TYPE "public"."dr_automation_rules_operator" AS ENUM('greater_than', 'less_than', 'equals', 'between');--> statement-breakpoint
CREATE TYPE "public"."drCompensation_currency" AS ENUM('NGN', 'TZS', 'USD');--> statement-breakpoint
CREATE TYPE "public"."drCompensation_payment_method" AS ENUM('mpesa', 'airtel_money', 'tigo_pesa', 'bank_transfer');--> statement-breakpoint
CREATE TYPE "public"."drCompensation_status" AS ENUM('pending', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dr_event_templates_event_type" AS ENUM('peak_shaving', 'load_shifting', 'emergency', 'economic');--> statement-breakpoint
CREATE TYPE "public"."dr_event_templates_is_active" AS ENUM('true', 'false');--> statement-breakpoint
CREATE TYPE "public"."dr_event_templates_trigger_condition" AS ENUM('manual', 'peak_forecast', 'grid_stress', 'price_spike', 'renewable_surplus');--> statement-breakpoint
CREATE TYPE "public"."dr_forecasts_grid_status" AS ENUM('normal', 'stressed', 'critical');--> statement-breakpoint
CREATE TYPE "public"."dr_forecasts_recommended_action" AS ENUM('none', 'monitor', 'prepare_event', 'trigger_event');--> statement-breakpoint
CREATE TYPE "public"."drParticipants_status" AS ENUM('active', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."drResponses_participation_status" AS ENUM('opted_in', 'opted_out', 'auto_enrolled');--> statement-breakpoint
CREATE TYPE "public"."grid_monitoring_grid_status" AS ENUM('normal', 'stressed', 'critical', 'emergency');--> statement-breakpoint
CREATE TYPE "public"."marketPrices_country" AS ENUM('nigeria', 'tanzania');--> statement-breakpoint
CREATE TYPE "public"."marketPrices_price_type" AS ENUM('off_peak', 'shoulder', 'peak', 'super_peak');--> statement-breakpoint
CREATE TYPE "public"."mqtt_broker_credentials_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TYPE "public"."mqtt_broker_credentials_is_active" AS ENUM('true', 'false');--> statement-breakpoint
CREATE TYPE "public"."payment_credentials_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TYPE "public"."payment_credentials_gateway" AS ENUM('mpesa', 'airtel_money', 'tigo_pesa');--> statement-breakpoint
CREATE TYPE "public"."payment_credentials_is_active" AS ENUM('true', 'false');--> statement-breakpoint
CREATE TYPE "public"."payment_credentials_is_validated" AS ENUM('true', 'false');--> statement-breakpoint
CREATE TYPE "public"."payment_gateway_logs_gateway" AS ENUM('mpesa', 'airtel_money', 'tigo_pesa');--> statement-breakpoint
CREATE TYPE "public"."payment_gateway_logs_status" AS ENUM('pending', 'success', 'failed', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."payments_currency" AS ENUM('NGN', 'TZS', 'USD');--> statement-breakpoint
CREATE TYPE "public"."payments_payment_method" AS ENUM('mpesa', 'airtel_money', 'tigo_pesa', 'bank_transfer', 'card');--> statement-breakpoint
CREATE TYPE "public"."payments_payment_type" AS ENUM('invoice', 'token_purchase', 'monthly_fee');--> statement-breakpoint
CREATE TYPE "public"."payments_status" AS ENUM('pending', 'completed', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."tokens_status" AS ENUM('active', 'used', 'expired', 'pending_issuance');--> statement-breakpoint
CREATE TYPE "public"."trades_status" AS ENUM('pending', 'executed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trades_trade_type" AS ENUM('export', 'import', 'p2p_sell', 'p2p_buy');--> statement-breakpoint
CREATE TYPE "public"."trades_trading_mode" AS ENUM('automatic', 'manual', 'p2p');--> statement-breakpoint
CREATE TYPE "public"."tradingPreferences_trading_mode" AS ENUM('automatic', 'manual', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."users_country" AS ENUM('nigeria', 'tanzania');--> statement-breakpoint
CREATE TYPE "public"."users_currency" AS ENUM('NGN', 'TZS', 'USD');--> statement-breakpoint
CREATE TYPE "public"."users_language" AS ENUM('en', 'ha', 'yo', 'ig', 'sw');--> statement-breakpoint
CREATE TYPE "public"."users_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."qr_code_history_operation_type" AS ENUM('scan', 'generate');--> statement-breakpoint
CREATE TYPE "public"."qr_code_history_payment_type" AS ENUM('merchant', 'p2p', 'bill', 'token');--> statement-breakpoint
CREATE TYPE "public"."qr_code_history_status" AS ENUM('pending', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."anomaly_events_anomaly_type" AS ENUM('power_deviation', 'efficiency_drop', 'temperature_abnormal', 'communication_loss', 'voltage_anomaly', 'frequency_deviation', 'soc_inconsistency', 'performance_degradation', 'unusual_pattern', 'sensor_fault', 'overheating', 'power_quality', 'battery_health', 'inverter_fault');--> statement-breakpoint
CREATE TYPE "public"."anomaly_events_recommended_action" AS ENUM('monitor', 'schedule_inspection', 'immediate_inspection', 'reduce_load', 'shutdown');--> statement-breakpoint
CREATE TYPE "public"."anomaly_events_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."anomaly_events_status" AS ENUM('open', 'acknowledged', 'investigating', 'resolved', 'false_positive');--> statement-breakpoint
CREATE TYPE "public"."blockchain_anchors_anchor_type" AS ENUM('settlement_period', 'settlement_event', 'carbon_credit', 'compliance_report', 'data_anchor');--> statement-breakpoint
CREATE TYPE "public"."blockchain_anchors_network" AS ENUM('ethereum', 'polygon', 'arbitrum', 'optimism', 'hedera', 'stellar', 'mock');--> statement-breakpoint
CREATE TYPE "public"."blockchain_anchors_status" AS ENUM('pending', 'submitted', 'confirmed', 'local_committed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."carbon_credits_credit_type" AS ENUM('rec', 'carbon_offset', 'green_certificate', 'i_rec');--> statement-breakpoint
CREATE TYPE "public"."carbon_credits_status" AS ENUM('pending', 'issued', 'transferred', 'retired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."charging_sessions_session_type" AS ENUM('standard_charge', 'smart_charge', 'v2g', 'v2h');--> statement-breakpoint
CREATE TYPE "public"."charging_sessions_status" AS ENUM('starting', 'charging', 'discharging', 'paused', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."charging_stations_connector_type" AS ENUM('type1', 'type2', 'chademo', 'ccs1', 'ccs2', 'tesla');--> statement-breakpoint
CREATE TYPE "public"."charging_stations_ocpp_version" AS ENUM('1.6', '2.0', '2.0.1');--> statement-breakpoint
CREATE TYPE "public"."charging_stations_status" AS ENUM('available', 'occupied', 'charging', 'discharging', 'faulted', 'offline');--> statement-breakpoint
CREATE TYPE "public"."community_allocations_status" AS ENUM('calculated', 'approved', 'distributed', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."community_members_role" AS ENUM('member', 'prosumer', 'admin', 'operator');--> statement-breakpoint
CREATE TYPE "public"."community_members_status" AS ENUM('pending', 'active', 'suspended', 'left');--> statement-breakpoint
CREATE TYPE "public"."compliance_checks_check_type" AS ENUM('automated', 'manual', 'audit');--> statement-breakpoint
CREATE TYPE "public"."compliance_checks_scope_type" AS ENUM('user', 'asset', 'community', 'platform');--> statement-breakpoint
CREATE TYPE "public"."compliance_checks_status" AS ENUM('compliant', 'non_compliant', 'warning', 'not_applicable', 'pending_review');--> statement-breakpoint
CREATE TYPE "public"."compliance_reports_report_type" AS ENUM('periodic', 'incident', 'audit', 'regulatory_filing');--> statement-breakpoint
CREATE TYPE "public"."compliance_reports_status" AS ENUM('draft', 'pending_review', 'submitted', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."compliance_rules_check_frequency" AS ENUM('realtime', 'hourly', 'daily', 'weekly', 'monthly', 'quarterly', 'annually');--> statement-breakpoint
CREATE TYPE "public"."compliance_rules_rule_category" AS ENUM('grid_code', 'market_rules', 'data_privacy', 'safety', 'environmental', 'consumer_protection', 'reporting');--> statement-breakpoint
CREATE TYPE "public"."compliance_rules_status" AS ENUM('active', 'pending', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."der_constraints_constraint_type" AS ENUM('max_power', 'min_power', 'max_energy', 'min_soc', 'max_soc', 'unavailable', 'must_run', 'user_preference');--> statement-breakpoint
CREATE TYPE "public"."der_constraints_source" AS ENUM('user', 'operator', 'system', 'safety', 'grid_code');--> statement-breakpoint
CREATE TYPE "public"."dispatch_schedules_objective_function" AS ENUM('minimize_cost', 'maximize_revenue', 'minimize_emissions', 'maximize_self_consumption', 'balance_grid');--> statement-breakpoint
CREATE TYPE "public"."dispatch_schedules_status" AS ENUM('draft', 'optimized', 'approved', 'dispatching', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."dispatch_setpoints_status" AS ENUM('scheduled', 'dispatched', 'acknowledged', 'executing', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."edge_commands_command_type" AS ENUM('set_power', 'set_soc_target', 'start_charging', 'stop_charging', 'enable_v2g', 'disable_v2g', 'emergency_stop', 'update_config');--> statement-breakpoint
CREATE TYPE "public"."edge_commands_status" AS ENUM('queued', 'sent', 'acknowledged', 'executing', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."edge_gateways_primary_protocol" AS ENUM('mqtt', 'grpc', 'https');--> statement-breakpoint
CREATE TYPE "public"."edge_gateways_status" AS ENUM('online', 'offline', 'degraded', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."electric_vehicles_bidirectional_protocol" AS ENUM('none', 'chademo', 'ccs_v2g', 'iso15118');--> statement-breakpoint
CREATE TYPE "public"."electric_vehicles_status" AS ENUM('active', 'inactive', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."energy_communities_allocation_method" AS ENUM('equal_share', 'proportional_capacity', 'proportional_consumption', 'dynamic_pricing', 'custom');--> statement-breakpoint
CREATE TYPE "public"."energy_communities_community_type" AS ENUM('residential', 'commercial', 'mixed', 'microgrid', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."energy_communities_governance_model" AS ENUM('cooperative', 'utility_managed', 'peer_to_peer', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."energy_communities_islanding_mode" AS ENUM('grid_tied', 'islanded', 'transitioning');--> statement-breakpoint
CREATE TYPE "public"."energy_communities_status" AS ENUM('forming', 'active', 'suspended', 'dissolved');--> statement-breakpoint
CREATE TYPE "public"."forecast_runs_forecast_type" AS ENUM('load', 'solar_generation', 'wind_generation', 'price', 'emissions', 'ev_availability');--> statement-breakpoint
CREATE TYPE "public"."forecast_runs_scope_type" AS ENUM('asset', 'user', 'community', 'region');--> statement-breakpoint
CREATE TYPE "public"."forecast_runs_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."grid_service_products_compensation_type" AS ENUM('energy_only', 'capacity_only', 'capacity_plus_energy', 'performance_based');--> statement-breakpoint
CREATE TYPE "public"."grid_service_products_service_type" AS ENUM('energy_arbitrage', 'capacity', 'frequency_regulation', 'spinning_reserve', 'non_spinning_reserve', 'voltage_support', 'reactive_power', 'congestion_relief', 'peak_shaving', 'load_shifting', 'demand_response', 'black_start');--> statement-breakpoint
CREATE TYPE "public"."health_checks_status" AS ENUM('healthy', 'degraded', 'unhealthy');--> statement-breakpoint
CREATE TYPE "public"."model_drift_events_action_taken" AS ENUM('none', 'alert_sent', 'retrain_triggered', 'model_rolled_back');--> statement-breakpoint
CREATE TYPE "public"."model_drift_events_drift_type" AS ENUM('data_drift', 'concept_drift', 'prediction_drift', 'performance_degradation');--> statement-breakpoint
CREATE TYPE "public"."model_drift_events_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."model_registry_model_type" AS ENUM('load_forecast', 'generation_forecast', 'price_forecast', 'anomaly_detection', 'optimization');--> statement-breakpoint
CREATE TYPE "public"."model_registry_status" AS ENUM('training', 'validating', 'staging', 'production', 'deprecated', 'failed');--> statement-breakpoint
CREATE TYPE "public"."retraining_jobs_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."retraining_jobs_trigger_type" AS ENUM('scheduled', 'drift_detected', 'manual', 'performance_threshold');--> statement-breakpoint
CREATE TYPE "public"."service_enrollments_status" AS ENUM('pending', 'active', 'suspended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."settlement_events_currency" AS ENUM('NGN', 'TZS', 'USD');--> statement-breakpoint
CREATE TYPE "public"."settlement_events_event_type" AS ENUM('dispatch_completed', 'service_delivered', 'measurement_verified', 'compensation_calculated', 'payment_initiated', 'payment_completed', 'dispute_raised', 'dispute_resolved', 'adjustment_applied');--> statement-breakpoint
CREATE TYPE "public"."settlement_events_verification_status" AS ENUM('pending', 'verified', 'disputed', 'adjusted');--> statement-breakpoint
CREATE TYPE "public"."settlement_periods_status" AS ENUM('open', 'closed', 'invoiced', 'paid', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."support_tickets_status" AS ENUM('open', 'in_progress', 'waiting_customer', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."carbon_certificates_emission_factor_source" AS ENUM('live');--> statement-breakpoint
CREATE TYPE "public"."carbon_certificates_status" AS ENUM('minted', 'retired');--> statement-breakpoint
CREATE TYPE "public"."dynamic_tariffs_country" AS ENUM('nigeria', 'tanzania');--> statement-breakpoint
CREATE TYPE "public"."dynamic_tariffs_status" AS ENUM('published', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."energy_advisor_reports_kind" AS ENUM('recommendations', 'weekly_digest');--> statement-breakpoint
CREATE TYPE "public"."allocation_runs_status" AS ENUM('computed', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."dr_participant_recommendations_outcome" AS ENUM('pending', 'participated', 'no_show', 'declined');--> statement-breakpoint
CREATE TYPE "public"."energy_wallets_preferred_method" AS ENUM('mpesa', 'airtel_money', 'tigo_pesa');--> statement-breakpoint
CREATE TYPE "public"."grid_anomaly_scores_metric" AS ENUM('power', 'voltage', 'frequency');--> statement-breakpoint
CREATE TYPE "public"."grid_anomaly_scores_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."pool_allocation_rules_rule_type" AS ENUM('proportional_consumption', 'equal', 'proportional_generation', 'custom_weights');--> statement-breakpoint
CREATE TYPE "public"."v2g_schedules_price_source" AS ENUM('market_prices', 'ml_forecast');--> statement-breakpoint
CREATE TYPE "public"."v2g_schedules_status" AS ENUM('draft', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."wallet_top_up_attempts_method" AS ENUM('mpesa', 'airtel_money', 'tigo_pesa');--> statement-breakpoint
CREATE TYPE "public"."wallet_top_up_attempts_status" AS ENUM('initiated', 'failed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."wallet_top_up_attempts_trigger_type" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."ntl_flags_flag_type" AS ENUM('divergence', 'bypass_signature', 'combined');--> statement-breakpoint
CREATE TYPE "public"."ntl_flags_status" AS ENUM('suspected', 'under_review', 'confirmed', 'cleared');--> statement-breakpoint
CREATE TYPE "public"."price_alert_dispatch_log_country" AS ENUM('nigeria', 'tanzania');--> statement-breakpoint
CREATE TYPE "public"."price_alert_dispatch_log_price_type" AS ENUM('off_peak', 'shoulder', 'peak', 'super_peak');--> statement-breakpoint
CREATE TYPE "public"."price_alert_market_scopes_country" AS ENUM('nigeria', 'tanzania');--> statement-breakpoint
CREATE TYPE "public"."price_alert_market_scopes_price_type" AS ENUM('off_peak', 'shoulder', 'peak', 'super_peak');--> statement-breakpoint
CREATE TYPE "public"."sms_command_log_direction" AS ENUM('inbound');--> statement-breakpoint
CREATE TYPE "public"."sms_command_log_resolved_via" AS ENUM('users_phone', 'payments_phone', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."grid_protocol_instructions_decision" AS ENUM('opt_in', 'opt_out', 'recorded');--> statement-breakpoint
CREATE TYPE "public"."grid_protocol_instructions_source" AS ENUM('openadr', 'sep2');--> statement-breakpoint
CREATE TYPE "public"."ocpp_id_tags_status" AS ENUM('accepted', 'blocked', 'expired', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."achievements_category" AS ENUM('participation', 'performance', 'milestone', 'special');--> statement-breakpoint
CREATE TYPE "public"."achievements_criteria_type" AS ENUM('events_participated', 'total_reduction', 'reliability_score', 'consecutive_events', 'compensation_earned');--> statement-breakpoint
CREATE TYPE "public"."leaderboard_entries_period" AS ENUM('daily', 'weekly', 'monthly', 'all_time');--> statement-breakpoint
CREATE TYPE "public"."audit_logs_action" AS ENUM('create', 'update', 'delete', 'approve', 'reject', 'suspend', 'activate', 'login', 'logout', 'payment', 'trade', 'export', 'import', 'configure');--> statement-breakpoint
CREATE TYPE "public"."audit_logs_entity_type" AS ENUM('user', 'asset', 'trade', 'payment', 'billing', 'alert', 'device', 'dr_event', 'market_price', 'payment_credential', 'system_config');--> statement-breakpoint
CREATE TYPE "public"."audit_logs_status" AS ENUM('success', 'failure', 'pending');--> statement-breakpoint
CREATE TYPE "public"."audit_logs_user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."dr_campaigns_status" AS ENUM('draft', 'scheduled', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."participant_scores_segment" AS ENUM('platinum', 'gold', 'silver', 'bronze', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."notification_preferences_notification_frequency" AS ENUM('instant', 'hourly', 'daily');--> statement-breakpoint
CREATE TYPE "public"."payment_reconciliations_status" AS ENUM('matched', 'unmatched', 'discrepancy', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_audit_logs_action" AS ENUM('created', 'matched', 'flagged_discrepancy', 'manual_review', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_reports_report_type" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."referral_rewards_currency" AS ENUM('NGN', 'TZS', 'USD', 'CREDITS');--> statement-breakpoint
CREATE TYPE "public"."referral_rewards_reward_type" AS ENUM('credits', 'cash', 'discount', 'tokens');--> statement-breakpoint
CREATE TYPE "public"."referral_rewards_status" AS ENUM('pending', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."referrals_reward_currency" AS ENUM('NGN', 'TZS', 'USD', 'CREDITS');--> statement-breakpoint
CREATE TYPE "public"."referrals_reward_type" AS ENUM('credits', 'cash', 'discount', 'tokens');--> statement-breakpoint
CREATE TYPE "public"."referrals_status" AS ENUM('pending', 'completed', 'rewarded', 'expired');--> statement-breakpoint
CREATE TABLE "achievements" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"icon" varchar(50),
	"category" "achievements_category" NOT NULL,
	"criteria_type" "achievements_criteria_type" NOT NULL,
	"criteria_value" integer NOT NULL,
	"reward_points" integer DEFAULT 0 NOT NULL,
	"reward_badge" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"alertType" "alerts_alert_type" NOT NULL,
	"severity" "alerts_severity" DEFAULT 'info' NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"isRead" boolean DEFAULT false NOT NULL,
	"readAt" timestamp,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"assetType" "assets_asset_type" NOT NULL,
	"name" varchar(255) NOT NULL,
	"capacity" integer NOT NULL,
	"make" varchar(255),
	"model" varchar(255),
	"serialNumber" varchar(255),
	"installationDate" timestamp,
	"status" "assets_status" DEFAULT 'active' NOT NULL,
	"approvalStatus" "assets_approval_status" DEFAULT 'pending' NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"user_name" varchar(255),
	"user_role" "audit_logs_user_role" NOT NULL,
	"action" "audit_logs_action" NOT NULL,
	"entity_type" "audit_logs_entity_type" NOT NULL,
	"entity_id" varchar(255),
	"entity_name" varchar(255),
	"changes" text,
	"description" text,
	"ip_address" varchar(45),
	"user_agent" varchar(500),
	"status" "audit_logs_status" DEFAULT 'success' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billings" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"billingType" "billings_billing_type" NOT NULL,
	"periodStart" timestamp NOT NULL,
	"periodEnd" timestamp NOT NULL,
	"generationKwh" integer DEFAULT 0 NOT NULL,
	"consumptionKwh" integer DEFAULT 0 NOT NULL,
	"exportKwh" integer DEFAULT 0 NOT NULL,
	"exportRevenue" integer DEFAULT 0 NOT NULL,
	"selfConsumptionSavings" integer DEFAULT 0 NOT NULL,
	"totalValue" integer DEFAULT 0 NOT NULL,
	"consumerShare" integer DEFAULT 0 NOT NULL,
	"vppCommission" integer DEFAULT 0 NOT NULL,
	"status" "billings_status" DEFAULT 'draft' NOT NULL,
	"paidAt" timestamp,
	"paymentMethod" varchar(50),
	"transactionId" varchar(255),
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "biometric_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"credential_id" varchar(512) NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"device_type" varchar(50),
	"device_name" varchar(255),
	"last_used" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "biometric_credentials_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"contractType" "contracts_contract_type" NOT NULL,
	"revenueSharePercentage" integer DEFAULT 70 NOT NULL,
	"monthlyFee" integer DEFAULT 0 NOT NULL,
	"minimumRevenue" integer DEFAULT 0 NOT NULL,
	"startDate" timestamp NOT NULL,
	"endDate" timestamp,
	"status" "contracts_status" DEFAULT 'active' NOT NULL,
	"signedAt" timestamp DEFAULT now() NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demandResponseEvents" (
	"id" serial PRIMARY KEY NOT NULL,
	"operatorId" integer NOT NULL,
	"eventName" varchar(255) NOT NULL,
	"eventType" "demandResponseEvents_event_type" NOT NULL,
	"targetReduction" integer NOT NULL,
	"startTime" timestamp NOT NULL,
	"endTime" timestamp NOT NULL,
	"compensationRate" integer NOT NULL,
	"status" "demandResponseEvents_status" DEFAULT 'scheduled' NOT NULL,
	"actualReduction" integer,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_commands" (
	"id" serial PRIMARY KEY NOT NULL,
	"deviceId" integer NOT NULL,
	"command" varchar(100) NOT NULL,
	"payload" text,
	"status" "device_commands_status" DEFAULT 'pending' NOT NULL,
	"sentAt" timestamp,
	"acknowledgedAt" timestamp,
	"response" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"deviceId" integer NOT NULL,
	"eventType" "device_logs_event_type" NOT NULL,
	"message" text NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"assetId" integer NOT NULL,
	"deviceId" varchar(255) NOT NULL,
	"deviceType" "devices_device_type" NOT NULL,
	"manufacturer" varchar(255),
	"model" varchar(255),
	"firmwareVersion" varchar(50),
	"mqttClientId" varchar(255),
	"mqttUsername" varchar(255),
	"mqttPasswordHash" text,
	"status" "devices_status" DEFAULT 'offline' NOT NULL,
	"lastSeen" timestamp,
	"lastMessageAt" timestamp,
	"telemetryInterval" integer DEFAULT 5 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "devices_deviceId_unique" UNIQUE("deviceId")
);
--> statement-breakpoint
CREATE TABLE "dr_automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"template_id" integer NOT NULL,
	"condition" "dr_automation_rules_condition" NOT NULL,
	"operator" "dr_automation_rules_operator" NOT NULL,
	"threshold" integer NOT NULL,
	"threshold_max" integer,
	"active_hours_start" integer,
	"active_hours_end" integer,
	"active_days" varchar(50),
	"cooldown_minutes" integer DEFAULT 120 NOT NULL,
	"last_triggered" timestamp,
	"is_enabled" "dr_automation_rules_is_enabled" DEFAULT 'true' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dr_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"eventId" integer,
	"targetSegments" text,
	"minScore" integer,
	"maxParticipants" integer,
	"bonusCompensation" integer,
	"status" "dr_campaigns_status" DEFAULT 'draft' NOT NULL,
	"scheduledStart" timestamp,
	"scheduledEnd" timestamp,
	"participantsInvited" integer DEFAULT 0,
	"participantsAccepted" integer DEFAULT 0,
	"totalReduction" integer,
	"totalCompensation" integer,
	"createdBy" integer NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drCompensation" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"eventId" integer NOT NULL,
	"responseId" integer NOT NULL,
	"amount" integer NOT NULL,
	"currency" "drCompensation_currency" NOT NULL,
	"status" "drCompensation_status" DEFAULT 'pending' NOT NULL,
	"paymentMethod" "drCompensation_payment_method",
	"paymentReference" varchar(255),
	"paidAt" timestamp,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dr_event_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"event_type" "dr_event_templates_event_type" NOT NULL,
	"default_duration" integer NOT NULL,
	"default_target_reduction" integer NOT NULL,
	"default_compensation_rate" integer NOT NULL,
	"trigger_condition" "dr_event_templates_trigger_condition" NOT NULL,
	"trigger_threshold" integer,
	"advance_notice_minutes" integer DEFAULT 60 NOT NULL,
	"notification_channels" text,
	"is_active" "dr_event_templates_is_active" DEFAULT 'true' NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dr_forecasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"forecast_date" timestamp NOT NULL,
	"forecast_hour" integer NOT NULL,
	"predicted_load" integer NOT NULL,
	"predicted_peak" integer NOT NULL,
	"dr_potential" integer NOT NULL,
	"confidence" integer NOT NULL,
	"grid_status" "dr_forecasts_grid_status" NOT NULL,
	"temperature" integer,
	"weather_condition" varchar(50),
	"recommended_action" "dr_forecasts_recommended_action" NOT NULL,
	"recommended_reduction" integer,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drParticipants" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"enrolledAt" timestamp DEFAULT now() NOT NULL,
	"status" "drParticipants_status" DEFAULT 'active' NOT NULL,
	"autoOptIn" boolean DEFAULT true NOT NULL,
	"minCompensation" integer,
	"maxReduction" integer,
	"notificationPreferences" text,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drResponses" (
	"id" serial PRIMARY KEY NOT NULL,
	"eventId" integer NOT NULL,
	"userId" integer NOT NULL,
	"participationStatus" "drResponses_participation_status" NOT NULL,
	"targetReduction" integer,
	"actualReduction" integer,
	"compensation" integer,
	"responseTime" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grid_monitoring" (
	"id" serial PRIMARY KEY NOT NULL,
	"timestamp" timestamp NOT NULL,
	"total_load" integer NOT NULL,
	"peak_load" integer NOT NULL,
	"average_load" integer NOT NULL,
	"total_generation" integer NOT NULL,
	"renewable_generation" integer NOT NULL,
	"renewable_percentage" integer NOT NULL,
	"frequency" integer NOT NULL,
	"voltage" integer NOT NULL,
	"grid_status" "grid_monitoring_grid_status" NOT NULL,
	"spot_price" integer,
	"forecast_price" integer,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"period" "leaderboard_entries_period" NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"rank" integer NOT NULL,
	"score" integer NOT NULL,
	"events_participated" integer DEFAULT 0 NOT NULL,
	"total_reduction" integer DEFAULT 0 NOT NULL,
	"compensation_earned" integer DEFAULT 0 NOT NULL,
	"reliability_score" integer DEFAULT 0 NOT NULL,
	"reward_amount" integer,
	"reward_paid" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketPrices" (
	"id" serial PRIMARY KEY NOT NULL,
	"country" "marketPrices_country" NOT NULL,
	"priceType" "marketPrices_price_type" NOT NULL,
	"price" integer NOT NULL,
	"timestamp" timestamp NOT NULL,
	"validUntil" timestamp NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mqtt_broker_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"environment" "mqtt_broker_credentials_environment" NOT NULL,
	"credentials" text NOT NULL,
	"is_active" "mqtt_broker_credentials_is_active" DEFAULT 'true' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"email_payment_received" boolean DEFAULT true NOT NULL,
	"email_trade_executed" boolean DEFAULT true NOT NULL,
	"email_trade_failed" boolean DEFAULT true NOT NULL,
	"email_system_alert" boolean DEFAULT true NOT NULL,
	"email_achievement_unlocked" boolean DEFAULT true NOT NULL,
	"email_dr_event_reminder" boolean DEFAULT true NOT NULL,
	"email_dr_event_created" boolean DEFAULT true NOT NULL,
	"email_leaderboard_rank_change" boolean DEFAULT true NOT NULL,
	"email_weekly_summary" boolean DEFAULT false NOT NULL,
	"email_monthly_summary" boolean DEFAULT false NOT NULL,
	"push_payment_received" boolean DEFAULT true NOT NULL,
	"push_achievement_unlocked" boolean DEFAULT true NOT NULL,
	"push_dr_event_reminder" boolean DEFAULT true NOT NULL,
	"push_dr_event_created" boolean DEFAULT true NOT NULL,
	"push_leaderboard_rank_change" boolean DEFAULT false NOT NULL,
	"push_trade_executed" boolean DEFAULT true NOT NULL,
	"push_trade_failed" boolean DEFAULT true NOT NULL,
	"push_system_alert" boolean DEFAULT true NOT NULL,
	"push_billing_alert" boolean DEFAULT true NOT NULL,
	"notification_sound" boolean DEFAULT true NOT NULL,
	"notification_frequency" "notification_preferences_notification_frequency" DEFAULT 'instant' NOT NULL,
	"quiet_hours_enabled" boolean DEFAULT false NOT NULL,
	"quiet_hours_start" time DEFAULT '22:00:00',
	"quiet_hours_end" time DEFAULT '08:00:00',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "participant_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"reliabilityScore" integer NOT NULL,
	"responseTimeScore" integer,
	"reductionAccuracyScore" integer NOT NULL,
	"participationRateScore" integer NOT NULL,
	"overallScore" integer NOT NULL,
	"totalEventsParticipated" integer DEFAULT 0 NOT NULL,
	"totalEventsOptedOut" integer DEFAULT 0 NOT NULL,
	"averageReduction" integer,
	"totalCompensationEarned" integer DEFAULT 0 NOT NULL,
	"maxCapacity" integer,
	"averageResponseTime" integer,
	"segment" "participant_scores_segment" NOT NULL,
	"lastCalculated" timestamp DEFAULT now() NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "participant_scores_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "participant_segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"minOverallScore" integer,
	"minReliabilityScore" integer,
	"minParticipationRate" integer,
	"minCapacity" integer,
	"priority" integer DEFAULT 0 NOT NULL,
	"compensationMultiplier" integer DEFAULT 100 NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"gateway" "payment_credentials_gateway" NOT NULL,
	"environment" "payment_credentials_environment" DEFAULT 'sandbox' NOT NULL,
	"credentials" text NOT NULL,
	"is_active" "payment_credentials_is_active" DEFAULT 'false' NOT NULL,
	"is_validated" "payment_credentials_is_validated" DEFAULT 'false' NOT NULL,
	"last_validated" timestamp,
	"validation_error" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_gateway_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_id" integer,
	"gateway" "payment_gateway_logs_gateway" NOT NULL,
	"request_type" varchar(50) NOT NULL,
	"request_payload" text,
	"response_payload" text,
	"status_code" integer,
	"status" "payment_gateway_logs_status" NOT NULL,
	"error_message" text,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_reconciliations" (
	"id" serial PRIMARY KEY NOT NULL,
	"paymentId" integer NOT NULL,
	"reconciliationDate" timestamp NOT NULL,
	"status" "payment_reconciliations_status" NOT NULL,
	"gatewayTransactionId" varchar(255),
	"gatewayAmount" integer,
	"gatewayStatus" varchar(50),
	"gatewayTimestamp" timestamp,
	"dbAmount" integer,
	"dbStatus" varchar(50),
	"dbTimestamp" timestamp,
	"amountDifference" integer,
	"statusMismatch" boolean DEFAULT false,
	"timeDifference" integer,
	"resolvedBy" integer,
	"resolvedAt" timestamp,
	"resolutionNotes" text,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"billingId" integer,
	"paymentType" "payments_payment_type" NOT NULL,
	"amount" integer NOT NULL,
	"currency" "payments_currency" NOT NULL,
	"paymentMethod" "payments_payment_method" NOT NULL,
	"phoneNumber" varchar(20),
	"accountNumber" varchar(100),
	"transactionId" varchar(255),
	"status" "payments_status" DEFAULT 'pending' NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"alertType" varchar(20) NOT NULL,
	"targetPrice" integer,
	"minPrice" integer,
	"maxPrice" integer,
	"isActive" boolean DEFAULT true NOT NULL,
	"notifyEmail" boolean DEFAULT true NOT NULL,
	"notifyPush" boolean DEFAULT true NOT NULL,
	"notifySMS" boolean DEFAULT false NOT NULL,
	"cooldownMinutes" integer DEFAULT 60 NOT NULL,
	"lastTriggeredAt" timestamp,
	"triggerCount" integer DEFAULT 0 NOT NULL,
	"maxTriggers" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"expiration_time" timestamp,
	"user_agent" text,
	"device_type" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscription_endpoint" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"reconciliationId" integer NOT NULL,
	"action" "reconciliation_audit_logs_action" NOT NULL,
	"performedBy" integer,
	"notes" text,
	"previousStatus" varchar(50),
	"newStatus" varchar(50),
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"reportDate" timestamp NOT NULL,
	"reportType" "reconciliation_reports_report_type" NOT NULL,
	"totalPayments" integer NOT NULL,
	"matchedPayments" integer NOT NULL,
	"unmatchedPayments" integer NOT NULL,
	"discrepancies" integer NOT NULL,
	"totalAmount" integer NOT NULL,
	"matchedAmount" integer NOT NULL,
	"discrepancyAmount" integer NOT NULL,
	"gatewayBreakdown" text,
	"generatedBy" integer,
	"generatedAt" timestamp DEFAULT now() NOT NULL,
	"reportFileUrl" varchar(500),
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_rewards" (
	"id" serial PRIMARY KEY NOT NULL,
	"referral_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"reward_type" "referral_rewards_reward_type" NOT NULL,
	"amount" integer NOT NULL,
	"currency" "referral_rewards_currency" NOT NULL,
	"status" "referral_rewards_status" DEFAULT 'pending' NOT NULL,
	"processed_at" timestamp,
	"description" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"referrer_id" integer NOT NULL,
	"referral_code" varchar(20) NOT NULL,
	"referee_id" integer,
	"referee_email" varchar(320),
	"referee_phone" varchar(20),
	"status" "referrals_status" DEFAULT 'pending' NOT NULL,
	"reward_type" "referrals_reward_type" DEFAULT 'credits' NOT NULL,
	"reward_amount" integer DEFAULT 0 NOT NULL,
	"reward_currency" "referrals_reward_currency" DEFAULT 'CREDITS' NOT NULL,
	"completed_at" timestamp,
	"rewarded_at" timestamp,
	"expires_at" timestamp,
	"source" varchar(100),
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "strategy_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" varchar(50) NOT NULL,
	"icon" varchar(50) DEFAULT 'Zap' NOT NULL,
	"conditions" json NOT NULL,
	"tradingMode" varchar(20) DEFAULT 'both' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"expectedPerformance" json,
	"timesCloned" integer DEFAULT 0 NOT NULL,
	"tags" json,
	"difficulty" varchar(20) DEFAULT 'beginner' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry" (
	"id" serial PRIMARY KEY NOT NULL,
	"assetId" integer NOT NULL,
	"timestamp" timestamp NOT NULL,
	"power" integer,
	"energy" integer,
	"voltage" integer,
	"current" integer,
	"frequency" integer,
	"stateOfCharge" integer,
	"temperature" integer,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"paymentId" integer NOT NULL,
	"tokenCode" varchar(50) NOT NULL,
	"energyKwh" integer NOT NULL,
	"amount" integer NOT NULL,
	"validUntil" timestamp NOT NULL,
	"status" "tokens_status" DEFAULT 'active' NOT NULL,
	"usedAt" timestamp,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_tokenCode_unique" UNIQUE("tokenCode")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"tradeType" "trades_trade_type" NOT NULL,
	"tradingMode" "trades_trading_mode" DEFAULT 'automatic' NOT NULL,
	"energy" integer NOT NULL,
	"price" integer NOT NULL,
	"totalAmount" integer NOT NULL,
	"timestamp" timestamp NOT NULL,
	"status" "trades_status" DEFAULT 'pending' NOT NULL,
	"counterpartyId" integer,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tradingPreferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"tradingMode" "tradingPreferences_trading_mode" DEFAULT 'automatic' NOT NULL,
	"minExportPrice" integer,
	"maxImportPrice" integer,
	"minBatteryLevel" integer DEFAULT 20 NOT NULL,
	"maxBatteryLevel" integer DEFAULT 90 NOT NULL,
	"enableP2P" boolean DEFAULT false NOT NULL,
	"enableNotifications" boolean DEFAULT true NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tradingPreferences_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "trading_strategies" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"isActive" boolean DEFAULT false NOT NULL,
	"conditions" json,
	"tradingMode" varchar(20) DEFAULT 'both' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"performanceMetrics" json,
	"backtestResults" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastActivatedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "user_achievements" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"achievement_id" integer NOT NULL,
	"unlocked_at" timestamp DEFAULT now() NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"phone" varchar(20),
	"loginMethod" varchar(64),
	"role" "users_role" DEFAULT 'user' NOT NULL,
	"country" "users_country" DEFAULT 'nigeria' NOT NULL,
	"currency" "users_currency" DEFAULT 'NGN' NOT NULL,
	"language" "users_language" DEFAULT 'en' NOT NULL,
	"timezone" varchar(50) DEFAULT 'Africa/Lagos' NOT NULL,
	"onboardingCompleted" boolean DEFAULT false NOT NULL,
	"onboardingStep" integer DEFAULT 0 NOT NULL,
	"onboardingSkipped" boolean DEFAULT false NOT NULL,
	"consent_given" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
--> statement-breakpoint
CREATE TABLE "qr_code_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"operation_type" "qr_code_history_operation_type" NOT NULL,
	"payment_type" "qr_code_history_payment_type" NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"currency" varchar(10) NOT NULL,
	"merchant_id" varchar(255),
	"merchant_name" varchar(255),
	"recipient_id" varchar(255),
	"recipient_name" varchar(255),
	"bill_id" varchar(255),
	"bill_type" varchar(100),
	"reference" varchar(255),
	"description" text,
	"qr_code_data" text NOT NULL,
	"qr_code_image" text,
	"status" "qr_code_history_status" DEFAULT 'pending' NOT NULL,
	"scanned_at" timestamp,
	"generated_at" timestamp,
	"completed_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anomaly_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"detected_at" timestamp NOT NULL,
	"anomaly_type" "anomaly_events_anomaly_type" NOT NULL,
	"severity" "anomaly_events_severity" NOT NULL,
	"detection_method" varchar(50),
	"confidence_score" integer,
	"measured_value" integer,
	"expected_value" integer,
	"deviation_percent" integer,
	"estimated_impact" text,
	"recommended_action" "anomaly_events_recommended_action" DEFAULT 'monitor' NOT NULL,
	"metric_name" varchar(64),
	"description" text,
	"maintenance_required" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp,
	"acknowledged_by" integer,
	"status" "anomaly_events_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp,
	"resolution_notes" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blockchain_anchors" (
	"id" serial PRIMARY KEY NOT NULL,
	"anchor_type" "blockchain_anchors_anchor_type" NOT NULL,
	"source_id" integer NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"merkle_root" varchar(64),
	"blockchain_network" "blockchain_anchors_network" NOT NULL,
	"transaction_hash" varchar(128),
	"block_number" bigint,
	"anchored_at" timestamp,
	"status" "blockchain_anchors_status" DEFAULT 'pending' NOT NULL,
	"gas_used" bigint,
	"cost_wei" varchar(40),
	"verification_url" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carbon_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"credit_type" "carbon_credits_credit_type" NOT NULL,
	"certificate_id" varchar(100),
	"energy_mwh" integer,
	"carbon_tonnes" integer,
	"generation_source" varchar(100),
	"generation_period_start" timestamp,
	"generation_period_end" timestamp,
	"registry" varchar(100),
	"registry_url" varchar(255),
	"status" "carbon_credits_status" DEFAULT 'pending' NOT NULL,
	"blockchain_proof" varchar(66),
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charging_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ev_id" integer NOT NULL,
	"station_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp,
	"start_soc_percent" integer,
	"end_soc_percent" integer,
	"energy_delivered_wh" integer DEFAULT 0 NOT NULL,
	"energy_exported_wh" integer DEFAULT 0 NOT NULL,
	"max_power_kw" integer,
	"avg_power_kw" integer,
	"session_type" charging_sessions_session_type DEFAULT 'standard_charge' NOT NULL,
	"target_soc_percent" integer,
	"departure_time" timestamp,
	"total_cost" integer,
	"total_revenue" integer,
	"status" charging_sessions_status DEFAULT 'starting' NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "charging_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "charging_stations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"site_id" integer,
	"station_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"address" text,
	"connector_type" charging_stations_connector_type NOT NULL,
	"max_power_kw" integer NOT NULL,
	"v2g_capable" boolean DEFAULT false NOT NULL,
	"ocpp_version" charging_stations_ocpp_version,
	"ocpp_endpoint" varchar(255),
	"status" charging_stations_status DEFAULT 'offline' NOT NULL,
	"last_heartbeat" timestamp,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "charging_stations_station_id_unique" UNIQUE("station_id")
);
--> statement-breakpoint
CREATE TABLE "community_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"total_generation_wh" integer DEFAULT 0 NOT NULL,
	"total_consumption_wh" integer DEFAULT 0 NOT NULL,
	"total_export_wh" integer DEFAULT 0 NOT NULL,
	"total_import_wh" integer DEFAULT 0 NOT NULL,
	"total_revenue" integer DEFAULT 0 NOT NULL,
	"total_cost" integer DEFAULT 0 NOT NULL,
	"net_value" integer DEFAULT 0 NOT NULL,
	"member_allocations" text NOT NULL,
	"status" "community_allocations_status" DEFAULT 'calculated' NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "community_members_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"contributed_capacity_kw" integer DEFAULT 0 NOT NULL,
	"share_percentage" integer,
	"auto_participate" boolean DEFAULT true NOT NULL,
	"priority_level" integer DEFAULT 5 NOT NULL,
	"status" "community_members_status" DEFAULT 'pending' NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"check_type" "compliance_checks_check_type" DEFAULT 'automated' NOT NULL,
	"scope_type" "compliance_checks_scope_type" NOT NULL,
	"scope_id" integer,
	"checked_at" timestamp NOT NULL,
	"checked_by" varchar(64),
	"next_check_due" timestamp,
	"status" "compliance_checks_status" NOT NULL,
	"findings" text,
	"evidence_references" text,
	"recommended_actions" text,
	"reviewed_by" integer,
	"reviewed_at" timestamp,
	"resolved_at" timestamp,
	"resolution_notes" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" varchar(64) NOT NULL,
	"report_type" "compliance_reports_report_type" NOT NULL,
	"jurisdiction" varchar(100) NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"submitted_at" timestamp,
	"submitted_to" varchar(255),
	"status" "compliance_reports_status" DEFAULT 'draft' NOT NULL,
	"sections" text NOT NULL,
	"attachments" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_reports_report_id_unique" UNIQUE("report_id")
);
--> statement-breakpoint
CREATE TABLE "compliance_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_code" varchar(50) NOT NULL,
	"rule_name" varchar(255) NOT NULL,
	"jurisdiction" varchar(100) NOT NULL,
	"regulatory_body" varchar(255),
	"rule_category" "compliance_rules_rule_category" NOT NULL,
	"description" text NOT NULL,
	"requirements" text NOT NULL,
	"applies_to_asset_types" text,
	"applies_to_service_types" text,
	"check_frequency" "compliance_rules_check_frequency" NOT NULL,
	"automated_check_enabled" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp NOT NULL,
	"effective_until" timestamp,
	"penalty_description" text,
	"status" "compliance_rules_status" DEFAULT 'active' NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_rules_rule_code_unique" UNIQUE("rule_code")
);
--> statement-breakpoint
CREATE TABLE "der_capabilities" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"max_power_export" integer,
	"max_power_import" integer,
	"min_power_export" integer,
	"min_power_import" integer,
	"ramp_rate_up" integer,
	"ramp_rate_down" integer,
	"max_soc" integer,
	"min_soc" integer,
	"round_trip_efficiency" integer,
	"response_time_ms" integer,
	"minimum_run_time" integer,
	"minimum_off_time" integer,
	"can_provide_frequency_response" boolean DEFAULT false NOT NULL,
	"can_provide_voltage_support" boolean DEFAULT false NOT NULL,
	"can_provide_reserves" boolean DEFAULT false NOT NULL,
	"can_provide_peak_shaving" boolean DEFAULT true NOT NULL,
	"protocols" text,
	"certifications" text,
	"grid_code_compliance" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "der_constraints" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"valid_from" timestamp NOT NULL,
	"valid_until" timestamp NOT NULL,
	"constraint_type" "der_constraints_constraint_type" NOT NULL,
	"constraint_value" integer,
	"priority" integer DEFAULT 5 NOT NULL,
	"source" "der_constraints_source" NOT NULL,
	"reason" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" varchar(64) NOT NULL,
	"schedule_start" timestamp NOT NULL,
	"schedule_end" timestamp NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"optimization_run_id" varchar(64),
	"objective_function" "dispatch_schedules_objective_function" NOT NULL,
	"status" "dispatch_schedules_status" DEFAULT 'draft' NOT NULL,
	"total_expected_revenue" integer,
	"total_expected_cost" integer,
	"total_expected_emissions_saved" integer,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dispatch_schedules_schedule_id_unique" UNIQUE("schedule_id")
);
--> statement-breakpoint
CREATE TABLE "dispatch_setpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"interval_start" timestamp NOT NULL,
	"interval_end" timestamp NOT NULL,
	"target_power_watts" integer NOT NULL,
	"target_soc_percent" integer,
	"service_product_id" integer,
	"status" "dispatch_setpoints_status" DEFAULT 'scheduled' NOT NULL,
	"actual_power_watts" integer,
	"actual_soc_percent" integer,
	"dispatched_at" timestamp,
	"acknowledged_at" timestamp,
	"completed_at" timestamp,
	"deviation_watts" integer,
	"performance_score" integer,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edge_commands" (
	"id" serial PRIMARY KEY NOT NULL,
	"gateway_id" integer NOT NULL,
	"command_id" varchar(64) NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	"target_device_id" integer,
	"target_asset_id" integer,
	"command_type" "edge_commands_command_type" NOT NULL,
	"command_payload" text NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"valid_until" timestamp NOT NULL,
	"status" "edge_commands_status" DEFAULT 'queued' NOT NULL,
	"queued_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"acknowledged_at" timestamp,
	"completed_at" timestamp,
	"response_payload" text,
	"error_message" text,
	"response_signature" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "edge_commands_command_id_unique" UNIQUE("command_id")
);
--> statement-breakpoint
CREATE TABLE "edge_gateways" (
	"id" serial PRIMARY KEY NOT NULL,
	"gateway_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"site_id" integer,
	"community_id" integer,
	"hardware_model" varchar(100),
	"firmware_version" varchar(50),
	"primary_protocol" "edge_gateways_primary_protocol" DEFAULT 'mqtt' NOT NULL,
	"connection_endpoint" varchar(255),
	"can_operate_offline" boolean DEFAULT true NOT NULL,
	"local_storage_capacity_mb" integer,
	"max_managed_devices" integer,
	"certificate_fingerprint" varchar(64),
	"last_certificate_rotation" timestamp,
	"status" "edge_gateways_status" DEFAULT 'offline' NOT NULL,
	"last_heartbeat" timestamp,
	"offline_mode" boolean DEFAULT false NOT NULL,
	"pending_commands_count" integer DEFAULT 0 NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "edge_gateways_gateway_id_unique" UNIQUE("gateway_id")
);
--> statement-breakpoint
CREATE TABLE "electric_vehicles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"vin" varchar(17),
	"make" varchar(100),
	"model" varchar(100),
	"year" integer,
	"battery_capacity_kwh" integer,
	"usable_battery_kwh" integer,
	"max_charging_power_kw" integer,
	"max_discharging_power_kw" integer,
	"v2g_capable" boolean DEFAULT false NOT NULL,
	"v2h_capable" boolean DEFAULT false NOT NULL,
	"bidirectional_protocol" "electric_vehicles_bidirectional_protocol" DEFAULT 'none' NOT NULL,
	"current_soc_percent" integer,
	"last_known_location" varchar(255),
	"is_plugged_in" boolean DEFAULT false NOT NULL,
	"is_charging" boolean DEFAULT false NOT NULL,
	"min_soc_percent" integer DEFAULT 2000 NOT NULL,
	"target_soc_percent" integer DEFAULT 8000 NOT NULL,
	"status" "electric_vehicles_status" DEFAULT 'active' NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emissions_factors" (
	"id" serial PRIMARY KEY NOT NULL,
	"region" varchar(50) NOT NULL,
	"timestamp" timestamp NOT NULL,
	"valid_until" timestamp NOT NULL,
	"marginal_emissions" integer NOT NULL,
	"average_emissions" integer NOT NULL,
	"renewable_percent" integer,
	"coal_percent" integer,
	"gas_percent" integer,
	"nuclear_percent" integer,
	"data_source" varchar(100),
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "energy_communities" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_code" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"community_type" "energy_communities_community_type" NOT NULL,
	"region" varchar(100),
	"grid_connection_point" varchar(100),
	"governance_model" "energy_communities_governance_model" DEFAULT 'cooperative' NOT NULL,
	"has_shared_battery" boolean DEFAULT false NOT NULL,
	"has_shared_solar" boolean DEFAULT false NOT NULL,
	"shared_capacity_kw" integer,
	"can_island" boolean DEFAULT false NOT NULL,
	"islanding_mode" "energy_communities_islanding_mode" DEFAULT 'grid_tied' NOT NULL,
	"allocation_method" "energy_communities_allocation_method" DEFAULT 'proportional_capacity' NOT NULL,
	"status" "energy_communities_status" DEFAULT 'forming' NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "energy_communities_community_code_unique" UNIQUE("community_code")
);
--> statement-breakpoint
CREATE TABLE "forecast_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" varchar(64) NOT NULL,
	"forecast_type" "forecast_runs_forecast_type" NOT NULL,
	"scope_type" "forecast_runs_scope_type" NOT NULL,
	"scope_id" integer,
	"region" varchar(50),
	"model_version" varchar(50) NOT NULL,
	"model_type" varchar(50),
	"features" text,
	"forecast_horizon_hours" integer NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"mae_value" integer,
	"rmse_value" integer,
	"mape_value" integer,
	"status" "forecast_runs_status" DEFAULT 'running' NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_runs_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "forecast_values" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"forecast_time" timestamp NOT NULL,
	"p10_value" integer NOT NULL,
	"p50_value" integer NOT NULL,
	"p90_value" integer NOT NULL,
	"mean_value" integer,
	"confidence_score" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grid_service_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_code" varchar(50) NOT NULL,
	"service_name" varchar(255) NOT NULL,
	"service_type" "grid_service_products_service_type" NOT NULL,
	"market_region" varchar(50) NOT NULL,
	"min_capacity_kw" integer,
	"max_response_time_ms" integer,
	"min_duration_minutes" integer,
	"telemetry_interval_seconds" integer,
	"compensation_type" "grid_service_products_compensation_type" NOT NULL,
	"base_rate_cents" integer,
	"performance_multiplier" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grid_service_products_service_code_unique" UNIQUE("service_code")
);
--> statement-breakpoint
CREATE TABLE "health_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"component" varchar(64) NOT NULL,
	"status" "health_checks_status" NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	"latency_ms" integer,
	"details" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "model_drift_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer NOT NULL,
	"detected_at" timestamp NOT NULL,
	"drift_type" "model_drift_events_drift_type" NOT NULL,
	"psi_score" integer,
	"kl_divergence" integer,
	"current_mae" integer,
	"baseline_mae" integer,
	"severity" "model_drift_events_severity" NOT NULL,
	"action_taken" "model_drift_events_action_taken" DEFAULT 'none' NOT NULL,
	"metric_name" varchar(64),
	"current_value" integer,
	"baseline_value" integer,
	"threshold" integer,
	"window_start" timestamp,
	"window_end" timestamp,
	"affected_features" text,
	"recommended_action" text,
	"resolved_at" timestamp,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"predicted_value" numeric(18, 6) NOT NULL,
	"actual_value" numeric(18, 6),
	"latency_ms" integer,
	"features" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_registry" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_name" varchar(100) NOT NULL,
	"model_version" varchar(50) NOT NULL,
	"model_type" "model_registry_model_type" NOT NULL,
	"artifact_path" varchar(500),
	"artifact_hash" varchar(64),
	"training_data_start" timestamp,
	"training_data_end" timestamp,
	"training_duration_seconds" integer,
	"framework" varchar(50),
	"input_schema" text,
	"output_schema" text,
	"hyperparameters" text,
	"training_samples" integer,
	"validation_metrics" text,
	"validation_mae" integer,
	"validation_rmse" integer,
	"validation_mape" integer,
	"status" "model_registry_status" DEFAULT 'training' NOT NULL,
	"deployed_at" timestamp,
	"deprecated_at" timestamp,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retraining_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer NOT NULL,
	"job_id" varchar(64) NOT NULL,
	"trigger_type" "retraining_jobs_trigger_type" NOT NULL,
	"triggered_by" varchar(64),
	"status" "retraining_jobs_status" DEFAULT 'queued' NOT NULL,
	"training_config" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"new_model_version" varchar(50),
	"metrics" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "retraining_jobs_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "service_enrollments" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"service_product_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"enrolled_capacity_kw" integer NOT NULL,
	"status" "service_enrollments_status" DEFAULT 'pending' NOT NULL,
	"enrolled_at" timestamp DEFAULT now() NOT NULL,
	"effective_from" timestamp NOT NULL,
	"effective_until" timestamp,
	"total_dispatches_count" integer DEFAULT 0 NOT NULL,
	"successful_dispatches_count" integer DEFAULT 0 NOT NULL,
	"performance_score" integer DEFAULT 100 NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_hash" varchar(64) NOT NULL,
	"previous_hash" varchar(64) NOT NULL,
	"sequence_number" bigint NOT NULL,
	"event_type" "settlement_events_event_type" NOT NULL,
	"user_id" integer NOT NULL,
	"counterparty_id" integer,
	"source_type" varchar(50) NOT NULL,
	"source_id" integer NOT NULL,
	"energy_wh" integer,
	"power_kw" integer,
	"duration_minutes" integer,
	"rate_per_unit" integer,
	"gross_amount" integer,
	"fees" integer,
	"net_amount" integer,
	"currency" "settlement_events_currency" NOT NULL,
	"measurement_method" varchar(50),
	"baseline_method" varchar(50),
	"verification_status" "settlement_events_verification_status" DEFAULT 'pending' NOT NULL,
	"event_data" text NOT NULL,
	"blockchain_tx_hash" varchar(66),
	"anchored_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_events_event_hash_unique" UNIQUE("event_hash"),
	CONSTRAINT "settlement_events_previous_hash_unique" UNIQUE("previous_hash"),
	CONSTRAINT "settlement_events_sequence_number_unique" UNIQUE("sequence_number")
);
--> statement-breakpoint
CREATE TABLE "settlement_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"total_energy_exported_wh" integer DEFAULT 0 NOT NULL,
	"total_energy_imported_wh" integer DEFAULT 0 NOT NULL,
	"total_services_delivered" integer DEFAULT 0 NOT NULL,
	"gross_revenue" integer DEFAULT 0 NOT NULL,
	"platform_fees" integer DEFAULT 0 NOT NULL,
	"grid_charges" integer DEFAULT 0 NOT NULL,
	"net_revenue" integer DEFAULT 0 NOT NULL,
	"emissions_saved_grams" integer DEFAULT 0 NOT NULL,
	"renewable_energy_wh" integer DEFAULT 0 NOT NULL,
	"status" "settlement_periods_status" DEFAULT 'open' NOT NULL,
	"period_hash" varchar(64),
	"event_count" integer DEFAULT 0 NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_number" varchar(32) NOT NULL,
	"user_id" integer NOT NULL,
	"asset_id" integer,
	"category" varchar(50) NOT NULL,
	"priority" varchar(20) DEFAULT 'normal' NOT NULL,
	"subject" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"status" "support_tickets_status" DEFAULT 'open' NOT NULL,
	"assigned_to" integer,
	"first_response_at" timestamp,
	"resolved_at" timestamp,
	"resolution_notes" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_ticket_number_unique" UNIQUE("ticket_number")
);
--> statement-breakpoint
CREATE TABLE "battery_health_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"assetId" integer NOT NULL,
	"userId" integer NOT NULL,
	"windowStart" timestamp,
	"windowEnd" timestamp,
	"sampleCount" integer NOT NULL,
	"fullCycleEquivalentsMilli" integer,
	"roundTripEfficiencyPct100" integer,
	"estimatedSohPct100" integer,
	"weeklyDegradationSlopePct100" integer,
	"chargeEnergyWh" integer,
	"dischargeEnergyWh" integer,
	"warrantyRisk" boolean DEFAULT false NOT NULL,
	"warrantyRiskReasons" json NOT NULL,
	"insufficientData" boolean DEFAULT false NOT NULL,
	"computedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carbon_certificates" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"sequence" integer NOT NULL,
	"certificateHash" varchar(64) NOT NULL,
	"region" varchar(50) NOT NULL,
	"energyWh" integer NOT NULL,
	"emissionFactorGramsPerKwh" integer NOT NULL,
	"emissionFactorSource" "carbon_certificates_emission_factor_source" NOT NULL,
	"co2AvoidedGrams" integer NOT NULL,
	"periodStart" timestamp NOT NULL,
	"periodEnd" timestamp NOT NULL,
	"status" "carbon_certificates_status" DEFAULT 'minted' NOT NULL,
	"metadata" text,
	"mintedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "carbon_certificates_certificateHash_unique" UNIQUE("certificateHash")
);
--> statement-breakpoint
CREATE TABLE "dynamic_tariffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"country" "dynamic_tariffs_country" NOT NULL,
	"version" integer NOT NULL,
	"status" "dynamic_tariffs_status" DEFAULT 'published' NOT NULL,
	"effectiveFrom" timestamp NOT NULL,
	"periods" json NOT NULL,
	"learnedFrom" json NOT NULL,
	"publishedBy" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "energy_advisor_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"kind" "energy_advisor_reports_kind" NOT NULL,
	"periodStart" timestamp NOT NULL,
	"periodEnd" timestamp NOT NULL,
	"facts" json NOT NULL,
	"llmAvailable" boolean NOT NULL,
	"llmModel" varchar(100),
	"llmError" text,
	"recommendations" json NOT NULL,
	"ruleBasedTips" json NOT NULL,
	"digest" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "p2p_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"buyOrderId" integer NOT NULL,
	"sellOrderId" integer NOT NULL,
	"buyerId" integer NOT NULL,
	"sellerId" integer NOT NULL,
	"energyWh" integer NOT NULL,
	"priceCentsPerKwh" integer NOT NULL,
	"totalAmountCents" integer NOT NULL,
	"executedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocation_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"community_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"share_bps" integer NOT NULL,
	"generation_wh" integer NOT NULL,
	"consumption_wh" integer NOT NULL,
	"allocated_value_cents" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"rule_type" varchar(40) NOT NULL,
	"total_generation_wh" integer NOT NULL,
	"total_consumption_wh" integer NOT NULL,
	"surplus_wh" integer NOT NULL,
	"deficit_wh" integer NOT NULL,
	"export_price_cents" integer NOT NULL,
	"import_price_cents" integer NOT NULL,
	"net_value_cents" integer NOT NULL,
	"status" "allocation_runs_status" DEFAULT 'computed' NOT NULL,
	"run_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dr_event_forecasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"forecast_date" timestamp NOT NULL,
	"weekday" integer NOT NULL,
	"likelihood_percent" integer NOT NULL,
	"history_frequency_percent" integer NOT NULL,
	"demand_trend_percent" integer,
	"heat_factor_percent" integer,
	"weather_used" boolean DEFAULT false NOT NULL,
	"history_event_count" integer NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dr_participant_recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"forecast_id" integer,
	"event_id" integer,
	"recommended_for_date" timestamp,
	"user_id" integer NOT NULL,
	"rank_position" integer NOT NULL,
	"score_milli" integer NOT NULL,
	"compliance_percent" integer,
	"flexibility_kw10" integer NOT NULL,
	"no_show_count" integer NOT NULL,
	"outcome" "dr_participant_recommendations_outcome" DEFAULT 'pending' NOT NULL,
	"outcome_recorded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "energy_wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"balance_cents" integer,
	"low_balance_threshold_cents" integer,
	"auto_top_up" boolean DEFAULT false NOT NULL,
	"top_up_amount_cents" integer,
	"preferred_method" "energy_wallets_preferred_method",
	"phone_number" varchar(20),
	"last_computed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "energy_wallets_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "grid_anomaly_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"metric" "grid_anomaly_scores_metric" NOT NULL,
	"hour_of_day" integer NOT NULL,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"sample_count" integer NOT NULL,
	"baseline_mean_milli" integer,
	"baseline_std_milli" integer,
	"baseline_samples" integer NOT NULL,
	"observed_mean_milli" integer NOT NULL,
	"z_score_milli" integer,
	"combined_score_milli" integer,
	"severity" "grid_anomaly_scores_severity",
	"anomaly_event_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_allocation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"rule_type" "pool_allocation_rules_rule_type" NOT NULL,
	"custom_weights" text,
	"updated_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pool_allocation_rules_community_id_unique" UNIQUE("community_id")
);
--> statement-breakpoint
CREATE TABLE "v2g_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"ev_id" integer NOT NULL,
	"departure_time" timestamp NOT NULL,
	"target_soc_percent" integer NOT NULL,
	"min_soc_reserve_percent" integer NOT NULL,
	"start_soc_percent" integer NOT NULL,
	"battery_capacity_kwh10" integer NOT NULL,
	"allow_v2g" boolean DEFAULT false NOT NULL,
	"price_source" "v2g_schedules_price_source" NOT NULL,
	"schedule_json" text NOT NULL,
	"energy_to_charge_kwh10" integer NOT NULL,
	"expected_cost_cents" integer NOT NULL,
	"naive_baseline_cost_cents" integer NOT NULL,
	"expected_revenue_cents" integer DEFAULT 0 NOT NULL,
	"status" "v2g_schedules_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_balance_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"balance_cents" integer NOT NULL,
	"payments_completed_cents" integer NOT NULL,
	"billings_issued_cents" integer NOT NULL,
	"token_purchases_cents" integer NOT NULL,
	"top_ups_completed_cents" integer DEFAULT 0 NOT NULL,
	"reason" varchar(50) NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_top_up_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "wallet_top_up_attempts_method" NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"trigger_type" "wallet_top_up_attempts_trigger_type" NOT NULL,
	"status" "wallet_top_up_attempts_status" NOT NULL,
	"gateway_transaction_id" varchar(255),
	"gateway_checkout_id" varchar(255),
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ntl_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"assetId" integer NOT NULL,
	"userId" integer NOT NULL,
	"flagType" "ntl_flags_flag_type" NOT NULL,
	"status" "ntl_flags_status" DEFAULT 'suspected' NOT NULL,
	"riskScore" integer NOT NULL,
	"evidence" text NOT NULL,
	"windowStart" timestamp NOT NULL,
	"windowEnd" timestamp NOT NULL,
	"investigatedBy" integer,
	"investigatedAt" timestamp,
	"resolutionNotes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_alert_dispatch_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"priceAlertId" integer NOT NULL,
	"userId" integer NOT NULL,
	"country" "price_alert_dispatch_log_country" NOT NULL,
	"priceType" "price_alert_dispatch_log_price_type" NOT NULL,
	"observedPrice" integer NOT NULL,
	"pushSent" boolean DEFAULT false NOT NULL,
	"smsSent" boolean DEFAULT false NOT NULL,
	"smsTo" varchar(20),
	"error" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_alert_market_scopes" (
	"id" serial PRIMARY KEY NOT NULL,
	"priceAlertId" integer NOT NULL,
	"country" "price_alert_market_scopes_country" NOT NULL,
	"priceType" "price_alert_market_scopes_price_type" NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "price_alert_market_scopes_priceAlertId_unique" UNIQUE("priceAlertId")
);
--> statement-breakpoint
CREATE TABLE "regulator_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"generatedBy" integer NOT NULL,
	"periodStart" timestamp NOT NULL,
	"periodEnd" timestamp NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"sourceJson" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_command_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer,
	"phoneNumber" varchar(20) NOT NULL,
	"resolvedVia" "sms_command_log_resolved_via" NOT NULL,
	"direction" "sms_command_log_direction" DEFAULT 'inbound' NOT NULL,
	"rawText" text NOT NULL,
	"parsedCommand" varchar(32) NOT NULL,
	"replyText" text,
	"replySent" boolean DEFAULT false NOT NULL,
	"replyError" text,
	"providerMessageId" varchar(100),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grid_protocol_instructions" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" "grid_protocol_instructions_source" NOT NULL,
	"external_id" varchar(128) NOT NULL,
	"modification_number" integer DEFAULT 0 NOT NULL,
	"program_ref" varchar(191),
	"event_status" varchar(32) NOT NULL,
	"priority" integer,
	"start_time" timestamp NOT NULL,
	"duration_seconds" integer NOT NULL,
	"target_watts" integer,
	"target_percent" integer,
	"decision" "grid_protocol_instructions_decision" NOT NULL,
	"decision_reason" text NOT NULL,
	"payload" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grid_instruction_revision" UNIQUE("source","external_id","modification_number")
);
--> statement-breakpoint
CREATE TABLE "ocpp_id_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"id_tag" varchar(64) NOT NULL,
	"user_id" integer NOT NULL,
	"ev_id" integer,
	"status" "ocpp_id_tags_status" DEFAULT 'accepted' NOT NULL,
	"expiry_date" timestamp,
	"parent_id_tag" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ocpp_id_tags_id_tag_unique" UNIQUE("id_tag")
);
--> statement-breakpoint
CREATE INDEX "push_subscription_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "blockchain_anchors_source_idx" ON "blockchain_anchors" USING btree ("anchor_type","source_id");--> statement-breakpoint
CREATE INDEX "blockchain_anchors_status_idx" ON "blockchain_anchors" USING btree ("status");--> statement-breakpoint
CREATE INDEX "compliance_reports_jurisdiction_period_idx" ON "compliance_reports" USING btree ("jurisdiction","period_start");--> statement-breakpoint
CREATE INDEX "health_checks_component_checked_idx" ON "health_checks" USING btree ("component","checked_at");--> statement-breakpoint
CREATE INDEX "model_predictions_model_created_idx" ON "model_predictions" USING btree ("model_id","created_at");--> statement-breakpoint
CREATE INDEX "model_predictions_input_hash_idx" ON "model_predictions" USING btree ("input_hash");--> statement-breakpoint
CREATE INDEX "support_tickets_user_status_idx" ON "support_tickets" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "grid_instruction_start_idx" ON "grid_protocol_instructions" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "ocpp_id_tags_user_idx" ON "ocpp_id_tags" USING btree ("user_id");