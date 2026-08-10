import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Audit Logs table - tracks all admin and critical user actions
 */
export const auditLogs = mysqlTable("audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  
  // Who performed the action
  userId: int("user_id").notNull(),
  userName: varchar("user_name", { length: 255 }),
  userRole: mysqlEnum("user_role", ["user", "admin"]).notNull(),
  
  // What action was performed
  action: mysqlEnum("action", [
    "create",
    "update",
    "delete",
    "approve",
    "reject",
    "suspend",
    "activate",
    "login",
    "logout",
    "payment",
    "trade",
    "export",
    "import",
    "configure"
  ]).notNull(),
  
  // What entity was affected
  entityType: mysqlEnum("entity_type", [
    "user",
    "asset",
    "trade",
    "payment",
    "billing",
    "alert",
    "device",
    "dr_event",
    "market_price",
    "payment_credential",
    "system_config"
  ]).notNull(),
  
  entityId: varchar("entity_id", { length: 255 }), // ID of the affected entity
  entityName: varchar("entity_name", { length: 255 }), // Name/description of the entity
  
  // Details of the change
  changes: text("changes"), // JSON string of before/after values
  description: text("description"), // Human-readable description
  
  // Context
  ipAddress: varchar("ip_address", { length: 45 }), // IPv4 or IPv6
  userAgent: varchar("user_agent", { length: 500 }),
  
  // Status
  status: mysqlEnum("status", ["success", "failure", "pending"]).default("success").notNull(),
  errorMessage: text("error_message"), // If status is failure
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;
