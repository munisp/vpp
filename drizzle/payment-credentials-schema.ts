import {
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const paymentGatewayLogsStatusEnum = pgEnum("payment_gateway_logs_status", ["pending", "success", "failed", "timeout"]);
export const paymentGatewayLogsGatewayEnum = pgEnum("payment_gateway_logs_gateway", ["mpesa", "airtel_money", "tigo_pesa"]);
export const paymentCredentialsIsValidatedEnum = pgEnum("payment_credentials_is_validated", ["true", "false"]);
export const paymentCredentialsIsActiveEnum = pgEnum("payment_credentials_is_active", ["true", "false"]);
export const paymentCredentialsEnvironmentEnum = pgEnum("payment_credentials_environment", ["sandbox", "production"]);
export const paymentCredentialsGatewayEnum = pgEnum("payment_credentials_gateway", ["mpesa", "airtel_money", "tigo_pesa"]);


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
