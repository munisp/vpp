import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

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
