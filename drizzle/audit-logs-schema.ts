import {
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const auditLogsStatusEnum = pgEnum("audit_logs_status", ["success", "failure", "pending"]);
export const auditLogsEntityTypeEnum = pgEnum("audit_logs_entity_type", [
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
  ]);
export const auditLogsActionEnum = pgEnum("audit_logs_action", [
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
  ]);
export const auditLogsUserRoleEnum = pgEnum("audit_logs_user_role", ["user", "admin"]);


/**
 * Audit Logs table - tracks all admin and critical user actions
 */
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  
  // Who performed the action
  userId: int("user_id").notNull(),
  userName: varchar("user_name", { length: 255 }),
  userRole: auditLogsUserRoleEnum("user_role").notNull(),
  
  // What action was performed
  action: auditLogsActionEnum("action").notNull(),
  
  // What entity was affected
  entityType: auditLogsEntityTypeEnum("entity_type").notNull(),
  
  entityId: varchar("entity_id", { length: 255 }), // ID of the affected entity
  entityName: varchar("entity_name", { length: 255 }), // Name/description of the entity
  
  // Details of the change
  changes: text("changes"), // JSON string of before/after values
  description: text("description"), // Human-readable description
  
  // Context
  ipAddress: varchar("ip_address", { length: 45 }), // IPv4 or IPv6
  userAgent: varchar("user_agent", { length: 500 }),
  
  // Status
  status: auditLogsStatusEnum("status").default("success").notNull(),
  errorMessage: text("error_message"), // If status is failure
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;
