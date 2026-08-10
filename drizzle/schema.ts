import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, decimal } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 20 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  country: mysqlEnum("country", ["nigeria", "tanzania"]).default("nigeria").notNull(),
  currency: mysqlEnum("currency", ["NGN", "TZS", "USD"]).default("NGN").notNull(),
  language: mysqlEnum("language", ["en", "ha", "yo", "ig", "sw"]).default("en").notNull(),
  timezone: varchar("timezone", { length: 50 }).default("Africa/Lagos").notNull(),
  onboardingCompleted: boolean("onboardingCompleted").default(false).notNull(),
  onboardingStep: int("onboardingStep").default(0).notNull(), // 0=not started, 1-4=steps, 5=completed
  onboardingSkipped: boolean("onboardingSkipped").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Assets table - stores solar panels, batteries, meters, generators
 */
export const assets = mysqlTable("assets", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  assetType: mysqlEnum("assetType", ["solar", "battery", "meter", "generator", "wind"]).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  capacity: int("capacity").notNull(), // in watts for solar/wind, watt-hours for battery
  make: varchar("make", { length: 255 }),
  model: varchar("model", { length: 255 }),
  serialNumber: varchar("serialNumber", { length: 255 }),
  installationDate: timestamp("installationDate"),
  status: mysqlEnum("status", ["active", "inactive", "maintenance", "fault"]).default("active").notNull(),
  approvalStatus: mysqlEnum("approvalStatus", ["pending", "approved", "rejected"]).default("pending").notNull(),
  metadata: text("metadata"), // JSON string for additional data
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Asset = typeof assets.$inferSelect;
export type InsertAsset = typeof assets.$inferInsert;

/**
 * Telemetry table - stores real-time and historical data from assets
 */
export const telemetry = mysqlTable("telemetry", {
  id: int("id").autoincrement().primaryKey(),
  assetId: int("assetId").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  power: int("power"), // current power in watts
  energy: int("energy"), // cumulative energy in watt-hours
  voltage: int("voltage"), // in millivolts
  current: int("current"), // in milliamps
  frequency: int("frequency"), // in millihertz
  stateOfCharge: int("stateOfCharge"), // battery SoC in percentage * 100
  temperature: int("temperature"), // in celsius * 100
  metadata: text("metadata"), // JSON string for additional metrics
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Telemetry = typeof telemetry.$inferSelect;
export type InsertTelemetry = typeof telemetry.$inferInsert;

/**
 * Contracts table - stores partnership agreements (Asset Aggregation, Full Control, Prepaid)
 */
export const contracts = mysqlTable("contracts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  contractType: mysqlEnum("contractType", ["asset_aggregation", "full_control", "prepaid"]).notNull(),
  revenueSharePercentage: int("revenueSharePercentage").default(70).notNull(), // consumer's share (70%)
  monthlyFee: int("monthlyFee").default(0).notNull(), // in cents
  minimumRevenue: int("minimumRevenue").default(0).notNull(), // minimum guarantee in cents
  startDate: timestamp("startDate").notNull(),
  endDate: timestamp("endDate"),
  status: mysqlEnum("status", ["active", "expired", "cancelled"]).default("active").notNull(),
  signedAt: timestamp("signedAt").defaultNow().notNull(),
  metadata: text("metadata"), // JSON string for contract terms
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Contract = typeof contracts.$inferSelect;
export type InsertContract = typeof contracts.$inferInsert;

/**
 * Trading table - stores trading transactions and orders
 */
export const trades = mysqlTable("trades", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  tradeType: mysqlEnum("tradeType", ["export", "import", "p2p_sell", "p2p_buy"]).notNull(),
  tradingMode: mysqlEnum("tradingMode", ["automatic", "manual", "p2p"]).default("automatic").notNull(),
  energy: int("energy").notNull(), // in watt-hours
  price: int("price").notNull(), // in cents per kWh
  totalAmount: int("totalAmount").notNull(), // in cents
  timestamp: timestamp("timestamp").notNull(),
  status: mysqlEnum("status", ["pending", "executed", "cancelled", "failed"]).default("pending").notNull(),
  counterpartyId: int("counterpartyId"), // for P2P trades
  metadata: text("metadata"), // JSON string for trade details
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Trade = typeof trades.$inferSelect;
export type InsertTrade = typeof trades.$inferInsert;

/**
 * Market prices table - stores real-time electricity prices
 */
export const marketPrices = mysqlTable("marketPrices", {
  id: int("id").autoincrement().primaryKey(),
  country: mysqlEnum("country", ["nigeria", "tanzania"]).notNull(),
  priceType: mysqlEnum("priceType", ["off_peak", "shoulder", "peak", "super_peak"]).notNull(),
  price: int("price").notNull(), // in cents per kWh
  timestamp: timestamp("timestamp").notNull(),
  validUntil: timestamp("validUntil").notNull(),
  metadata: text("metadata"), // JSON string for market data
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type MarketPrice = typeof marketPrices.$inferSelect;
export type InsertMarketPrice = typeof marketPrices.$inferInsert;

/**
 * Billing table - stores invoices and payment records
 */
export const billings = mysqlTable("billings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  billingType: mysqlEnum("billingType", ["postpaid", "prepaid"]).notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  generationKwh: int("generationKwh").default(0).notNull(),
  consumptionKwh: int("consumptionKwh").default(0).notNull(),
  exportKwh: int("exportKwh").default(0).notNull(),
  exportRevenue: int("exportRevenue").default(0).notNull(), // in cents
  selfConsumptionSavings: int("selfConsumptionSavings").default(0).notNull(), // in cents
  totalValue: int("totalValue").default(0).notNull(), // in cents
  consumerShare: int("consumerShare").default(0).notNull(), // in cents (70%)
  vppCommission: int("vppCommission").default(0).notNull(), // in cents (30%)
  status: mysqlEnum("status", ["draft", "issued", "paid", "overdue", "cancelled"]).default("draft").notNull(),
  paidAt: timestamp("paidAt"),
  paymentMethod: varchar("paymentMethod", { length: 50 }),
  transactionId: varchar("transactionId", { length: 255 }),
  metadata: text("metadata"), // JSON string for billing details
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Billing = typeof billings.$inferSelect;
export type InsertBilling = typeof billings.$inferInsert;

/**
 * Payments table - stores payment transactions
 */
export const payments = mysqlTable("payments", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  billingId: int("billingId"),
  paymentType: mysqlEnum("paymentType", ["invoice", "token_purchase", "monthly_fee"]).notNull(),
  amount: int("amount").notNull(), // in cents
  currency: mysqlEnum("currency", ["NGN", "TZS", "USD"]).notNull(),
  paymentMethod: mysqlEnum("paymentMethod", ["mpesa", "airtel_money", "tigo_pesa", "bank_transfer", "card"]).notNull(),
  phoneNumber: varchar("phoneNumber", { length: 20 }),
  accountNumber: varchar("accountNumber", { length: 100 }),
  transactionId: varchar("transactionId", { length: 255 }),
  status: mysqlEnum("status", ["pending", "completed", "failed", "refunded"]).default("pending").notNull(),
  metadata: text("metadata"), // JSON string for payment details
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Payment = typeof payments.$inferSelect;
export type InsertPayment = typeof payments.$inferInsert;

/**
 * Tokens table - stores prepaid electricity tokens
 */
export const tokens = mysqlTable("tokens", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  paymentId: int("paymentId").notNull(),
  tokenCode: varchar("tokenCode", { length: 50 }).notNull().unique(),
  energyKwh: int("energyKwh").notNull(),
  amount: int("amount").notNull(), // in cents
  validUntil: timestamp("validUntil").notNull(),
  status: mysqlEnum("status", ["active", "used", "expired", "pending_issuance"]).default("active").notNull(),
  usedAt: timestamp("usedAt"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Token = typeof tokens.$inferSelect;
export type InsertToken = typeof tokens.$inferInsert;

/**
 * Alerts table - stores user notifications and system alerts
 */
export const alerts = mysqlTable("alerts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  alertType: mysqlEnum("alertType", ["system", "trading", "billing", "maintenance"]).notNull(),
  severity: mysqlEnum("severity", ["info", "warning", "error", "critical"]).default("info").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  isRead: boolean("isRead").default(false).notNull(),
  readAt: timestamp("readAt"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = typeof alerts.$inferInsert;

/**
 * Trading preferences table - stores user trading settings
 */
export const tradingPreferences = mysqlTable("tradingPreferences", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  tradingMode: mysqlEnum("tradingMode", ["automatic", "manual", "hybrid"]).default("automatic").notNull(),
  minExportPrice: int("minExportPrice"), // in cents per kWh
  maxImportPrice: int("maxImportPrice"), // in cents per kWh
  minBatteryLevel: int("minBatteryLevel").default(20).notNull(), // percentage * 100
  maxBatteryLevel: int("maxBatteryLevel").default(90).notNull(), // percentage * 100
  enableP2P: boolean("enableP2P").default(false).notNull(),
  enableNotifications: boolean("enableNotifications").default(true).notNull(),
  metadata: text("metadata"), // JSON string for additional preferences
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type TradingPreference = typeof tradingPreferences.$inferSelect;
export type InsertTradingPreference = typeof tradingPreferences.$inferInsert;

/**
 * IoT Device Management Schema
 * 
 * Extended schema for managing IoT devices, authentication, and communication
 */

/**
 * Device registry - tracks all IoT devices connected to the platform
 */
export const devices = mysqlTable("devices", {
  id: int("id").autoincrement().primaryKey(),
  assetId: int("assetId").notNull(), // Links to assets table
  deviceId: varchar("deviceId", { length: 255 }).notNull().unique(), // Unique device identifier (MAC, serial, etc.)
  deviceType: mysqlEnum("deviceType", ["smart_meter", "inverter", "battery_controller", "sensor"]).notNull(),
  manufacturer: varchar("manufacturer", { length: 255 }),
  model: varchar("model", { length: 255 }),
  firmwareVersion: varchar("firmwareVersion", { length: 50 }),
  
  // MQTT Configuration
  mqttClientId: varchar("mqttClientId", { length: 255 }),
  mqttUsername: varchar("mqttUsername", { length: 255 }),
  mqttPasswordHash: text("mqttPasswordHash"), // Hashed password for device authentication
  
  // Status and Health
  status: mysqlEnum("status", ["online", "offline", "error", "maintenance"]).default("offline").notNull(),
  lastSeen: timestamp("lastSeen"),
  lastMessageAt: timestamp("lastMessageAt"),
  
  // Configuration
  telemetryInterval: int("telemetryInterval").default(5).notNull(), // seconds
  enabled: boolean("enabled").default(true).notNull(),
  
  // Metadata
  metadata: text("metadata"), // JSON string for additional device info
  
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Device = typeof devices.$inferSelect;
export type InsertDevice = typeof devices.$inferInsert;

/**
 * Device commands - track commands sent to devices
 */
export const deviceCommands = mysqlTable("device_commands", {
  id: int("id").autoincrement().primaryKey(),
  deviceId: int("deviceId").notNull(),
  command: varchar("command", { length: 100 }).notNull(),
  payload: text("payload"), // JSON string
  status: mysqlEnum("status", ["pending", "sent", "acknowledged", "failed"]).default("pending").notNull(),
  sentAt: timestamp("sentAt"),
  acknowledgedAt: timestamp("acknowledgedAt"),
  response: text("response"), // JSON string
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DeviceCommand = typeof deviceCommands.$inferSelect;
export type InsertDeviceCommand = typeof deviceCommands.$inferInsert;

/**
 * Device logs - audit trail of device events
 */
export const deviceLogs = mysqlTable("device_logs", {
  id: int("id").autoincrement().primaryKey(),
  deviceId: int("deviceId").notNull(),
  eventType: mysqlEnum("eventType", ["connected", "disconnected", "error", "warning", "info"]).notNull(),
  message: text("message").notNull(),
  metadata: text("metadata"), // JSON string
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DeviceLog = typeof deviceLogs.$inferSelect;
export type InsertDeviceLog = typeof deviceLogs.$inferInsert;

/**
 * Demand Response Events - Grid operator load reduction requests
 */
export const demandResponseEvents = mysqlTable("demandResponseEvents", {
  id: int("id").autoincrement().primaryKey(),
  operatorId: int("operatorId").notNull(), // Grid operator/utility company
  eventName: varchar("eventName", { length: 255 }).notNull(),
  eventType: mysqlEnum("eventType", ["peak_shaving", "load_shifting", "emergency", "economic"]).notNull(),
  targetReduction: int("targetReduction").notNull(), // kW to reduce
  startTime: timestamp("startTime").notNull(),
  endTime: timestamp("endTime").notNull(),
  compensationRate: int("compensationRate").notNull(), // cents per kWh reduced
  status: mysqlEnum("status", ["scheduled", "active", "completed", "cancelled"]).default("scheduled").notNull(),
  actualReduction: int("actualReduction"), // Actual kW reduced
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DemandResponseEvent = typeof demandResponseEvents.$inferSelect;
export type InsertDemandResponseEvent = typeof demandResponseEvents.$inferInsert;

/**
 * DR Participants - Users enrolled in demand response program
 */
export const drParticipants = mysqlTable("drParticipants", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  enrolledAt: timestamp("enrolledAt").defaultNow().notNull(),
  status: mysqlEnum("status", ["active", "paused", "cancelled"]).default("active").notNull(),
  autoOptIn: boolean("autoOptIn").default(true).notNull(), // Automatically participate in events
  minCompensation: int("minCompensation"), // Minimum cents/kWh to participate
  maxReduction: int("maxReduction"), // Maximum kW willing to reduce
  notificationPreferences: text("notificationPreferences"), // JSON: email, sms, push
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DrParticipant = typeof drParticipants.$inferSelect;
export type InsertDrParticipant = typeof drParticipants.$inferInsert;

/**
 * DR Responses - User participation in specific events
 */
export const drResponses = mysqlTable("drResponses", {
  id: int("id").autoincrement().primaryKey(),
  eventId: int("eventId").notNull(),
  userId: int("userId").notNull(),
  participationStatus: mysqlEnum("participationStatus", ["opted_in", "opted_out", "auto_enrolled"]).notNull(),
  targetReduction: int("targetReduction"), // kW user committed to reduce
  actualReduction: int("actualReduction"), // kW actually reduced
  compensation: int("compensation"), // Total compensation earned (cents)
  responseTime: timestamp("responseTime").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DrResponse = typeof drResponses.$inferSelect;
export type InsertDrResponse = typeof drResponses.$inferInsert;

/**
 * DR Compensation - Payment tracking for demand response participation
 */
export const drCompensation = mysqlTable("drCompensation", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  eventId: int("eventId").notNull(),
  responseId: int("responseId").notNull(),
  amount: int("amount").notNull(), // cents
  currency: mysqlEnum("currency", ["NGN", "TZS", "USD"]).notNull(),
  status: mysqlEnum("status", ["pending", "paid", "failed"]).default("pending").notNull(),
  paymentMethod: mysqlEnum("paymentMethod", ["mpesa", "airtel_money", "tigo_pesa", "bank_transfer"]),
  paymentReference: varchar("paymentReference", { length: 255 }),
  paidAt: timestamp("paidAt"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DrCompensation = typeof drCompensation.$inferSelect;
export type InsertDrCompensation = typeof drCompensation.$inferInsert;


/**
 * Payment Gateway Credentials
 * Stores encrypted API credentials for payment gateways
 */
export const paymentCredentials = mysqlTable("payment_credentials", {
  id: int("id").autoincrement().primaryKey(),
  gateway: mysqlEnum("gateway", ["mpesa", "airtel_money", "tigo_pesa"]).notNull(),
  environment: mysqlEnum("environment", ["sandbox", "production"]).notNull().default("sandbox"),
  
  // Encrypted credentials (stored as encrypted JSON)
  credentials: text("credentials").notNull(), // Encrypted JSON blob
  
  // Status and validation
  isActive: mysqlEnum("is_active", ["true", "false"]).notNull().default("false"),
  isValidated: mysqlEnum("is_validated", ["true", "false"]).notNull().default("false"),
  lastValidated: timestamp("last_validated"),
  validationError: text("validation_error"),
  
  // Metadata
  createdBy: int("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type PaymentCredential = typeof paymentCredentials.$inferSelect;
export type InsertPaymentCredential = typeof paymentCredentials.$inferInsert;

/**
 * Payment Gateway Transactions Log
 * Audit trail for all payment gateway interactions
 */
export const paymentGatewayLogs = mysqlTable("payment_gateway_logs", {
  id: int("id").autoincrement().primaryKey(),
  paymentId: int("payment_id"), // Reference to payments table
  gateway: mysqlEnum("gateway", ["mpesa", "airtel_money", "tigo_pesa"]).notNull(),
  
  // Request/Response
  requestType: varchar("request_type", { length: 50 }).notNull(), // STK_PUSH, QUERY, CALLBACK
  requestPayload: text("request_payload"), // JSON
  responsePayload: text("response_payload"), // JSON
  statusCode: int("status_code"),
  
  // Status
  status: mysqlEnum("status", ["pending", "success", "failed", "timeout"]).notNull(),
  errorMessage: text("error_message"),
  
  // Metadata
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PaymentGatewayLog = typeof paymentGatewayLogs.$inferSelect;
export type InsertPaymentGatewayLog = typeof paymentGatewayLogs.$inferInsert;


/**
 * DR Load Forecasts
 * Stores predicted load and DR potential
 */
export const drForecasts = mysqlTable("dr_forecasts", {
  id: int("id").autoincrement().primaryKey(),
  forecastDate: timestamp("forecast_date").notNull(),
  forecastHour: int("forecast_hour").notNull(), // 0-23
  
  // Predictions
  predictedLoad: int("predicted_load").notNull(), // kW
  predictedPeak: int("predicted_peak").notNull(), // kW
  drPotential: int("dr_potential").notNull(), // kW available for reduction
  confidence: int("confidence").notNull(), // 0-100
  
  // Grid conditions
  gridStatus: mysqlEnum("grid_status", ["normal", "stressed", "critical"]).notNull(),
  temperature: int("temperature"), // Celsius * 10
  weatherCondition: varchar("weather_condition", { length: 50 }),
  
  // Recommendations
  recommendedAction: mysqlEnum("recommended_action", ["none", "monitor", "prepare_event", "trigger_event"]).notNull(),
  recommendedReduction: int("recommended_reduction"), // kW
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type DrForecast = typeof drForecasts.$inferSelect;
export type InsertDrForecast = typeof drForecasts.$inferInsert;

/**
 * DR Event Templates
 * Predefined templates for common DR scenarios
 */
export const drEventTemplates = mysqlTable("dr_event_templates", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  eventType: mysqlEnum("event_type", ["peak_shaving", "load_shifting", "emergency", "economic"]).notNull(),
  
  // Template parameters
  defaultDuration: int("default_duration").notNull(), // minutes
  defaultTargetReduction: int("default_target_reduction").notNull(), // kW
  defaultCompensationRate: int("default_compensation_rate").notNull(), // cents per kWh
  
  // Trigger conditions
  triggerCondition: mysqlEnum("trigger_condition", [
    "manual",
    "peak_forecast",
    "grid_stress",
    "price_spike",
    "renewable_surplus"
  ]).notNull(),
  triggerThreshold: int("trigger_threshold"), // Depends on condition
  
  // Notification settings
  advanceNoticeMinutes: int("advance_notice_minutes").default(60).notNull(),
  notificationChannels: text("notification_channels"), // JSON array
  
  isActive: mysqlEnum("is_active", ["true", "false"]).default("true").notNull(),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type DrEventTemplate = typeof drEventTemplates.$inferSelect;
export type InsertDrEventTemplate = typeof drEventTemplates.$inferInsert;

/**
 * DR Automation Rules
 * Rules for automatic event triggering
 */
export const drAutomationRules = mysqlTable("dr_automation_rules", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  templateId: int("template_id").notNull(),
  
  // Trigger conditions
  condition: mysqlEnum("condition", [
    "load_threshold",
    "price_threshold",
    "grid_frequency",
    "renewable_percentage",
    "time_based"
  ]).notNull(),
  operator: mysqlEnum("operator", ["greater_than", "less_than", "equals", "between"]).notNull(),
  threshold: int("threshold").notNull(),
  thresholdMax: int("threshold_max"), // For "between" operator
  
  // Time constraints
  activeHoursStart: int("active_hours_start"), // 0-23
  activeHoursEnd: int("active_hours_end"), // 0-23
  activeDays: varchar("active_days", { length: 50 }), // JSON array of day numbers
  
  // Cooldown period
  cooldownMinutes: int("cooldown_minutes").default(120).notNull(),
  lastTriggered: timestamp("last_triggered"),
  
  isEnabled: mysqlEnum("is_enabled", ["true", "false"]).default("true").notNull(),
  priority: int("priority").default(5).notNull(), // 1-10, higher = more important
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type DrAutomationRule = typeof drAutomationRules.$inferSelect;
export type InsertDrAutomationRule = typeof drAutomationRules.$inferInsert;

/**
 * Grid Monitoring Data
 * Real-time grid status and metrics
 */
export const gridMonitoring = mysqlTable("grid_monitoring", {
  id: int("id").autoincrement().primaryKey(),
  timestamp: timestamp("timestamp").notNull(),
  
  // Load metrics
  totalLoad: int("total_load").notNull(), // kW
  peakLoad: int("peak_load").notNull(), // kW
  averageLoad: int("average_load").notNull(), // kW
  
  // Generation metrics
  totalGeneration: int("total_generation").notNull(), // kW
  renewableGeneration: int("renewable_generation").notNull(), // kW
  renewablePercentage: int("renewable_percentage").notNull(), // 0-100
  
  // Grid health
  frequency: int("frequency").notNull(), // Hz * 100
  voltage: int("voltage").notNull(), // V
  gridStatus: mysqlEnum("grid_status", ["normal", "stressed", "critical", "emergency"]).notNull(),
  
  // Market data
  spotPrice: int("spot_price"), // cents per kWh
  forecastPrice: int("forecast_price"), // cents per kWh for next hour
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type GridMonitoring = typeof gridMonitoring.$inferSelect;
export type InsertGridMonitoring = typeof gridMonitoring.$inferInsert;


// Payment Reconciliation Tables
export { paymentReconciliations, reconciliationReports, reconciliationAuditLogs } from './reconciliation-schema';
export type { PaymentReconciliation, InsertPaymentReconciliation, ReconciliationReport, InsertReconciliationReport, ReconciliationAuditLog, InsertReconciliationAuditLog } from './reconciliation-schema';


// DR Participant Segmentation Tables
export { participantScores, participantSegments, drCampaigns } from './dr-segmentation-schema';
export type { ParticipantScore, InsertParticipantScore, ParticipantSegment, InsertParticipantSegment, DrCampaign, InsertDrCampaign } from './dr-segmentation-schema';


// Achievements and Gamification Tables
export { achievements, userAchievements, leaderboardEntries } from './achievements-schema';
export type { Achievement, InsertAchievement, UserAchievement, InsertUserAchievement, LeaderboardEntry, InsertLeaderboardEntry } from './achievements-schema';


// Notification Preferences
export { notificationPreferences } from './notification-preferences-schema';
export type { NotificationPreference, InsertNotificationPreference } from './notification-preferences-schema';

// Push Subscriptions
export { pushSubscriptions } from './push-subscriptions-schema';
export type { PushSubscription, InsertPushSubscription } from './push-subscriptions-schema';

// Biometric Credentials
export { biometricCredentials } from './biometric-credentials-schema';
export type { BiometricCredential, InsertBiometricCredential } from './biometric-credentials-schema';

// Audit Logs
export { auditLogs } from './audit-logs-schema';
export type { AuditLog, InsertAuditLog } from './audit-logs-schema';

// Trading Strategies
export { tradingStrategies } from './trading-strategies-schema';
export type { TradingStrategy, InsertTradingStrategy } from './trading-strategies-schema';

// Strategy Templates
export { strategyTemplates } from './strategy-templates-schema';
export type { StrategyTemplate, InsertStrategyTemplate } from './strategy-templates-schema';

// Price Alerts
export { priceAlerts } from './price-alerts-schema';
export type { PriceAlert, InsertPriceAlert } from './price-alerts-schema';

// Referrals
export { referrals, referralRewards } from './referrals-schema';
export type { Referral, InsertReferral, ReferralReward, InsertReferralReward } from './referrals-schema';

// QR Code History
export * from "./qr-history-schema";

/**
 * MQTT Broker Credentials
 * Secure storage for MQTT broker connection details
 */
export const mqttBrokerCredentials = mysqlTable("mqtt_broker_credentials", {
  id: int("id").autoincrement().primaryKey(),
  environment: mysqlEnum("environment", ["sandbox", "production"]).notNull(),
  credentials: text("credentials").notNull(), // JSON string with connection details
  isActive: mysqlEnum("is_active", ["true", "false"]).default("true").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type MqttBrokerCredential = typeof mqttBrokerCredentials.$inferSelect;
export type InsertMqttBrokerCredential = typeof mqttBrokerCredentials.$inferInsert;

// Re-export all next-gen VPP schema tables for migrations
export * from './nextgen-vpp-schema';

// Re-export innovation schema tables for migrations (2026-08-11 wave)
export * from './innovations-schema';
export * from './grid-intel-schema';
export * from './trust-access-schema';
