import { int, mysqlTable, text, timestamp, varchar, mysqlEnum } from "drizzle-orm/mysql-core";

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
