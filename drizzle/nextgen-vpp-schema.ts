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

import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, decimal, bigint } from "drizzle-orm/mysql-core";

// ============================================================================
// DER CAPABILITIES AND CONSTRAINTS
// ============================================================================

/**
 * DER (Distributed Energy Resource) Capabilities
 * Extended asset information for optimization and dispatch
 */
export const derCapabilities = mysqlTable("der_capabilities", {
  id: int("id").autoincrement().primaryKey(),
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
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type DerCapability = typeof derCapabilities.$inferSelect;
export type InsertDerCapability = typeof derCapabilities.$inferInsert;

/**
 * DER Constraints - Time-varying constraints for optimization
 */
export const derConstraints = mysqlTable("der_constraints", {
  id: int("id").autoincrement().primaryKey(),
  assetId: int("asset_id").notNull(),
  
  // Time window for constraint
  validFrom: timestamp("valid_from").notNull(),
  validUntil: timestamp("valid_until").notNull(),
  
  // Constraint type and values
  constraintType: mysqlEnum("constraint_type", [
    "max_power",
    "min_power",
    "max_energy",
    "min_soc",
    "max_soc",
    "unavailable",
    "must_run",
    "user_preference"
  ]).notNull(),
  
  constraintValue: int("constraint_value"), // Value depends on type
  priority: int("priority").default(5).notNull(), // 1-10, higher = more important
  
  // Source of constraint
  source: mysqlEnum("source", [
    "user",
    "operator",
    "system",
    "safety",
    "grid_code"
  ]).notNull(),
  
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
export const gridServiceProducts = mysqlTable("grid_service_products", {
  id: int("id").autoincrement().primaryKey(),
  
  // Service identification
  serviceCode: varchar("service_code", { length: 50 }).notNull().unique(),
  serviceName: varchar("service_name", { length: 255 }).notNull(),
  serviceType: mysqlEnum("service_type", [
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
  ]).notNull(),
  
  // Market/region
  marketRegion: varchar("market_region", { length: 50 }).notNull(), // e.g., "NG-LAGOS", "TZ-DAR", "CAISO", "PJM"
  
  // Technical requirements
  minCapacityKw: int("min_capacity_kw"),
  maxResponseTimeMs: int("max_response_time_ms"),
  minDurationMinutes: int("min_duration_minutes"),
  telemetryIntervalSeconds: int("telemetry_interval_seconds"),
  
  // Compensation structure
  compensationType: mysqlEnum("compensation_type", [
    "energy_only",
    "capacity_only",
    "capacity_plus_energy",
    "performance_based"
  ]).notNull(),
  baseRateCents: int("base_rate_cents"), // Base rate in cents per kWh or kW
  performanceMultiplier: int("performance_multiplier"), // Multiplier * 100
  
  // Availability
  isActive: boolean("is_active").default(true).notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type GridServiceProduct = typeof gridServiceProducts.$inferSelect;
export type InsertGridServiceProduct = typeof gridServiceProducts.$inferInsert;

/**
 * Service Enrollments - DERs enrolled in specific services
 */
export const serviceEnrollments = mysqlTable("service_enrollments", {
  id: int("id").autoincrement().primaryKey(),
  assetId: int("asset_id").notNull(),
  serviceProductId: int("service_product_id").notNull(),
  userId: int("user_id").notNull(),
  
  // Enrollment details
  enrolledCapacityKw: int("enrolled_capacity_kw").notNull(),
  status: mysqlEnum("status", ["pending", "active", "suspended", "terminated"]).default("pending").notNull(),
  
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
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type ServiceEnrollment = typeof serviceEnrollments.$inferSelect;
export type InsertServiceEnrollment = typeof serviceEnrollments.$inferInsert;

// ============================================================================
// OPTIMIZATION AND DISPATCH
// ============================================================================

/**
 * Dispatch Schedules - Planned dispatch for DERs
 */
export const dispatchSchedules = mysqlTable("dispatch_schedules", {
  id: int("id").autoincrement().primaryKey(),
  
  // Schedule identification
  scheduleId: varchar("schedule_id", { length: 64 }).notNull().unique(),
  
  // Time window
  scheduleStart: timestamp("schedule_start").notNull(),
  scheduleEnd: timestamp("schedule_end").notNull(),
  intervalMinutes: int("interval_minutes").default(15).notNull(),
  
  // Optimization context
  optimizationRunId: varchar("optimization_run_id", { length: 64 }),
  objectiveFunction: mysqlEnum("objective_function", [
    "minimize_cost",
    "maximize_revenue",
    "minimize_emissions",
    "maximize_self_consumption",
    "balance_grid"
  ]).notNull(),
  
  // Status
  status: mysqlEnum("status", [
    "draft",
    "optimized",
    "approved",
    "dispatching",
    "completed",
    "cancelled"
  ]).default("draft").notNull(),
  
  // Results
  totalExpectedRevenue: int("total_expected_revenue"), // cents
  totalExpectedCost: int("total_expected_cost"), // cents
  totalExpectedEmissionsSaved: int("total_expected_emissions_saved"), // grams CO2
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type DispatchSchedule = typeof dispatchSchedules.$inferSelect;
export type InsertDispatchSchedule = typeof dispatchSchedules.$inferInsert;

/**
 * Dispatch Setpoints - Individual setpoints within a schedule
 */
export const dispatchSetpoints = mysqlTable("dispatch_setpoints", {
  id: int("id").autoincrement().primaryKey(),
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
  status: mysqlEnum("status", [
    "scheduled",
    "dispatched",
    "acknowledged",
    "executing",
    "completed",
    "failed",
    "skipped"
  ]).default("scheduled").notNull(),
  
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
export const settlementEvents = mysqlTable("settlement_events", {
  id: int("id").autoincrement().primaryKey(),
  
  // Hash chain for tamper evidence
  eventHash: varchar("event_hash", { length: 64 }).notNull().unique(), // SHA-256
  // Unique: two concurrent writers must not both claim the same slot, which
  // would fork the hash chain into two branches that each verify in isolation.
  previousHash: varchar("previous_hash", { length: 64 }).notNull().unique(),
  sequenceNumber: bigint("sequence_number", { mode: "number" }).notNull().unique(),
  
  // Event identification
  eventType: mysqlEnum("event_type", [
    "dispatch_completed",
    "service_delivered",
    "measurement_verified",
    "compensation_calculated",
    "payment_initiated",
    "payment_completed",
    "dispute_raised",
    "dispute_resolved",
    "adjustment_applied"
  ]).notNull(),
  
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
  currency: mysqlEnum("currency", ["NGN", "TZS", "USD"]).notNull(),
  
  // Verification
  measurementMethod: varchar("measurement_method", { length: 50 }),
  baselineMethod: varchar("baseline_method", { length: 50 }),
  verificationStatus: mysqlEnum("verification_status", [
    "pending",
    "verified",
    "disputed",
    "adjusted"
  ]).default("pending").notNull(),
  
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
export const settlementPeriods = mysqlTable("settlement_periods", {
  id: int("id").autoincrement().primaryKey(),
  
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
  status: mysqlEnum("status", [
    "open",
    "closed",
    "invoiced",
    "paid",
    "disputed"
  ]).default("open").notNull(),
  
  // Hash of all events in period for verification
  periodHash: varchar("period_hash", { length: 64 }),
  eventCount: int("event_count").default(0).notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type SettlementPeriod = typeof settlementPeriods.$inferSelect;
export type InsertSettlementPeriod = typeof settlementPeriods.$inferInsert;

// ============================================================================
// EV AND V2G SUPPORT
// ============================================================================

/**
 * Electric Vehicles - EV registration and management
 */
export const electricVehicles = mysqlTable("electric_vehicles", {
  id: int("id").autoincrement().primaryKey(),
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
  bidirectionalProtocol: mysqlEnum("bidirectional_protocol", [
    "none",
    "chademo",
    "ccs_v2g",
    "iso15118"
  ]).default("none").notNull(),
  
  // Current state
  currentSocPercent: int("current_soc_percent"), // percentage * 100
  lastKnownLocation: varchar("last_known_location", { length: 255 }),
  isPluggedIn: boolean("is_plugged_in").default(false).notNull(),
  isCharging: boolean("is_charging").default(false).notNull(),
  
  // User preferences
  minSocPercent: int("min_soc_percent").default(2000).notNull(), // 20% default
  targetSocPercent: int("target_soc_percent").default(8000).notNull(), // 80% default
  
  status: mysqlEnum("status", ["active", "inactive", "maintenance"]).default("active").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type ElectricVehicle = typeof electricVehicles.$inferSelect;
export type InsertElectricVehicle = typeof electricVehicles.$inferInsert;

/**
 * EV Charging Stations (EVSE)
 */
export const chargingStations = mysqlTable("charging_stations", {
  id: int("id").autoincrement().primaryKey(),
  
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
  connectorType: mysqlEnum("connector_type", [
    "type1",
    "type2",
    "chademo",
    "ccs1",
    "ccs2",
    "tesla"
  ]).notNull(),
  maxPowerKw: int("max_power_kw").notNull(), // kW * 10
  
  // V2G capability
  v2gCapable: boolean("v2g_capable").default(false).notNull(),
  
  // Communication
  ocppVersion: mysqlEnum("ocpp_version", ["1.6", "2.0", "2.0.1"]),
  ocppEndpoint: varchar("ocpp_endpoint", { length: 255 }),
  
  // Status
  status: mysqlEnum("status", [
    "available",
    "occupied",
    "charging",
    "discharging",
    "faulted",
    "offline"
  ]).default("offline").notNull(),
  
  lastHeartbeat: timestamp("last_heartbeat"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type ChargingStation = typeof chargingStations.$inferSelect;
export type InsertChargingStation = typeof chargingStations.$inferInsert;

/**
 * Charging Sessions
 */
export const chargingSessions = mysqlTable("charging_sessions", {
  id: int("id").autoincrement().primaryKey(),
  
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
  sessionType: mysqlEnum("session_type", [
    "standard_charge",
    "smart_charge",
    "v2g",
    "v2h"
  ]).default("standard_charge").notNull(),
  
  // User preferences for this session
  targetSocPercent: int("target_soc_percent"),
  departureTime: timestamp("departure_time"),
  
  // Cost
  totalCost: int("total_cost"), // cents
  totalRevenue: int("total_revenue"), // cents (for V2G)
  
  status: mysqlEnum("status", [
    "starting",
    "charging",
    "discharging",
    "paused",
    "completed",
    "failed"
  ]).default("starting").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type ChargingSession = typeof chargingSessions.$inferSelect;
export type InsertChargingSession = typeof chargingSessions.$inferInsert;

// ============================================================================
// COMMUNITY ENERGY
// ============================================================================

/**
 * Energy Communities - Groups of users sharing energy resources
 */
export const energyCommunities = mysqlTable("energy_communities", {
  id: int("id").autoincrement().primaryKey(),
  
  // Community identification
  communityCode: varchar("community_code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  
  // Type and structure
  communityType: mysqlEnum("community_type", [
    "residential",
    "commercial",
    "mixed",
    "microgrid",
    "virtual"
  ]).notNull(),
  
  // Location (for physical communities)
  region: varchar("region", { length: 100 }),
  gridConnectionPoint: varchar("grid_connection_point", { length: 100 }),
  
  // Governance
  governanceModel: mysqlEnum("governance_model", [
    "cooperative",
    "utility_managed",
    "peer_to_peer",
    "hybrid"
  ]).default("cooperative").notNull(),
  
  // Shared resources
  hasSharedBattery: boolean("has_shared_battery").default(false).notNull(),
  hasSharedSolar: boolean("has_shared_solar").default(false).notNull(),
  sharedCapacityKw: int("shared_capacity_kw"),
  
  // Microgrid capability
  canIsland: boolean("can_island").default(false).notNull(),
  islandingMode: mysqlEnum("islanding_mode", [
    "grid_tied",
    "islanded",
    "transitioning"
  ]).default("grid_tied").notNull(),
  
  // Financial
  allocationMethod: mysqlEnum("allocation_method", [
    "equal_share",
    "proportional_capacity",
    "proportional_consumption",
    "dynamic_pricing",
    "custom"
  ]).default("proportional_capacity").notNull(),
  
  status: mysqlEnum("status", ["forming", "active", "suspended", "dissolved"]).default("forming").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type EnergyCommunity = typeof energyCommunities.$inferSelect;
export type InsertEnergyCommunity = typeof energyCommunities.$inferInsert;

/**
 * Community Members
 */
export const communityMembers = mysqlTable("community_members", {
  id: int("id").autoincrement().primaryKey(),
  communityId: int("community_id").notNull(),
  userId: int("user_id").notNull(),
  
  // Membership details
  role: mysqlEnum("role", ["member", "prosumer", "admin", "operator"]).default("member").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
  
  // Contribution
  contributedCapacityKw: int("contributed_capacity_kw").default(0).notNull(),
  sharePercentage: int("share_percentage"), // percentage * 100
  
  // Preferences
  autoParticipate: boolean("auto_participate").default(true).notNull(),
  priorityLevel: int("priority_level").default(5).notNull(), // 1-10 for load shedding priority
  
  status: mysqlEnum("status", ["pending", "active", "suspended", "left"]).default("pending").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type CommunityMember = typeof communityMembers.$inferSelect;
export type InsertCommunityMember = typeof communityMembers.$inferInsert;

/**
 * Community Allocations - Energy sharing within community
 */
export const communityAllocations = mysqlTable("community_allocations", {
  id: int("id").autoincrement().primaryKey(),
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
  
  status: mysqlEnum("status", ["calculated", "approved", "distributed", "disputed"]).default("calculated").notNull(),
  
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
export const emissionsFactors = mysqlTable("emissions_factors", {
  id: int("id").autoincrement().primaryKey(),
  
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
export const carbonCredits = mysqlTable("carbon_credits", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  
  // Credit identification
  creditType: mysqlEnum("credit_type", [
    "rec", // Renewable Energy Certificate
    "carbon_offset",
    "green_certificate",
    "i_rec" // International REC
  ]).notNull(),
  
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
  status: mysqlEnum("status", [
    "pending",
    "issued",
    "transferred",
    "retired",
    "cancelled"
  ]).default("pending").notNull(),
  
  // Blockchain proof (optional)
  blockchainProof: varchar("blockchain_proof", { length: 66 }),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type CarbonCredit = typeof carbonCredits.$inferSelect;
export type InsertCarbonCredit = typeof carbonCredits.$inferInsert;

// ============================================================================
// FORECASTING
// ============================================================================

/**
 * Forecast Runs - Metadata for forecast model executions
 */
export const forecastRuns = mysqlTable("forecast_runs", {
  id: int("id").autoincrement().primaryKey(),
  
  // Run identification
  runId: varchar("run_id", { length: 64 }).notNull().unique(),
  
  // Forecast type
  forecastType: mysqlEnum("forecast_type", [
    "load",
    "solar_generation",
    "wind_generation",
    "price",
    "emissions",
    "ev_availability"
  ]).notNull(),
  
  // Scope
  scopeType: mysqlEnum("scope_type", ["asset", "user", "community", "region"]).notNull(),
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
  status: mysqlEnum("status", ["running", "completed", "failed"]).default("running").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ForecastRun = typeof forecastRuns.$inferSelect;
export type InsertForecastRun = typeof forecastRuns.$inferInsert;

/**
 * Forecast Values - Probabilistic forecast outputs
 */
export const forecastValues = mysqlTable("forecast_values", {
  id: int("id").autoincrement().primaryKey(),
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
export const modelRegistry = mysqlTable("model_registry", {
  id: int("id").autoincrement().primaryKey(),
  
  // Model identification
  modelName: varchar("model_name", { length: 100 }).notNull(),
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  
  // Model type
  modelType: mysqlEnum("model_type", [
    "load_forecast",
    "generation_forecast",
    "price_forecast",
    "anomaly_detection",
    "optimization"
  ]).notNull(),
  
  // Artifact storage
  artifactPath: varchar("artifact_path", { length: 500 }),
  artifactHash: varchar("artifact_hash", { length: 64 }),
  
  // Training info
  trainingDataStart: timestamp("training_data_start"),
  trainingDataEnd: timestamp("training_data_end"),
  trainingDurationSeconds: int("training_duration_seconds"),
  
  // Performance metrics
  validationMae: int("validation_mae"), // * 100
  validationRmse: int("validation_rmse"), // * 100
  validationMape: int("validation_mape"), // * 100
  
  // Deployment status
  status: mysqlEnum("status", [
    "training",
    "validating",
    "staging",
    "production",
    "deprecated",
    "failed"
  ]).default("training").notNull(),
  
  deployedAt: timestamp("deployed_at"),
  deprecatedAt: timestamp("deprecated_at"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type ModelRegistryEntry = typeof modelRegistry.$inferSelect;
export type InsertModelRegistryEntry = typeof modelRegistry.$inferInsert;

/**
 * Model Drift Detection - Track model performance over time
 */
export const modelDriftEvents = mysqlTable("model_drift_events", {
  id: int("id").autoincrement().primaryKey(),
  modelId: int("model_id").notNull(),
  
  // Detection time
  detectedAt: timestamp("detected_at").notNull(),
  
  // Drift metrics
  driftType: mysqlEnum("drift_type", [
    "data_drift",
    "concept_drift",
    "performance_degradation"
  ]).notNull(),
  
  // Statistical measures
  psiScore: int("psi_score"), // Population Stability Index * 1000
  klDivergence: int("kl_divergence"), // KL Divergence * 1000
  currentMae: int("current_mae"), // * 100
  baselineMae: int("baseline_mae"), // * 100
  
  // Severity
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).notNull(),
  
  // Action taken
  actionTaken: mysqlEnum("action_taken", [
    "none",
    "alert_sent",
    "retrain_triggered",
    "model_rolled_back"
  ]).default("none").notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ModelDriftEvent = typeof modelDriftEvents.$inferSelect;
export type InsertModelDriftEvent = typeof modelDriftEvents.$inferInsert;

// ============================================================================
// EDGE ORCHESTRATION
// ============================================================================

/**
 * Edge Gateways - Local control nodes
 */
export const edgeGateways = mysqlTable("edge_gateways", {
  id: int("id").autoincrement().primaryKey(),
  
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
  primaryProtocol: mysqlEnum("primary_protocol", ["mqtt", "grpc", "https"]).default("mqtt").notNull(),
  connectionEndpoint: varchar("connection_endpoint", { length: 255 }),
  
  // Capabilities
  canOperateOffline: boolean("can_operate_offline").default(true).notNull(),
  localStorageCapacityMb: int("local_storage_capacity_mb"),
  maxManagedDevices: int("max_managed_devices"),
  
  // Security
  certificateFingerprint: varchar("certificate_fingerprint", { length: 64 }),
  lastCertificateRotation: timestamp("last_certificate_rotation"),
  
  // Status
  status: mysqlEnum("status", ["online", "offline", "degraded", "maintenance"]).default("offline").notNull(),
  lastHeartbeat: timestamp("last_heartbeat"),
  
  // Offline operation state
  offlineMode: boolean("offline_mode").default(false).notNull(),
  pendingCommandsCount: int("pending_commands_count").default(0).notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type EdgeGateway = typeof edgeGateways.$inferSelect;
export type InsertEdgeGateway = typeof edgeGateways.$inferInsert;

/**
 * Edge Commands - Commands queued for edge execution
 */
export const edgeCommands = mysqlTable("edge_commands", {
  id: int("id").autoincrement().primaryKey(),
  gatewayId: int("gateway_id").notNull(),
  
  // Command identification
  commandId: varchar("command_id", { length: 64 }).notNull().unique(),
  idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
  
  // Target
  targetDeviceId: int("target_device_id"),
  targetAssetId: int("target_asset_id"),
  
  // Command details
  commandType: mysqlEnum("command_type", [
    "set_power",
    "set_soc_target",
    "start_charging",
    "stop_charging",
    "enable_v2g",
    "disable_v2g",
    "emergency_stop",
    "update_config"
  ]).notNull(),
  
  commandPayload: text("command_payload").notNull(), // JSON
  
  // Priority and timing
  priority: int("priority").default(5).notNull(), // 1-10
  validUntil: timestamp("valid_until").notNull(),
  
  // Execution status
  status: mysqlEnum("status", [
    "queued",
    "sent",
    "acknowledged",
    "executing",
    "completed",
    "failed",
    "expired"
  ]).default("queued").notNull(),
  
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
export const complianceRules = mysqlTable("compliance_rules", {
  id: int("id").autoincrement().primaryKey(),
  
  // Rule identification
  ruleCode: varchar("rule_code", { length: 50 }).notNull().unique(),
  ruleName: varchar("rule_name", { length: 255 }).notNull(),
  
  // Jurisdiction
  jurisdiction: varchar("jurisdiction", { length: 100 }).notNull(), // e.g., "NG", "TZ", "US-CA", "EU"
  regulatoryBody: varchar("regulatory_body", { length: 255 }),
  
  // Rule type
  ruleType: mysqlEnum("rule_type", [
    "data_retention",
    "privacy",
    "reporting",
    "technical_standard",
    "market_participation",
    "safety"
  ]).notNull(),
  
  // Rule definition
  description: text("description").notNull(),
  requirements: text("requirements").notNull(), // JSON array of specific requirements
  
  // Applicability
  appliesToAssetTypes: text("applies_to_asset_types"), // JSON array
  appliesToServiceTypes: text("applies_to_service_types"), // JSON array
  
  // Enforcement
  enforcementDate: timestamp("enforcement_date"),
  penaltyDescription: text("penalty_description"),
  
  isActive: boolean("is_active").default(true).notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type ComplianceRule = typeof complianceRules.$inferSelect;
export type InsertComplianceRule = typeof complianceRules.$inferInsert;

/**
 * Compliance Checks - Automated compliance verification
 */
export const complianceChecks = mysqlTable("compliance_checks", {
  id: int("id").autoincrement().primaryKey(),
  ruleId: int("rule_id").notNull(),
  
  // Check scope
  entityType: mysqlEnum("entity_type", ["user", "asset", "community", "system"]).notNull(),
  entityId: int("entity_id"),
  
  // Check execution
  checkedAt: timestamp("checked_at").notNull(),
  
  // Result
  status: mysqlEnum("status", ["compliant", "non_compliant", "warning", "not_applicable"]).notNull(),
  
  // Details
  findings: text("findings"), // JSON array of specific findings
  recommendedActions: text("recommended_actions"), // JSON array
  
  // Resolution
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
export const anomalyEvents = mysqlTable("anomaly_events", {
  id: int("id").autoincrement().primaryKey(),
  assetId: int("asset_id").notNull(),
  
  // Detection
  detectedAt: timestamp("detected_at").notNull(),
  
  // Anomaly classification
  anomalyType: mysqlEnum("anomaly_type", [
    "power_deviation",
    "efficiency_drop",
    "temperature_abnormal",
    "communication_loss",
    "voltage_anomaly",
    "frequency_deviation",
    "soc_inconsistency",
    "performance_degradation"
  ]).notNull(),
  
  // Severity
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).notNull(),
  
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
  recommendedAction: mysqlEnum("recommended_action", [
    "monitor",
    "schedule_inspection",
    "immediate_inspection",
    "reduce_load",
    "shutdown"
  ]).default("monitor").notNull(),
  
  // Resolution
  status: mysqlEnum("status", ["open", "acknowledged", "investigating", "resolved", "false_positive"]).default("open").notNull(),
  resolvedAt: timestamp("resolved_at"),
  resolutionNotes: text("resolution_notes"),
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AnomalyEvent = typeof anomalyEvents.$inferSelect;
export type InsertAnomalyEvent = typeof anomalyEvents.$inferInsert;

// All types are exported inline above with their table definitions
