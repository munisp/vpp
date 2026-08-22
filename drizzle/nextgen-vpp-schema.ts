/**
 * Next-Generation VPP Platform Schema
 * 
 * Foundation layer for advanced VPP features including:
 * - DER capabilities and constraints
 * - Multi-service optimization
 * - Settlement ledger with hash chaining
 * - Market adapters and programs
 * - EV/V2G support
 * - Community energy
 * - Carbon tracking
 * - Edge orchestration
 */

import {
  bigint,
  boolean,
  decimal,
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const anomalyEventsStatusEnum = pgEnum("anomaly_events_status", ["open", "acknowledged", "investigating", "resolved", "false_positive"]);
export const anomalyEventsRecommendedActionEnum = pgEnum("anomaly_events_recommended_action", [
    "monitor",
    "schedule_inspection",
    "immediate_inspection",
    "reduce_load",
    "shutdown"
  ]);
export const anomalyEventsSeverityEnum = pgEnum("anomaly_events_severity", ["low", "medium", "high", "critical"]);
export const anomalyEventsAnomalyTypeEnum = pgEnum("anomaly_events_anomaly_type", [
    "power_deviation",
    "efficiency_drop",
    "temperature_abnormal",
    "communication_loss",
    "voltage_anomaly",
    "frequency_deviation",
    "soc_inconsistency",
    "performance_degradation",
    "unusual_pattern",
    "sensor_fault",
    "overheating",
    "power_quality",
    "battery_health",
    "inverter_fault"
  ]);
export const complianceChecksStatusEnum = pgEnum("compliance_checks_status", [
    "compliant",
    "non_compliant",
    "warning",
    "not_applicable",
    "pending_review"
  ]);
export const complianceChecksCheckTypeEnum = pgEnum("compliance_checks_check_type", ["automated", "manual", "audit"]);
export const complianceChecksScopeTypeEnum = pgEnum("compliance_checks_scope_type", ["user", "asset", "community", "platform"]);
export const complianceRulesRuleCategoryEnum = pgEnum("compliance_rules_rule_category", [
    "grid_code",
    "market_rules",
    "data_privacy",
    "safety",
    "environmental",
    "consumer_protection",
    "reporting"
  ]);
export const complianceRulesCheckFrequencyEnum = pgEnum("compliance_rules_check_frequency", [
    "realtime",
    "hourly",
    "daily",
    "weekly",
    "monthly",
    "quarterly",
    "annually"
  ]);
export const complianceRulesStatusEnum = pgEnum("compliance_rules_status", ["active", "pending", "deprecated"]);
export const complianceReportsReportTypeEnum = pgEnum("compliance_reports_report_type", [
    "periodic",
    "incident",
    "audit",
    "regulatory_filing"
  ]);
export const complianceReportsStatusEnum = pgEnum("compliance_reports_status", [
    "draft",
    "pending_review",
    "submitted",
    "accepted",
    "rejected"
  ]);
export const retrainingJobsTriggerTypeEnum = pgEnum("retraining_jobs_trigger_type", [
    "scheduled",
    "drift_detected",
    "manual",
    "performance_threshold"
  ]);
export const retrainingJobsStatusEnum = pgEnum("retraining_jobs_status", [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled"
  ]);
export const blockchainAnchorsAnchorTypeEnum = pgEnum("blockchain_anchors_anchor_type", [
    "settlement_period",
    "settlement_event",
    "carbon_credit",
    "compliance_report",
    "data_anchor"
  ]);
export const blockchainAnchorsNetworkEnum = pgEnum("blockchain_anchors_network", [
    "ethereum",
    "polygon",
    "arbitrum",
    "optimism",
    "hedera",
    "stellar",
    "mock"
  ]);
// 'local_committed' means the local hash provider committed it; it is NOT an on-chain confirmation
export const blockchainAnchorsStatusEnum = pgEnum("blockchain_anchors_status", [
    "pending",
    "submitted",
    "confirmed",
    "local_committed",
    "failed"
  ]);
export const supportTicketsStatusEnum = pgEnum("support_tickets_status", [
    "open",
    "in_progress",
    "waiting_customer",
    "resolved",
    "closed"
  ]);
export const healthChecksStatusEnum = pgEnum("health_checks_status", ["healthy", "degraded", "unhealthy"]);
export const edgeCommandsStatusEnum = pgEnum("edge_commands_status", [
    "queued",
    "sent",
    "acknowledged",
    "executing",
    "completed",
    "failed",
    "expired"
  ]);
export const edgeCommandsCommandTypeEnum = pgEnum("edge_commands_command_type", [
    "set_power",
    "set_soc_target",
    "start_charging",
    "stop_charging",
    "enable_v2g",
    "disable_v2g",
    "emergency_stop",
    "update_config"
  ]);
export const edgeGatewaysStatusEnum = pgEnum("edge_gateways_status", ["online", "offline", "degraded", "maintenance"]);
export const edgeGatewaysPrimaryProtocolEnum = pgEnum("edge_gateways_primary_protocol", ["mqtt", "grpc", "https"]);
export const modelDriftEventsActionTakenEnum = pgEnum("model_drift_events_action_taken", [
    "none",
    "alert_sent",
    "retrain_triggered",
    "model_rolled_back"
  ]);
export const modelDriftEventsSeverityEnum = pgEnum("model_drift_events_severity", ["low", "medium", "high", "critical"]);
export const modelDriftEventsDriftTypeEnum = pgEnum("model_drift_events_drift_type", [
    "data_drift",
    "concept_drift",
    "prediction_drift",
    "performance_degradation"
  ]);
export const modelRegistryStatusEnum = pgEnum("model_registry_status", [
    "training",
    "validating",
    "staging",
    "production",
    "deprecated",
    "failed"
  ]);
export const modelRegistryModelTypeEnum = pgEnum("model_registry_model_type", [
    "load_forecast",
    "generation_forecast",
    "price_forecast",
    "anomaly_detection",
    "optimization"
  ]);
export const forecastRunsStatusEnum = pgEnum("forecast_runs_status", ["running", "completed", "failed"]);
export const forecastRunsScopeTypeEnum = pgEnum("forecast_runs_scope_type", ["asset", "user", "community", "region"]);
export const forecastRunsForecastTypeEnum = pgEnum("forecast_runs_forecast_type", [
    "load",
    "solar_generation",
    "wind_generation",
    "price",
    "emissions",
    "ev_availability"
  ]);
export const carbonCreditsStatusEnum = pgEnum("carbon_credits_status", [
    "pending",
    "issued",
    "transferred",
    "retired",
    "cancelled"
  ]);
export const carbonCreditsCreditTypeEnum = pgEnum("carbon_credits_credit_type", [
    "rec", // Renewable Energy Certificate
    "carbon_offset",
    "green_certificate",
    "i_rec" // International REC
  ]);
export const communityAllocationsStatusEnum = pgEnum("community_allocations_status", ["calculated", "approved", "distributed", "disputed"]);
export const communityMembersStatusEnum = pgEnum("community_members_status", ["pending", "active", "suspended", "left"]);
export const communityMembersRoleEnum = pgEnum("community_members_role", ["member", "prosumer", "admin", "operator"]);
export const energyCommunitiesStatusEnum = pgEnum("energy_communities_status", ["forming", "active", "suspended", "dissolved"]);
export const energyCommunitiesAllocationMethodEnum = pgEnum("energy_communities_allocation_method", [
    "equal_share",
    "proportional_capacity",
    "proportional_consumption",
    "dynamic_pricing",
    "custom"
  ]);
export const energyCommunitiesIslandingModeEnum = pgEnum("energy_communities_islanding_mode", [
    "grid_tied",
    "islanded",
    "transitioning"
  ]);
export const energyCommunitiesGovernanceModelEnum = pgEnum("energy_communities_governance_model", [
    "cooperative",
    "utility_managed",
    "peer_to_peer",
    "hybrid"
  ]);
export const energyCommunitiesCommunityTypeEnum = pgEnum("energy_communities_community_type", [
    "residential",
    "commercial",
    "mixed",
    "microgrid",
    "virtual"
  ]);
export const chargingSessionsStatusEnum = pgEnum("charging_sessions_status", [
    "starting",
    "charging",
    "discharging",
    "paused",
    "completed",
    "failed"
  ]);
export const chargingSessionsSessionTypeEnum = pgEnum("charging_sessions_session_type", [
    "standard_charge",
    "smart_charge",
    "v2g",
    "v2h"
  ]);
export const chargingStationsStatusEnum = pgEnum("charging_stations_status", [
    "available",
    "occupied",
    "charging",
    "discharging",
    "faulted",
    "offline"
  ]);
export const chargingStationsOcppVersionEnum = pgEnum("charging_stations_ocpp_version", ["1.6", "2.0", "2.0.1"]);
export const chargingStationsConnectorTypeEnum = pgEnum("charging_stations_connector_type", [
    "type1",
    "type2",
    "chademo",
    "ccs1",
    "ccs2",
    "tesla"
  ]);
export const electricVehiclesStatusEnum = pgEnum("electric_vehicles_status", ["active", "inactive", "maintenance"]);
export const electricVehiclesBidirectionalProtocolEnum = pgEnum("electric_vehicles_bidirectional_protocol", [
    "none",
    "chademo",
    "ccs_v2g",
    "iso15118"
  ]);
export const settlementPeriodsStatusEnum = pgEnum("settlement_periods_status", [
    "open",
    "closed",
    "invoiced",
    "paid",
    "disputed"
  ]);
export const settlementEventsVerificationStatusEnum = pgEnum("settlement_events_verification_status", [
    "pending",
    "verified",
    "disputed",
    "adjusted"
  ]);
export const settlementEventsCurrencyEnum = pgEnum("settlement_events_currency", ["NGN", "TZS", "USD"]);
export const settlementEventsEventTypeEnum = pgEnum("settlement_events_event_type", [
    "dispatch_completed",
    "service_delivered",
    "measurement_verified",
    "compensation_calculated",
    "payment_initiated",
    "payment_completed",
    "dispute_raised",
    "dispute_resolved",
    "adjustment_applied"
  ]);
export const dispatchSetpointsStatusEnum = pgEnum("dispatch_setpoints_status", [
    "scheduled",
    "dispatched",
    "acknowledged",
    "executing",
    "completed",
    "failed",
    "skipped"
  ]);
export const dispatchSchedulesStatusEnum = pgEnum("dispatch_schedules_status", [
    "draft",
    "optimized",
    "approved",
    "dispatching",
    "completed",
    "cancelled"
  ]);
export const dispatchSchedulesObjectiveFunctionEnum = pgEnum("dispatch_schedules_objective_function", [
    "minimize_cost",
    "maximize_revenue",
    "minimize_emissions",
    "maximize_self_consumption",
    "balance_grid"
  ]);
export const serviceEnrollmentsStatusEnum = pgEnum("service_enrollments_status", ["pending", "active", "suspended", "terminated"]);
export const gridServiceProductsCompensationTypeEnum = pgEnum("grid_service_products_compensation_type", [
    "energy_only",
    "capacity_only",
    "capacity_plus_energy",
    "performance_based"
  ]);
export const gridServiceProductsServiceTypeEnum = pgEnum("grid_service_products_service_type", [
    "energy_arbitrage",
    "capacity",
    "frequency_regulation",
    "spinning_reserve",
    "non_spinning_reserve",
    "voltage_support",
    "reactive_power",
    "congestion_relief",
    "peak_shaving",
    "load_shifting",
    "demand_response",
    "black_start"
  ]);
export const derConstraintsSourceEnum = pgEnum("der_constraints_source", [
    "user",
    "operator",
    "system",
    "safety",
    "grid_code"
  ]);
export const derConstraintsConstraintTypeEnum = pgEnum("der_constraints_constraint_type", [
    "max_power",
    "min_power",
    "max_energy",
    "min_soc",
    "max_soc",
    "unavailable",
    "must_run",
    "user_preference"
  ]);


// ============================================================================
// DER CAPABILITIES AND CONSTRAINTS
// ============================================================================

/**
 * DER (Distributed Energy Resource) Capabilities
 * Extended asset information for optimization and dispatch
 */
export const derCapabilities = pgTable("der_capabilities", {
  id: serial("id").primaryKey(),
  assetId: int("asset_id").notNull(), // Links to assets table
  
  // Power limits
  maxPowerExport: int("max_power_export"), // Maximum export power in watts
  maxPowerImport: int("max_power_import"), // Maximum import power in watts
  minPowerExport: int("min_power_export"), // Minimum export power in watts
  minPowerImport: int("min_power_import"), // Minimum import power in watts
  
  // Ramp rates (watts per second)
  rampRateUp: int("ramp_rate_up"),
  rampRateDown: int("ramp_rate_down"),
  
  // Energy storage specific
  maxStateOfCharge: int("max_soc"), // Maximum SoC in percentage * 100
  minStateOfCharge: int("min_soc"), // Minimum SoC in percentage * 100
  roundTripEfficiency: int("round_trip_efficiency"), // Efficiency in percentage * 100
  
  // Response characteristics
  responseTimeMs: int("response_time_ms"), // Time to respond to dispatch in milliseconds
  minimumRunTime: int("minimum_run_time"), // Minimum run time in seconds
  minimumOffTime: int("minimum_off_time"), // Minimum off time in seconds
  
  // Grid services capabilities
  canProvideFrequencyResponse: boolean("can_provide_frequency_response").default(false).notNull(),
  canProvideVoltageSupport: boolean("can_provide_voltage_support").default(false).notNull(),
  canProvideReserves: boolean("can_provide_reserves").default(false).notNull(),
  canProvidePeakShaving: boolean("can_provide_peak_shaving").default(true).notNull(),
  
  // Communication protocols supported
  protocols: text("protocols"), // JSON array: ["mqtt", "modbus", "ocpp", "sunspec", "ieee2030.5"]
  
  // Certification and compliance
  certifications: text("certifications"), // JSON array of certifications
  gridCodeCompliance: text("grid_code_compliance"), // JSON: region-specific compliance
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type DerCapability = typeof derCapabilities.$inferSelect;
export type InsertDerCapability = typeof derCapabilities.$inferInsert;

/**
 * DER Constraints - Time-varying constraints for optimization
 */
export const derConstraints = pgTable("der_constraints", {
  id: serial("id").primaryKey(),
  assetId: int("asset_id").notNull(),
  
  // Time window for constraint
  validFrom: timestamp("valid_from").notNull(),
  validUntil: timestamp("valid_until").notNull(),
  
  // Constraint type and values
  constraintType: derConstraintsConstraintTypeEnum("constraint_type").notNull(),
  
  constraintValue: int("constraint_value"), // Value depends on type
  priority: int("priority").default(5).notNull(), // 1-10, higher = more important
  
  // Source of constraint
  source: derConstraintsSourceEnum("source").notNull(),
  
  reason: text("reason"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type DerConstraint = typeof derConstraints.$inferSelect;
export type InsertDerConstraint = typeof derConstraints.$inferInsert;

// ============================================================================
// GRID SERVICES AND PROGRAMS
// ============================================================================

/**
 * Grid Service Products - Types of services that can be provided
 */
export const gridServiceProducts = pgTable("grid_service_products", {
  id: serial("id").primaryKey(),
  
  // Service identification
  serviceCode: varchar("service_code", { length: 50 }).notNull().unique(),
  serviceName: varchar("service_name", { length: 255 }).notNull(),
  serviceType: gridServiceProductsServiceTypeEnum("service_type").notNull(),
  
  // Market/region
  marketRegion: varchar("market_region", { length: 50 }).notNull(), // e.g., "NG-LAGOS", "TZ-DAR", "CAISO", "PJM"
  
  // Technical requirements
  minCapacityKw: int("min_capacity_kw"),
  maxResponseTimeMs: int("max_response_time_ms"),
  minDurationMinutes: int("min_duration_minutes"),
  telemetryIntervalSeconds: int("telemetry_interval_seconds"),
  
  // Compensation structure
  compensationType: gridServiceProductsCompensationTypeEnum("compensation_type").notNull(),
  baseRateCents: int("base_rate_cents"), // Base rate in cents per kWh or kW
  performanceMultiplier: int("performance_multiplier"), // Multiplier * 100
  
  // Availability
  isActive: boolean("is_active").default(true).notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type GridServiceProduct = typeof gridServiceProducts.$inferSelect;
export type InsertGridServiceProduct = typeof gridServiceProducts.$inferInsert;

/**
 * Service Enrollments - DERs enrolled in specific services
 */
export const serviceEnrollments = pgTable("service_enrollments", {
  id: serial("id").primaryKey(),
  assetId: int("asset_id").notNull(),
  serviceProductId: int("service_product_id").notNull(),
  userId: int("user_id").notNull(),
  
  // Enrollment details
  enrolledCapacityKw: int("enrolled_capacity_kw").notNull(),
  status: serviceEnrollmentsStatusEnum("status").default("pending").notNull(),
  
  // Time bounds
  enrolledAt: timestamp("enrolled_at").defaultNow().notNull(),
  effectiveFrom: timestamp("effective_from").notNull(),
  effectiveUntil: timestamp("effective_until"),
  
  // Performance tracking
  totalDispatchesCount: int("total_dispatches_count").default(0).notNull(),
  successfulDispatchesCount: int("successful_dispatches_count").default(0).notNull(),
  performanceScore: int("performance_score").default(100).notNull(), // 0-100
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type ServiceEnrollment = typeof serviceEnrollments.$inferSelect;
export type InsertServiceEnrollment = typeof serviceEnrollments.$inferInsert;

// ============================================================================
// OPTIMIZATION AND DISPATCH
// ============================================================================

/**
 * Dispatch Schedules - Planned dispatch for DERs
 */
export const dispatchSchedules = pgTable("dispatch_schedules", {
  id: serial("id").primaryKey(),
  
  // Schedule identification
  scheduleId: varchar("schedule_id", { length: 64 }).notNull().unique(),
  
  // Time window
  scheduleStart: timestamp("schedule_start").notNull(),
  scheduleEnd: timestamp("schedule_end").notNull(),
  intervalMinutes: int("interval_minutes").default(15).notNull(),
  
  // Optimization context
  optimizationRunId: varchar("optimization_run_id", { length: 64 }),
  objectiveFunction: dispatchSchedulesObjectiveFunctionEnum("objective_function").notNull(),
  
  // Status
  status: dispatchSchedulesStatusEnum("status").default("draft").notNull(),
  
  // Results
  totalExpectedRevenue: int("total_expected_revenue"), // cents
  totalExpectedCost: int("total_expected_cost"), // cents
  totalExpectedEmissionsSaved: int("total_expected_emissions_saved"), // grams CO2
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type DispatchSchedule = typeof dispatchSchedules.$inferSelect;
export type InsertDispatchSchedule = typeof dispatchSchedules.$inferInsert;

/**
 * Dispatch Setpoints - Individual setpoints within a schedule
 */
export const dispatchSetpoints = pgTable("dispatch_setpoints", {
  id: serial("id").primaryKey(),
  scheduleId: int("schedule_id").notNull(),
  assetId: int("asset_id").notNull(),
  
  // Time slot
  intervalStart: timestamp("interval_start").notNull(),
  intervalEnd: timestamp("interval_end").notNull(),
  
  // Setpoint values
  targetPowerWatts: int("target_power_watts").notNull(), // Positive = export, negative = import
  targetSocPercent: int("target_soc_percent"), // For batteries, percentage * 100
  
  // Service allocation
  serviceProductId: int("service_product_id"),
  
  // Execution status
  status: dispatchSetpointsStatusEnum("status").default("scheduled").notNull(),
  
  // Actual values (filled after execution)
  actualPowerWatts: int("actual_power_watts"),
  actualSocPercent: int("actual_soc_percent"),
  
  // Timing
  dispatchedAt: timestamp("dispatched_at"),
  acknowledgedAt: timestamp("acknowledged_at"),
  completedAt: timestamp("completed_at"),
  
  // Performance
  deviationWatts: int("deviation_watts"),
  performanceScore: int("performance_score"), // 0-100
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type DispatchSetpoint = typeof dispatchSetpoints.$inferSelect;
export type InsertDispatchSetpoint = typeof dispatchSetpoints.$inferInsert;

// ============================================================================
// SETTLEMENT LEDGER (TAMPER-EVIDENT)
// ============================================================================

/**
 * Settlement Events - Hash-chained ledger for auditable settlement
 */
export const settlementEvents = pgTable("settlement_events", {
  id: serial("id").primaryKey(),
  
  // Hash chain for tamper evidence
  eventHash: varchar("event_hash", { length: 64 }).notNull().unique(), // SHA-256
  // Unique: two concurrent writers must not both claim the same slot, which
  // would fork the hash chain into two branches that each verify in isolation.
  previousHash: varchar("previous_hash", { length: 64 }).notNull().unique(),
  sequenceNumber: bigint("sequence_number", { mode: "number" }).notNull().unique(),
  
  // Event identification
  eventType: settlementEventsEventTypeEnum("event_type").notNull(),
  
  // Parties involved
  userId: int("user_id").notNull(),
  counterpartyId: int("counterparty_id"), // Grid operator, utility, or peer
  
  // Reference to source records
  sourceType: varchar("source_type", { length: 50 }).notNull(), // e.g., "dispatch_setpoint", "dr_response"
  sourceId: int("source_id").notNull(),
  
  // Settlement values
  energyWh: int("energy_wh"),
  powerKw: int("power_kw"),
  durationMinutes: int("duration_minutes"),
  ratePerUnit: int("rate_per_unit"), // cents
  grossAmount: int("gross_amount"), // cents
  fees: int("fees"), // cents
  netAmount: int("net_amount"), // cents
  currency: settlementEventsCurrencyEnum("currency").notNull(),
  
  // Verification
  measurementMethod: varchar("measurement_method", { length: 50 }),
  baselineMethod: varchar("baseline_method", { length: 50 }),
  verificationStatus: settlementEventsVerificationStatusEnum("verification_status").default("pending").notNull(),
  
  // Full event data
  eventData: text("event_data").notNull(), // JSON with all details
  
  // Blockchain anchoring (optional)
  blockchainTxHash: varchar("blockchain_tx_hash", { length: 66 }),
  anchoredAt: timestamp("anchored_at"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type SettlementEvent = typeof settlementEvents.$inferSelect;
export type InsertSettlementEvent = typeof settlementEvents.$inferInsert;

/**
 * Settlement Periods - Aggregated settlement for billing periods
 */
export const settlementPeriods = pgTable("settlement_periods", {
  id: serial("id").primaryKey(),
  
  userId: int("user_id").notNull(),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  
  // Aggregated values
  totalEnergyExportedWh: int("total_energy_exported_wh").default(0).notNull(),
  totalEnergyImportedWh: int("total_energy_imported_wh").default(0).notNull(),
  totalServicesDelivered: int("total_services_delivered").default(0).notNull(),
  
  // Financial summary
  grossRevenue: int("gross_revenue").default(0).notNull(), // cents
  platformFees: int("platform_fees").default(0).notNull(), // cents
  gridCharges: int("grid_charges").default(0).notNull(), // cents
  netRevenue: int("net_revenue").default(0).notNull(), // cents
  
  // Carbon impact
  emissionsSavedGrams: int("emissions_saved_grams").default(0).notNull(),
  renewableEnergyWh: int("renewable_energy_wh").default(0).notNull(),
  
  // Status
  status: settlementPeriodsStatusEnum("status").default("open").notNull(),
  
  // Hash of all events in period for verification
  periodHash: varchar("period_hash", { length: 64 }),
  eventCount: int("event_count").default(0).notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type SettlementPeriod = typeof settlementPeriods.$inferSelect;
export type InsertSettlementPeriod = typeof settlementPeriods.$inferInsert;

// ============================================================================
// EV AND V2G SUPPORT
// ============================================================================

/**
 * Electric Vehicles - EV registration and management
 */
export const electricVehicles = pgTable("electric_vehicles", {
  id: serial("id").primaryKey(),
  userId: int("user_id").notNull(),
  
  // Vehicle identification
  vin: varchar("vin", { length: 17 }),
  make: varchar("make", { length: 100 }),
  model: varchar("model", { length: 100 }),
  year: int("year"),
  
  // Battery specifications
  batteryCapacityKwh: int("battery_capacity_kwh"), // kWh * 10 for precision
  usableBatteryKwh: int("usable_battery_kwh"),
  maxChargingPowerKw: int("max_charging_power_kw"), // kW * 10
  maxDischargingPowerKw: int("max_discharging_power_kw"), // kW * 10 (V2G capable)
  
  // V2G capability
  v2gCapable: boolean("v2g_capable").default(false).notNull(),
  v2hCapable: boolean("v2h_capable").default(false).notNull(), // Vehicle to Home
  bidirectionalProtocol: electricVehiclesBidirectionalProtocolEnum("bidirectional_protocol").default("none").notNull(),
  
  // Current state
  currentSocPercent: int("current_soc_percent"), // percentage * 100
  lastKnownLocation: varchar("last_known_location", { length: 255 }),
  isPluggedIn: boolean("is_plugged_in").default(false).notNull(),
  isCharging: boolean("is_charging").default(false).notNull(),
  
  // User preferences
  minSocPercent: int("min_soc_percent").default(2000).notNull(), // 20% default
  targetSocPercent: int("target_soc_percent").default(8000).notNull(), // 80% default
  
  status: electricVehiclesStatusEnum("status").default("active").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type ElectricVehicle = typeof electricVehicles.$inferSelect;
export type InsertElectricVehicle = typeof electricVehicles.$inferInsert;

/**
 * EV Charging Stations (EVSE)
 */
export const chargingStations = pgTable("charging_stations", {
  id: serial("id").primaryKey(),
  
  // Ownership
  userId: int("user_id"), // null for public stations
  siteId: int("site_id"),
  
  // Station identification
  stationId: varchar("station_id", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  
  // Location
  latitude: decimal("latitude", { precision: 10, scale: 7 }),
  longitude: decimal("longitude", { precision: 10, scale: 7 }),
  address: text("address"),
  
  // Technical specs
  connectorType: chargingStationsConnectorTypeEnum("connector_type").notNull(),
  maxPowerKw: int("max_power_kw").notNull(), // kW * 10
  
  // V2G capability
  v2gCapable: boolean("v2g_capable").default(false).notNull(),
  
  // Communication
  ocppVersion: chargingStationsOcppVersionEnum("ocpp_version"),
  ocppEndpoint: varchar("ocpp_endpoint", { length: 255 }),
  
  // Status
  status: chargingStationsStatusEnum("status").default("offline").notNull(),
  
  lastHeartbeat: timestamp("last_heartbeat"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type ChargingStation = typeof chargingStations.$inferSelect;
export type InsertChargingStation = typeof chargingStations.$inferInsert;

/**
 * Charging Sessions
 */
export const chargingSessions = pgTable("charging_sessions", {
  id: serial("id").primaryKey(),
  
  // References
  evId: int("ev_id").notNull(),
  stationId: int("station_id").notNull(),
  userId: int("user_id").notNull(),
  
  // Session identification
  sessionId: varchar("session_id", { length: 64 }).notNull().unique(),
  
  // Time
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time"),
  
  // Energy
  startSocPercent: int("start_soc_percent"),
  endSocPercent: int("end_soc_percent"),
  energyDeliveredWh: int("energy_delivered_wh").default(0).notNull(),
  energyExportedWh: int("energy_exported_wh").default(0).notNull(), // V2G
  
  // Power
  maxPowerKw: int("max_power_kw"),
  avgPowerKw: int("avg_power_kw"),
  
  // Session type
  sessionType: chargingSessionsSessionTypeEnum("session_type").default("standard_charge").notNull(),
  
  // User preferences for this session
  targetSocPercent: int("target_soc_percent"),
  departureTime: timestamp("departure_time"),
  
  // Cost
  totalCost: int("total_cost"), // cents
  totalRevenue: int("total_revenue"), // cents (for V2G)
  
  status: chargingSessionsStatusEnum("status").default("starting").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type ChargingSession = typeof chargingSessions.$inferSelect;
export type InsertChargingSession = typeof chargingSessions.$inferInsert;

// ============================================================================
// COMMUNITY ENERGY
// ============================================================================

/**
 * Energy Communities - Groups of users sharing energy resources
 */
export const energyCommunities = pgTable("energy_communities", {
  id: serial("id").primaryKey(),
  
  // Community identification
  communityCode: varchar("community_code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  
  // Type and structure
  communityType: energyCommunitiesCommunityTypeEnum("community_type").notNull(),
  
  // Location (for physical communities)
  region: varchar("region", { length: 100 }),
  gridConnectionPoint: varchar("grid_connection_point", { length: 100 }),
  
  // Governance
  governanceModel: energyCommunitiesGovernanceModelEnum("governance_model").default("cooperative").notNull(),
  
  // Shared resources
  hasSharedBattery: boolean("has_shared_battery").default(false).notNull(),
  hasSharedSolar: boolean("has_shared_solar").default(false).notNull(),
  sharedCapacityKw: int("shared_capacity_kw"),
  
  // Microgrid capability
  canIsland: boolean("can_island").default(false).notNull(),
  islandingMode: energyCommunitiesIslandingModeEnum("islanding_mode").default("grid_tied").notNull(),
  
  // Financial
  allocationMethod: energyCommunitiesAllocationMethodEnum("allocation_method").default("proportional_capacity").notNull(),
  
  status: energyCommunitiesStatusEnum("status").default("forming").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type EnergyCommunity = typeof energyCommunities.$inferSelect;
export type InsertEnergyCommunity = typeof energyCommunities.$inferInsert;

/**
 * Community Members
 */
export const communityMembers = pgTable("community_members", {
  id: serial("id").primaryKey(),
  communityId: int("community_id").notNull(),
  userId: int("user_id").notNull(),
  
  // Membership details
  role: communityMembersRoleEnum("role").default("member").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
  
  // Contribution
  contributedCapacityKw: int("contributed_capacity_kw").default(0).notNull(),
  sharePercentage: int("share_percentage"), // percentage * 100
  
  // Preferences
  autoParticipate: boolean("auto_participate").default(true).notNull(),
  priorityLevel: int("priority_level").default(5).notNull(), // 1-10 for load shedding priority
  
  status: communityMembersStatusEnum("status").default("pending").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type CommunityMember = typeof communityMembers.$inferSelect;
export type InsertCommunityMember = typeof communityMembers.$inferInsert;

/**
 * Community Allocations - Energy sharing within community
 */
export const communityAllocations = pgTable("community_allocations", {
  id: serial("id").primaryKey(),
  communityId: int("community_id").notNull(),
  
  // Time period
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  
  // Total community energy
  totalGenerationWh: int("total_generation_wh").default(0).notNull(),
  totalConsumptionWh: int("total_consumption_wh").default(0).notNull(),
  totalExportWh: int("total_export_wh").default(0).notNull(),
  totalImportWh: int("total_import_wh").default(0).notNull(),
  
  // Financial
  totalRevenue: int("total_revenue").default(0).notNull(), // cents
  totalCost: int("total_cost").default(0).notNull(), // cents
  netValue: int("net_value").default(0).notNull(), // cents
  
  // Allocation details stored as JSON
  memberAllocations: text("member_allocations").notNull(), // JSON array of member allocations
  
  status: communityAllocationsStatusEnum("status").default("calculated").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type CommunityAllocation = typeof communityAllocations.$inferSelect;
export type InsertCommunityAllocation = typeof communityAllocations.$inferInsert;

// ============================================================================
// CARBON AND EMISSIONS
// ============================================================================

/**
 * Emissions Factors - Grid carbon intensity by region and time
 */
export const emissionsFactors = pgTable("emissions_factors", {
  id: serial("id").primaryKey(),
  
  // Region and time
  region: varchar("region", { length: 50 }).notNull(),
  timestamp: timestamp("timestamp").notNull(),
  validUntil: timestamp("valid_until").notNull(),
  
  // Emissions values (grams CO2 per kWh)
  marginalEmissions: int("marginal_emissions").notNull(), // For dispatch decisions
  averageEmissions: int("average_emissions").notNull(), // For reporting
  
  // Generation mix (percentage * 100)
  renewablePercent: int("renewable_percent"),
  coalPercent: int("coal_percent"),
  gasPercent: int("gas_percent"),
  nuclearPercent: int("nuclear_percent"),
  
  // Data source
  dataSource: varchar("data_source", { length: 100 }), // e.g., "electricity_maps", "watttime", "local_grid"
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type EmissionsFactor = typeof emissionsFactors.$inferSelect;
export type InsertEmissionsFactor = typeof emissionsFactors.$inferInsert;

/**
 * Carbon Credits - Tracking renewable energy certificates and carbon offsets
 */
export const carbonCredits = pgTable("carbon_credits", {
  id: serial("id").primaryKey(),
  userId: int("user_id").notNull(),
  
  // Credit identification
  creditType: carbonCreditsCreditTypeEnum("credit_type").notNull(),
  
  certificateId: varchar("certificate_id", { length: 100 }),
  
  // Quantity
  energyMwh: int("energy_mwh"), // For RECs
  carbonTonnes: int("carbon_tonnes"), // For offsets (tonnes * 100)
  
  // Source
  generationSource: varchar("generation_source", { length: 100 }),
  generationPeriodStart: timestamp("generation_period_start"),
  generationPeriodEnd: timestamp("generation_period_end"),
  
  // Registry
  registry: varchar("registry", { length: 100 }),
  registryUrl: varchar("registry_url", { length: 255 }),
  
  // Status
  status: carbonCreditsStatusEnum("status").default("pending").notNull(),
  
  // Blockchain proof (optional)
  blockchainProof: varchar("blockchain_proof", { length: 66 }),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type CarbonCredit = typeof carbonCredits.$inferSelect;
export type InsertCarbonCredit = typeof carbonCredits.$inferInsert;

// ============================================================================
// FORECASTING
// ============================================================================

/**
 * Forecast Runs - Metadata for forecast model executions
 */
export const forecastRuns = pgTable("forecast_runs", {
  id: serial("id").primaryKey(),
  
  // Run identification
  runId: varchar("run_id", { length: 64 }).notNull().unique(),
  
  // Forecast type
  forecastType: forecastRunsForecastTypeEnum("forecast_type").notNull(),
  
  // Scope
  scopeType: forecastRunsScopeTypeEnum("scope_type").notNull(),
  scopeId: int("scope_id"), // ID of asset, user, community, or null for region
  region: varchar("region", { length: 50 }),
  
  // Model info
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  modelType: varchar("model_type", { length: 50 }), // e.g., "linear_regression", "xgboost", "lstm"
  features: text("features"), // JSON array of features used
  
  // Time range
  forecastHorizonHours: int("forecast_horizon_hours").notNull(),
  intervalMinutes: int("interval_minutes").default(15).notNull(),
  
  // Quality metrics
  maeValue: int("mae_value"), // Mean Absolute Error * 100
  rmseValue: int("rmse_value"), // Root Mean Square Error * 100
  mapeValue: int("mape_value"), // Mean Absolute Percentage Error * 100
  
  // Status
  status: forecastRunsStatusEnum("status").default("running").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ForecastRun = typeof forecastRuns.$inferSelect;
export type InsertForecastRun = typeof forecastRuns.$inferInsert;

/**
 * Forecast Values - Probabilistic forecast outputs
 */
export const forecastValues = pgTable("forecast_values", {
  id: serial("id").primaryKey(),
  runId: int("run_id").notNull(),
  
  // Time
  forecastTime: timestamp("forecast_time").notNull(),
  
  // Probabilistic values (all in appropriate units * 100 for precision)
  p10Value: int("p10_value").notNull(), // 10th percentile
  p50Value: int("p50_value").notNull(), // Median
  p90Value: int("p90_value").notNull(), // 90th percentile
  meanValue: int("mean_value"),
  
  // Confidence
  confidenceScore: int("confidence_score"), // 0-100
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ForecastValue = typeof forecastValues.$inferSelect;
export type InsertForecastValue = typeof forecastValues.$inferInsert;

// ============================================================================
// MLOPS
// ============================================================================

/**
 * Model Registry - Track ML models
 */
export const modelRegistry = pgTable("model_registry", {
  id: serial("id").primaryKey(),
  
  // Model identification
  modelName: varchar("model_name", { length: 100 }).notNull(),
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  
  // Model type
  modelType: modelRegistryModelTypeEnum("model_type").notNull(),
  
  // Artifact storage
  artifactPath: varchar("artifact_path", { length: 500 }),
  artifactHash: varchar("artifact_hash", { length: 64 }),
  
  // Training info
  trainingDataStart: timestamp("training_data_start"),
  trainingDataEnd: timestamp("training_data_end"),
  trainingDurationSeconds: int("training_duration_seconds"),
  
  // Training/serving contract
  framework: varchar("framework", { length: 50 }),
  inputSchema: text("input_schema"), // JSON
  outputSchema: text("output_schema"), // JSON
  hyperparameters: text("hyperparameters"), // JSON
  trainingSamples: int("training_samples"),
  
  // Performance metrics
  validationMetrics: text("validation_metrics"), // JSON, metric name -> value
  validationMae: int("validation_mae"), // * 100
  validationRmse: int("validation_rmse"), // * 100
  validationMape: int("validation_mape"), // * 100
  
  // Deployment status
  status: modelRegistryStatusEnum("status").default("training").notNull(),
  
  deployedAt: timestamp("deployed_at"),
  deprecatedAt: timestamp("deprecated_at"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type ModelRegistryEntry = typeof modelRegistry.$inferSelect;
export type InsertModelRegistryEntry = typeof modelRegistry.$inferInsert;

/**
 * Model Drift Detection - Track model performance over time
 */
export const modelDriftEvents = pgTable("model_drift_events", {
  id: serial("id").primaryKey(),
  modelId: int("model_id").notNull(),
  
  // Detection time
  detectedAt: timestamp("detected_at").notNull(),
  
  // Drift metrics
  driftType: modelDriftEventsDriftTypeEnum("drift_type").notNull(),
  
  // Statistical measures
  psiScore: int("psi_score"), // Population Stability Index * 1000
  klDivergence: int("kl_divergence"), // KL Divergence * 1000
  currentMae: int("current_mae"), // * 100
  baselineMae: int("baseline_mae"), // * 100
  
  // Severity
  severity: modelDriftEventsSeverityEnum("severity").notNull(),
  
  // Action taken
  actionTaken: modelDriftEventsActionTakenEnum("action_taken").default("none").notNull(),
  
  // What drifted, over which window, and what to do about it
  metricName: varchar("metric_name", { length: 64 }),
  currentValue: int("current_value"), // * 1000
  baselineValue: int("baseline_value"), // * 1000
  threshold: int("threshold"), // * 1000
  windowStart: timestamp("window_start"),
  windowEnd: timestamp("window_end"),
  affectedFeatures: text("affected_features"), // JSON array
  recommendedAction: text("recommended_action"),
  resolvedAt: timestamp("resolved_at"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ModelDriftEvent = typeof modelDriftEvents.$inferSelect;
export type InsertModelDriftEvent = typeof modelDriftEvents.$inferInsert;

/**
 * Model Predictions - Per-inference log used for accuracy and drift monitoring
 */
export const modelPredictions = pgTable("model_predictions", {
  id: serial("id").primaryKey(),
  modelId: int("model_id").notNull(),
  
  // Deduplication / join key for late-arriving ground truth
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  
  predictedValue: decimal("predicted_value", { precision: 18, scale: 6 }).notNull(),
  actualValue: decimal("actual_value", { precision: 18, scale: 6 }),
  
  latencyMs: int("latency_ms"),
  features: text("features"), // JSON object of feature values
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  modelCreatedIdx: index("model_predictions_model_created_idx").on(table.modelId, table.createdAt),
  inputHashIdx: index("model_predictions_input_hash_idx").on(table.inputHash),
}));

export type ModelPrediction = typeof modelPredictions.$inferSelect;
export type InsertModelPrediction = typeof modelPredictions.$inferInsert;

/**
 * Retraining Jobs - Triggered model retraining runs
 */
export const retrainingJobs = pgTable("retraining_jobs", {
  id: serial("id").primaryKey(),
  modelId: int("model_id").notNull(),
  jobId: varchar("job_id", { length: 64 }).notNull().unique(),
  
  triggerType: retrainingJobsTriggerTypeEnum("trigger_type").notNull(),
  triggeredBy: varchar("triggered_by", { length: 64 }),
  
  status: retrainingJobsStatusEnum("status").default("queued").notNull(),
  trainingConfig: text("training_config"), // JSON
  
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  newModelVersion: varchar("new_model_version", { length: 50 }),
  metrics: text("metrics"), // JSON
  errorMessage: text("error_message"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type RetrainingJob = typeof retrainingJobs.$inferSelect;
export type InsertRetrainingJob = typeof retrainingJobs.$inferInsert;

// ============================================================================
// EDGE ORCHESTRATION
// ============================================================================

/**
 * Edge Gateways - Local control nodes
 */
export const edgeGateways = pgTable("edge_gateways", {
  id: serial("id").primaryKey(),
  
  // Gateway identification
  gatewayId: varchar("gateway_id", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  
  // Location
  siteId: int("site_id"),
  communityId: int("community_id"),
  
  // Hardware info
  hardwareModel: varchar("hardware_model", { length: 100 }),
  firmwareVersion: varchar("firmware_version", { length: 50 }),
  
  // Connectivity
  primaryProtocol: edgeGatewaysPrimaryProtocolEnum("primary_protocol").default("mqtt").notNull(),
  connectionEndpoint: varchar("connection_endpoint", { length: 255 }),
  
  // Capabilities
  canOperateOffline: boolean("can_operate_offline").default(true).notNull(),
  localStorageCapacityMb: int("local_storage_capacity_mb"),
  maxManagedDevices: int("max_managed_devices"),
  
  // Security
  certificateFingerprint: varchar("certificate_fingerprint", { length: 64 }),
  lastCertificateRotation: timestamp("last_certificate_rotation"),
  
  // Status
  status: edgeGatewaysStatusEnum("status").default("offline").notNull(),
  lastHeartbeat: timestamp("last_heartbeat"),
  
  // Offline operation state
  offlineMode: boolean("offline_mode").default(false).notNull(),
  pendingCommandsCount: int("pending_commands_count").default(0).notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type EdgeGateway = typeof edgeGateways.$inferSelect;
export type InsertEdgeGateway = typeof edgeGateways.$inferInsert;

/**
 * Edge Commands - Commands queued for edge execution
 */
export const edgeCommands = pgTable("edge_commands", {
  id: serial("id").primaryKey(),
  gatewayId: int("gateway_id").notNull(),
  
  // Command identification
  commandId: varchar("command_id", { length: 64 }).notNull().unique(),
  idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
  
  // Target
  targetDeviceId: int("target_device_id"),
  targetAssetId: int("target_asset_id"),
  
  // Command details
  commandType: edgeCommandsCommandTypeEnum("command_type").notNull(),
  
  commandPayload: text("command_payload").notNull(), // JSON
  
  // Priority and timing
  priority: int("priority").default(5).notNull(), // 1-10
  validUntil: timestamp("valid_until").notNull(),
  
  // Execution status
  status: edgeCommandsStatusEnum("status").default("queued").notNull(),
  
  // Timing
  queuedAt: timestamp("queued_at").defaultNow().notNull(),
  sentAt: timestamp("sent_at"),
  acknowledgedAt: timestamp("acknowledged_at"),
  completedAt: timestamp("completed_at"),
  
  // Response
  responsePayload: text("response_payload"), // JSON
  errorMessage: text("error_message"),
  
  // Verification
  responseSignature: varchar("response_signature", { length: 128 }),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type EdgeCommand = typeof edgeCommands.$inferSelect;
export type InsertEdgeCommand = typeof edgeCommands.$inferInsert;

// ============================================================================
// REGULATORY COMPLIANCE
// ============================================================================

/**
 * Compliance Rules - Jurisdiction-specific requirements
 */
export const complianceRules = pgTable("compliance_rules", {
  id: serial("id").primaryKey(),
  
  // Rule identification
  ruleCode: varchar("rule_code", { length: 50 }).notNull().unique(),
  ruleName: varchar("rule_name", { length: 255 }).notNull(),
  
  // Jurisdiction
  jurisdiction: varchar("jurisdiction", { length: 100 }).notNull(), // e.g., "NG", "TZ", "US-CA", "EU"
  regulatoryBody: varchar("regulatory_body", { length: 255 }),
  
  // Rule classification
  ruleCategory: complianceRulesRuleCategoryEnum("rule_category").notNull(),
  
  // Rule definition
  description: text("description").notNull(),
  requirements: text("requirements").notNull(), // JSON object of specific requirements
  
  // Applicability
  appliesToAssetTypes: text("applies_to_asset_types"), // JSON array
  appliesToServiceTypes: text("applies_to_service_types"), // JSON array
  
  // Checking cadence
  checkFrequency: complianceRulesCheckFrequencyEnum("check_frequency").notNull(),
  automatedCheckEnabled: boolean("automated_check_enabled").default(true).notNull(),
  
  // Enforcement window
  effectiveFrom: timestamp("effective_from").notNull(),
  effectiveUntil: timestamp("effective_until"),
  penaltyDescription: text("penalty_description"),
  
  status: complianceRulesStatusEnum("status").default("active").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type ComplianceRule = typeof complianceRules.$inferSelect;
export type InsertComplianceRule = typeof complianceRules.$inferInsert;

/**
 * Compliance Checks - Automated compliance verification
 */
export const complianceChecks = pgTable("compliance_checks", {
  id: serial("id").primaryKey(),
  ruleId: int("rule_id").notNull(),
  
  // Check scope
  checkType: complianceChecksCheckTypeEnum("check_type").default("automated").notNull(),
  scopeType: complianceChecksScopeTypeEnum("scope_type").notNull(),
  scopeId: int("scope_id"),
  
  // Check execution
  checkedAt: timestamp("checked_at").notNull(),
  checkedBy: varchar("checked_by", { length: 64 }),
  nextCheckDue: timestamp("next_check_due"),
  
  // Result
  status: complianceChecksStatusEnum("status").notNull(),
  
  // Details
  findings: text("findings"), // JSON array of specific findings
  evidenceReferences: text("evidence_references"), // JSON array
  recommendedActions: text("recommended_actions"), // JSON array
  
  // Review / resolution
  reviewedBy: int("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  resolvedAt: timestamp("resolved_at"),
  resolutionNotes: text("resolution_notes"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ComplianceCheck = typeof complianceChecks.$inferSelect;
export type InsertComplianceCheck = typeof complianceChecks.$inferInsert;

// ============================================================================
// ANOMALY DETECTION (PREDICTIVE MAINTENANCE)
// ============================================================================

/**
 * Anomaly Events - Detected anomalies in asset behavior
 */
export const anomalyEvents = pgTable("anomaly_events", {
  id: serial("id").primaryKey(),
  assetId: int("asset_id").notNull(),
  
  // Detection
  detectedAt: timestamp("detected_at").notNull(),
  
  // Anomaly classification
  anomalyType: anomalyEventsAnomalyTypeEnum("anomaly_type").notNull(),
  
  // Severity
  severity: anomalyEventsSeverityEnum("severity").notNull(),
  
  // Detection details
  detectionMethod: varchar("detection_method", { length: 50 }), // e.g., "z_score", "isolation_forest", "lstm"
  confidenceScore: int("confidence_score"), // 0-100
  
  // Measured vs expected
  measuredValue: int("measured_value"),
  expectedValue: int("expected_value"),
  deviationPercent: int("deviation_percent"), // * 100
  
  // Impact assessment
  estimatedImpact: text("estimated_impact"), // JSON with impact details
  
  // Recommended action
  recommendedAction: anomalyEventsRecommendedActionEnum("recommended_action").default("monitor").notNull(),
  
  // Human-readable detail and the metric the anomaly was raised on
  metricName: varchar("metric_name", { length: 64 }),
  description: text("description"),
  maintenanceRequired: boolean("maintenance_required").default(false).notNull(),
  
  // Acknowledgement (status 'acknowledged')
  acknowledgedAt: timestamp("acknowledged_at"),
  acknowledgedBy: int("acknowledged_by"),
  
  // Resolution
  status: anomalyEventsStatusEnum("status").default("open").notNull(),
  resolvedAt: timestamp("resolved_at"),
  resolutionNotes: text("resolution_notes"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AnomalyEvent = typeof anomalyEvents.$inferSelect;
export type InsertAnomalyEvent = typeof anomalyEvents.$inferInsert;

/**
 * Compliance Reports - Generated regulatory filings and periodic reports
 */
export const complianceReports = pgTable("compliance_reports", {
  id: serial("id").primaryKey(),
  reportId: varchar("report_id", { length: 64 }).notNull().unique(),
  
  reportType: complianceReportsReportTypeEnum("report_type").notNull(),
  jurisdiction: varchar("jurisdiction", { length: 100 }).notNull(),
  
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  
  submittedAt: timestamp("submitted_at"),
  submittedTo: varchar("submitted_to", { length: 255 }),
  
  status: complianceReportsStatusEnum("status").default("draft").notNull(),
  
  sections: text("sections").notNull(), // JSON array of report sections
  attachments: text("attachments"), // JSON array of references
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  jurisdictionPeriodIdx: index("compliance_reports_jurisdiction_period_idx").on(table.jurisdiction, table.periodStart),
}));

export type ComplianceReport = typeof complianceReports.$inferSelect;
export type InsertComplianceReport = typeof complianceReports.$inferInsert;

// ============================================================================
// AUDIT ANCHORING, SUPPORT AND HEALTH
// ============================================================================

/**
 * Blockchain Anchors - External immutability proofs for audit-critical batches
 */
export const blockchainAnchors = pgTable("blockchain_anchors", {
  id: serial("id").primaryKey(),
  
  anchorType: blockchainAnchorsAnchorTypeEnum("anchor_type").notNull(),
  
  // What was anchored
  sourceId: int("source_id").notNull(),
  sourceHash: varchar("source_hash", { length: 64 }).notNull(),
  merkleRoot: varchar("merkle_root", { length: 64 }),
  
  // Where it was anchored
  blockchainNetwork: blockchainAnchorsNetworkEnum("blockchain_network").notNull(),
  transactionHash: varchar("transaction_hash", { length: 128 }),
  blockNumber: bigint("block_number", { mode: "number" }),
  anchoredAt: timestamp("anchored_at"),
  
  status: blockchainAnchorsStatusEnum("status").default("pending").notNull(),
  
  // Submission cost
  gasUsed: bigint("gas_used", { mode: "number" }),
  costWei: varchar("cost_wei", { length: 40 }),
  verificationUrl: text("verification_url"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  sourceIdx: index("blockchain_anchors_source_idx").on(table.anchorType, table.sourceId),
  statusIdx: index("blockchain_anchors_status_idx").on(table.status),
}));

export type BlockchainAnchor = typeof blockchainAnchors.$inferSelect;
export type InsertBlockchainAnchor = typeof blockchainAnchors.$inferInsert;

/**
 * Support Tickets - Customer support cases raised from the platform
 */
export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  ticketNumber: varchar("ticket_number", { length: 32 }).notNull().unique(),
  
  userId: int("user_id").notNull(),
  assetId: int("asset_id"),
  
  category: varchar("category", { length: 50 }).notNull(),
  priority: varchar("priority", { length: 20 }).default("normal").notNull(),
  subject: varchar("subject", { length: 255 }).notNull(),
  description: text("description").notNull(),
  
  status: supportTicketsStatusEnum("status").default("open").notNull(),
  assignedTo: int("assigned_to"),
  
  firstResponseAt: timestamp("first_response_at"),
  resolvedAt: timestamp("resolved_at"),
  resolutionNotes: text("resolution_notes"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => ({
  userStatusIdx: index("support_tickets_user_status_idx").on(table.userId, table.status),
}));

export type SupportTicket = typeof supportTickets.$inferSelect;
export type InsertSupportTicket = typeof supportTickets.$inferInsert;

/**
 * Health Checks - Recorded results of dependency/service health probes
 */
export const healthChecks = pgTable("health_checks", {
  id: serial("id").primaryKey(),
  
  component: varchar("component", { length: 64 }).notNull(),
  status: healthChecksStatusEnum("status").notNull(),
  
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
  latencyMs: int("latency_ms"),
  
  details: text("details"), // JSON
  errorMessage: text("error_message"),
}, (table) => ({
  componentCheckedIdx: index("health_checks_component_checked_idx").on(table.component, table.checkedAt),
}));

export type HealthCheck = typeof healthChecks.$inferSelect;
export type InsertHealthCheck = typeof healthChecks.$inferInsert;

// All types are exported inline above with their table definitions
