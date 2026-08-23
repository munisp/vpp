import {
  boolean,
  decimal,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const mqttBrokerCredentialsIsActiveEnum = pgEnum("mqtt_broker_credentials_is_active", ["true", "false"]);
export const mqttBrokerCredentialsEnvironmentEnum = pgEnum("mqtt_broker_credentials_environment", ["sandbox", "production"]);
export const gridMonitoringGridStatusEnum = pgEnum("grid_monitoring_grid_status", ["normal", "stressed", "critical", "emergency"]);
export const drAutomationRulesIsEnabledEnum = pgEnum("dr_automation_rules_is_enabled", ["true", "false"]);
export const drAutomationRulesOperatorEnum = pgEnum("dr_automation_rules_operator", ["greater_than", "less_than", "equals", "between"]);
export const drAutomationRulesConditionEnum = pgEnum("dr_automation_rules_condition", [
    "load_threshold",
    "price_threshold",
    "grid_frequency",
    "renewable_percentage",
    "time_based"
  ]);
export const drEventTemplatesIsActiveEnum = pgEnum("dr_event_templates_is_active", ["true", "false"]);
export const drEventTemplatesTriggerConditionEnum = pgEnum("dr_event_templates_trigger_condition", [
    "manual",
    "peak_forecast",
    "grid_stress",
    "price_spike",
    "renewable_surplus"
  ]);
export const drEventTemplatesEventTypeEnum = pgEnum("dr_event_templates_event_type", ["peak_shaving", "load_shifting", "emergency", "economic"]);
export const drForecastsRecommendedActionEnum = pgEnum("dr_forecasts_recommended_action", ["none", "monitor", "prepare_event", "trigger_event"]);
export const drForecastsGridStatusEnum = pgEnum("dr_forecasts_grid_status", ["normal", "stressed", "critical"]);
export const paymentGatewayLogsStatusEnum = pgEnum("payment_gateway_logs_status", ["pending", "success", "failed", "timeout"]);
export const paymentGatewayLogsGatewayEnum = pgEnum("payment_gateway_logs_gateway", ["mpesa", "airtel_money", "tigo_pesa"]);
export const paymentCredentialsIsValidatedEnum = pgEnum("payment_credentials_is_validated", ["true", "false"]);
export const paymentCredentialsIsActiveEnum = pgEnum("payment_credentials_is_active", ["true", "false"]);
export const paymentCredentialsEnvironmentEnum = pgEnum("payment_credentials_environment", ["sandbox", "production"]);
export const paymentCredentialsGatewayEnum = pgEnum("payment_credentials_gateway", ["mpesa", "airtel_money", "tigo_pesa"]);
export const drCompensationPaymentMethodEnum = pgEnum("drCompensation_payment_method", ["mpesa", "airtel_money", "tigo_pesa", "bank_transfer"]);
export const drCompensationStatusEnum = pgEnum("drCompensation_status", ["pending", "paid", "failed"]);
export const drCompensationCurrencyEnum = pgEnum("drCompensation_currency", ["NGN", "TZS", "USD"]);
export const drResponsesParticipationStatusEnum = pgEnum("drResponses_participation_status", ["opted_in", "opted_out", "auto_enrolled"]);
export const drParticipantsStatusEnum = pgEnum("drParticipants_status", ["active", "paused", "cancelled"]);
export const demandResponseEventsStatusEnum = pgEnum("demandResponseEvents_status", ["scheduled", "active", "completed", "cancelled"]);
export const demandResponseEventsEventTypeEnum = pgEnum("demandResponseEvents_event_type", ["peak_shaving", "load_shifting", "emergency", "economic"]);
export const deviceLogsEventTypeEnum = pgEnum("device_logs_event_type", ["connected", "disconnected", "error", "warning", "info"]);
export const deviceCommandsStatusEnum = pgEnum("device_commands_status", ["pending", "sent", "acknowledged", "failed"]);
export const devicesStatusEnum = pgEnum("devices_status", ["online", "offline", "error", "maintenance"]);
export const devicesDeviceTypeEnum = pgEnum("devices_device_type", ["smart_meter", "inverter", "battery_controller", "sensor"]);
export const tradingPreferencesTradingModeEnum = pgEnum("tradingPreferences_trading_mode", ["automatic", "manual", "hybrid"]);
export const alertsSeverityEnum = pgEnum("alerts_severity", ["info", "warning", "error", "critical"]);
export const alertsAlertTypeEnum = pgEnum("alerts_alert_type", ["system", "trading", "billing", "maintenance"]);
export const tokensStatusEnum = pgEnum("tokens_status", ["active", "used", "expired", "pending_issuance"]);
export const paymentsStatusEnum = pgEnum("payments_status", ["pending", "completed", "failed", "refunded"]);
export const paymentsPaymentMethodEnum = pgEnum("payments_payment_method", ["mpesa", "airtel_money", "tigo_pesa", "bank_transfer", "card"]);
export const paymentsCurrencyEnum = pgEnum("payments_currency", ["NGN", "TZS", "USD"]);
export const paymentsPaymentTypeEnum = pgEnum("payments_payment_type", ["invoice", "token_purchase", "monthly_fee"]);
export const billingsStatusEnum = pgEnum("billings_status", ["draft", "issued", "paid", "overdue", "cancelled"]);
export const billingsBillingTypeEnum = pgEnum("billings_billing_type", ["postpaid", "prepaid"]);
export const marketPricesPriceTypeEnum = pgEnum("marketPrices_price_type", ["off_peak", "shoulder", "peak", "super_peak"]);
export const marketPricesCountryEnum = pgEnum("marketPrices_country", ["nigeria", "tanzania"]);
export const tradesStatusEnum = pgEnum("trades_status", ["pending", "executed", "cancelled", "failed"]);
export const tradesTradingModeEnum = pgEnum("trades_trading_mode", ["automatic", "manual", "p2p"]);
export const tradesTradeTypeEnum = pgEnum("trades_trade_type", ["export", "import", "p2p_sell", "p2p_buy"]);
export const contractsStatusEnum = pgEnum("contracts_status", ["active", "expired", "cancelled"]);
export const contractsContractTypeEnum = pgEnum("contracts_contract_type", ["asset_aggregation", "full_control", "prepaid"]);
export const assetsApprovalStatusEnum = pgEnum("assets_approval_status", ["pending", "approved", "rejected"]);
export const assetsStatusEnum = pgEnum("assets_status", ["active", "inactive", "maintenance", "fault"]);
export const assetsAssetTypeEnum = pgEnum("assets_asset_type", ["solar", "battery", "meter", "generator", "wind"]);
export const usersLanguageEnum = pgEnum("users_language", ["en", "ha", "yo", "ig", "sw"]);
export const usersCurrencyEnum = pgEnum("users_currency", ["NGN", "TZS", "USD"]);
export const usersCountryEnum = pgEnum("users_country", ["nigeria", "tanzania"]);
export const usersRoleEnum = pgEnum("users_role", ["user", "admin"]);


/**
 * Core user table backing auth flow.
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 20 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: usersRoleEnum("role").default("user").notNull(),
  country: usersCountryEnum("country").default("nigeria").notNull(),
  currency: usersCurrencyEnum("currency").default("NGN").notNull(),
  language: usersLanguageEnum("language").default("en").notNull(),
  timezone: varchar("timezone", { length: 50 }).default("Africa/Lagos").notNull(),
  onboardingCompleted: boolean("onboardingCompleted").default(false).notNull(),
  onboardingStep: int("onboardingStep").default(0).notNull(), // 0=not started, 1-4=steps, 5=completed
  onboardingSkipped: boolean("onboardingSkipped").default(false).notNull(),
  // Data-processing consent, required by the data privacy compliance checks
  consentGiven: boolean("consent_given").default(false).notNull(),
  consentAt: timestamp("consent_at"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Assets table - stores solar panels, batteries, meters, generators
 */
export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  assetType: assetsAssetTypeEnum("assetType").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  capacity: int("capacity").notNull(), // in watts for solar/wind, watt-hours for battery
  make: varchar("make", { length: 255 }),
  model: varchar("model", { length: 255 }),
  serialNumber: varchar("serialNumber", { length: 255 }),
  installationDate: timestamp("installationDate"),
  status: assetsStatusEnum("status").default("active").notNull(),
  approvalStatus: assetsApprovalStatusEnum("approvalStatus").default("pending").notNull(),
  metadata: text("metadata"), // JSON string for additional data
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type Asset = typeof assets.$inferSelect;
export type InsertAsset = typeof assets.$inferInsert;

/**
 * Telemetry table - stores real-time and historical data from assets
 */
export const telemetry = pgTable("telemetry", {
  id: serial("id").primaryKey(),
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
export const contracts = pgTable("contracts", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  contractType: contractsContractTypeEnum("contractType").notNull(),
  revenueSharePercentage: int("revenueSharePercentage").default(70).notNull(), // consumer's share (70%)
  monthlyFee: int("monthlyFee").default(0).notNull(), // in cents
  minimumRevenue: int("minimumRevenue").default(0).notNull(), // minimum guarantee in cents
  startDate: timestamp("startDate").notNull(),
  endDate: timestamp("endDate"),
  status: contractsStatusEnum("status").default("active").notNull(),
  signedAt: timestamp("signedAt").defaultNow().notNull(),
  metadata: text("metadata"), // JSON string for contract terms
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type Contract = typeof contracts.$inferSelect;
export type InsertContract = typeof contracts.$inferInsert;

/**
 * Trading table - stores trading transactions and orders
 */
export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  tradeType: tradesTradeTypeEnum("tradeType").notNull(),
  tradingMode: tradesTradingModeEnum("tradingMode").default("automatic").notNull(),
  energy: int("energy").notNull(), // in watt-hours
  price: int("price").notNull(), // in cents per kWh
  totalAmount: int("totalAmount").notNull(), // in cents
  timestamp: timestamp("timestamp").notNull(),
  status: tradesStatusEnum("status").default("pending").notNull(),
  counterpartyId: int("counterpartyId"), // for P2P trades
  metadata: text("metadata"), // JSON string for trade details
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type Trade = typeof trades.$inferSelect;
export type InsertTrade = typeof trades.$inferInsert;

/**
 * Market prices table - stores real-time electricity prices
 */
export const marketPrices = pgTable("marketPrices", {
  id: serial("id").primaryKey(),
  country: marketPricesCountryEnum("country").notNull(),
  priceType: marketPricesPriceTypeEnum("priceType").notNull(),
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
export const billings = pgTable("billings", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  billingType: billingsBillingTypeEnum("billingType").notNull(),
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
  status: billingsStatusEnum("status").default("draft").notNull(),
  paidAt: timestamp("paidAt"),
  paymentMethod: varchar("paymentMethod", { length: 50 }),
  transactionId: varchar("transactionId", { length: 255 }),
  metadata: text("metadata"), // JSON string for billing details
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type Billing = typeof billings.$inferSelect;
export type InsertBilling = typeof billings.$inferInsert;

/**
 * Payments table - stores payment transactions
 */
export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  billingId: int("billingId"),
  paymentType: paymentsPaymentTypeEnum("paymentType").notNull(),
  amount: int("amount").notNull(), // in cents
  currency: paymentsCurrencyEnum("currency").notNull(),
  paymentMethod: paymentsPaymentMethodEnum("paymentMethod").notNull(),
  phoneNumber: varchar("phoneNumber", { length: 20 }),
  accountNumber: varchar("accountNumber", { length: 100 }),
  transactionId: varchar("transactionId", { length: 255 }),
  status: paymentsStatusEnum("status").default("pending").notNull(),
  metadata: text("metadata"), // JSON string for payment details
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type Payment = typeof payments.$inferSelect;
export type InsertPayment = typeof payments.$inferInsert;

/**
 * Tokens table - stores prepaid electricity tokens
 */
export const tokens = pgTable("tokens", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  paymentId: int("paymentId").notNull(),
  tokenCode: varchar("tokenCode", { length: 50 }).notNull().unique(),
  energyKwh: int("energyKwh").notNull(),
  amount: int("amount").notNull(), // in cents
  validUntil: timestamp("validUntil").notNull(),
  status: tokensStatusEnum("status").default("active").notNull(),
  usedAt: timestamp("usedAt"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type Token = typeof tokens.$inferSelect;
export type InsertToken = typeof tokens.$inferInsert;

/**
 * Alerts table - stores user notifications and system alerts
 */
export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  alertType: alertsAlertTypeEnum("alertType").notNull(),
  severity: alertsSeverityEnum("severity").default("info").notNull(),
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
export const tradingPreferences = pgTable("tradingPreferences", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull().unique(),
  tradingMode: tradingPreferencesTradingModeEnum("tradingMode").default("automatic").notNull(),
  minExportPrice: int("minExportPrice"), // in cents per kWh
  maxImportPrice: int("maxImportPrice"), // in cents per kWh
  minBatteryLevel: int("minBatteryLevel").default(20).notNull(), // percentage * 100
  maxBatteryLevel: int("maxBatteryLevel").default(90).notNull(), // percentage * 100
  enableP2P: boolean("enableP2P").default(false).notNull(),
  enableNotifications: boolean("enableNotifications").default(true).notNull(),
  metadata: text("metadata"), // JSON string for additional preferences
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
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
export const devices = pgTable("devices", {
  id: serial("id").primaryKey(),
  assetId: int("assetId").notNull(), // Links to assets table
  deviceId: varchar("deviceId", { length: 255 }).notNull().unique(), // Unique device identifier (MAC, serial, etc.)
  deviceType: devicesDeviceTypeEnum("deviceType").notNull(),
  manufacturer: varchar("manufacturer", { length: 255 }),
  model: varchar("model", { length: 255 }),
  firmwareVersion: varchar("firmwareVersion", { length: 50 }),
  
  // MQTT Configuration
  mqttClientId: varchar("mqttClientId", { length: 255 }),
  mqttUsername: varchar("mqttUsername", { length: 255 }),
  mqttPasswordHash: text("mqttPasswordHash"), // Hashed password for device authentication
  
  // Status and Health
  status: devicesStatusEnum("status").default("offline").notNull(),
  lastSeen: timestamp("lastSeen"),
  lastMessageAt: timestamp("lastMessageAt"),
  
  // Configuration
  telemetryInterval: int("telemetryInterval").default(5).notNull(), // seconds
  enabled: boolean("enabled").default(true).notNull(),
  
  // Metadata
  metadata: text("metadata"), // JSON string for additional device info
  
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type Device = typeof devices.$inferSelect;
export type InsertDevice = typeof devices.$inferInsert;

/**
 * Device commands - track commands sent to devices
 */
export const deviceCommands = pgTable("device_commands", {
  id: serial("id").primaryKey(),
  deviceId: int("deviceId").notNull(),
  command: varchar("command", { length: 100 }).notNull(),
  payload: text("payload"), // JSON string
  status: deviceCommandsStatusEnum("status").default("pending").notNull(),
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
export const deviceLogs = pgTable("device_logs", {
  id: serial("id").primaryKey(),
  deviceId: int("deviceId").notNull(),
  eventType: deviceLogsEventTypeEnum("eventType").notNull(),
  message: text("message").notNull(),
  metadata: text("metadata"), // JSON string
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DeviceLog = typeof deviceLogs.$inferSelect;
export type InsertDeviceLog = typeof deviceLogs.$inferInsert;

/**
 * Demand Response Events - Grid operator load reduction requests
 */
export const demandResponseEvents = pgTable("demandResponseEvents", {
  id: serial("id").primaryKey(),
  operatorId: int("operatorId").notNull(), // Grid operator/utility company
  eventName: varchar("eventName", { length: 255 }).notNull(),
  eventType: demandResponseEventsEventTypeEnum("eventType").notNull(),
  targetReduction: int("targetReduction").notNull(), // kW to reduce
  startTime: timestamp("startTime").notNull(),
  endTime: timestamp("endTime").notNull(),
  compensationRate: int("compensationRate").notNull(), // cents per kWh reduced
  status: demandResponseEventsStatusEnum("status").default("scheduled").notNull(),
  actualReduction: int("actualReduction"), // Actual kW reduced
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type DemandResponseEvent = typeof demandResponseEvents.$inferSelect;
export type InsertDemandResponseEvent = typeof demandResponseEvents.$inferInsert;

/**
 * DR Participants - Users enrolled in demand response program
 */
export const drParticipants = pgTable("drParticipants", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  enrolledAt: timestamp("enrolledAt").defaultNow().notNull(),
  status: drParticipantsStatusEnum("status").default("active").notNull(),
  autoOptIn: boolean("autoOptIn").default(true).notNull(), // Automatically participate in events
  minCompensation: int("minCompensation"), // Minimum cents/kWh to participate
  maxReduction: int("maxReduction"), // Maximum kW willing to reduce
  notificationPreferences: text("notificationPreferences"), // JSON: email, sms, push
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type DrParticipant = typeof drParticipants.$inferSelect;
export type InsertDrParticipant = typeof drParticipants.$inferInsert;

/**
 * DR Responses - User participation in specific events
 */
export const drResponses = pgTable("drResponses", {
  id: serial("id").primaryKey(),
  eventId: int("eventId").notNull(),
  userId: int("userId").notNull(),
  participationStatus: drResponsesParticipationStatusEnum("participationStatus").notNull(),
  targetReduction: int("targetReduction"), // kW user committed to reduce
  actualReduction: int("actualReduction"), // kW actually reduced
  compensation: int("compensation"), // Total compensation earned (cents)
  responseTime: timestamp("responseTime").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type DrResponse = typeof drResponses.$inferSelect;
export type InsertDrResponse = typeof drResponses.$inferInsert;

/**
 * DR Compensation - Payment tracking for demand response participation
 */
export const drCompensation = pgTable("drCompensation", {
  id: serial("id").primaryKey(),
  userId: int("userId").notNull(),
  eventId: int("eventId").notNull(),
  responseId: int("responseId").notNull(),
  amount: int("amount").notNull(), // cents
  currency: drCompensationCurrencyEnum("currency").notNull(),
  status: drCompensationStatusEnum("status").default("pending").notNull(),
  paymentMethod: drCompensationPaymentMethodEnum("paymentMethod"),
  paymentReference: varchar("paymentReference", { length: 255 }),
  paidAt: timestamp("paidAt"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type DrCompensation = typeof drCompensation.$inferSelect;
export type InsertDrCompensation = typeof drCompensation.$inferInsert;


/**
 * Payment Gateway Credentials
 * Stores encrypted API credentials for payment gateways
 */
export const paymentCredentials = pgTable("payment_credentials", {
  id: serial("id").primaryKey(),
  gateway: paymentCredentialsGatewayEnum("gateway").notNull(),
  environment: paymentCredentialsEnvironmentEnum("environment").notNull().default("sandbox"),
  
  // Encrypted credentials (stored as encrypted JSON)
  credentials: text("credentials").notNull(), // Encrypted JSON blob
  
  // Status and validation
  isActive: paymentCredentialsIsActiveEnum("is_active").notNull().default("false"),
  isValidated: paymentCredentialsIsValidatedEnum("is_validated").notNull().default("false"),
  lastValidated: timestamp("last_validated"),
  validationError: text("validation_error"),
  
  // Metadata
  createdBy: int("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type PaymentCredential = typeof paymentCredentials.$inferSelect;
export type InsertPaymentCredential = typeof paymentCredentials.$inferInsert;

/**
 * Payment Gateway Transactions Log
 * Audit trail for all payment gateway interactions
 */
export const paymentGatewayLogs = pgTable("payment_gateway_logs", {
  id: serial("id").primaryKey(),
  paymentId: int("payment_id"), // Reference to payments table
  gateway: paymentGatewayLogsGatewayEnum("gateway").notNull(),
  
  // Request/Response
  requestType: varchar("request_type", { length: 50 }).notNull(), // STK_PUSH, QUERY, CALLBACK
  requestPayload: text("request_payload"), // JSON
  responsePayload: text("response_payload"), // JSON
  statusCode: int("status_code"),
  
  // Status
  status: paymentGatewayLogsStatusEnum("status").notNull(),
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
export const drForecasts = pgTable("dr_forecasts", {
  id: serial("id").primaryKey(),
  forecastDate: timestamp("forecast_date").notNull(),
  forecastHour: int("forecast_hour").notNull(), // 0-23
  
  // Predictions
  predictedLoad: int("predicted_load").notNull(), // kW
  predictedPeak: int("predicted_peak").notNull(), // kW
  drPotential: int("dr_potential").notNull(), // kW available for reduction
  confidence: int("confidence").notNull(), // 0-100
  
  // Grid conditions
  gridStatus: drForecastsGridStatusEnum("grid_status").notNull(),
  temperature: int("temperature"), // Celsius * 10
  weatherCondition: varchar("weather_condition", { length: 50 }),
  
  // Recommendations
  recommendedAction: drForecastsRecommendedActionEnum("recommended_action").notNull(),
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
export const drEventTemplates = pgTable("dr_event_templates", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  eventType: drEventTemplatesEventTypeEnum("event_type").notNull(),
  
  // Template parameters
  defaultDuration: int("default_duration").notNull(), // minutes
  defaultTargetReduction: int("default_target_reduction").notNull(), // kW
  defaultCompensationRate: int("default_compensation_rate").notNull(), // cents per kWh
  
  // Trigger conditions
  triggerCondition: drEventTemplatesTriggerConditionEnum("trigger_condition").notNull(),
  triggerThreshold: int("trigger_threshold"), // Depends on condition
  
  // Notification settings
  advanceNoticeMinutes: int("advance_notice_minutes").default(60).notNull(),
  notificationChannels: text("notification_channels"), // JSON array
  
  isActive: drEventTemplatesIsActiveEnum("is_active").default("true").notNull(),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type DrEventTemplate = typeof drEventTemplates.$inferSelect;
export type InsertDrEventTemplate = typeof drEventTemplates.$inferInsert;

/**
 * DR Automation Rules
 * Rules for automatic event triggering
 */
export const drAutomationRules = pgTable("dr_automation_rules", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  templateId: int("template_id").notNull(),
  
  // Trigger conditions
  condition: drAutomationRulesConditionEnum("condition").notNull(),
  operator: drAutomationRulesOperatorEnum("operator").notNull(),
  threshold: int("threshold").notNull(),
  thresholdMax: int("threshold_max"), // For "between" operator
  
  // Time constraints
  activeHoursStart: int("active_hours_start"), // 0-23
  activeHoursEnd: int("active_hours_end"), // 0-23
  activeDays: varchar("active_days", { length: 50 }), // JSON array of day numbers
  
  // Cooldown period
  cooldownMinutes: int("cooldown_minutes").default(120).notNull(),
  lastTriggered: timestamp("last_triggered"),
  
  isEnabled: drAutomationRulesIsEnabledEnum("is_enabled").default("true").notNull(),
  priority: int("priority").default(5).notNull(), // 1-10, higher = more important
  
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type DrAutomationRule = typeof drAutomationRules.$inferSelect;
export type InsertDrAutomationRule = typeof drAutomationRules.$inferInsert;

/**
 * Grid Monitoring Data
 * Real-time grid status and metrics
 */
export const gridMonitoring = pgTable("grid_monitoring", {
  id: serial("id").primaryKey(),
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
  gridStatus: gridMonitoringGridStatusEnum("grid_status").notNull(),
  
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
export const mqttBrokerCredentials = pgTable("mqtt_broker_credentials", {
  id: serial("id").primaryKey(),
  environment: mqttBrokerCredentialsEnvironmentEnum("environment").notNull(),
  credentials: text("credentials").notNull(), // JSON string with connection details
  isActive: mqttBrokerCredentialsIsActiveEnum("is_active").default("true").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type MqttBrokerCredential = typeof mqttBrokerCredentials.$inferSelect;
export type InsertMqttBrokerCredential = typeof mqttBrokerCredentials.$inferInsert;

// Re-export all next-gen VPP schema tables for migrations
export * from './nextgen-vpp-schema';

// Re-export innovation schema tables for migrations (2026-08-11 wave)
export * from './innovations-schema';
export * from './grid-intel-schema';
export * from './trust-access-schema';
export * from './grid-protocol-schema';
