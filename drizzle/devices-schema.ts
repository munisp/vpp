/**
 * IoT Device Management Schema
 * 
 * Extended schema for managing IoT devices, authentication, and communication
 */

import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean } from "drizzle-orm/mysql-core";

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
