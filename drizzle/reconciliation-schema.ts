import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean } from "drizzle-orm/mysql-core";

/**
 * Payment Reconciliation Records
 * Tracks reconciliation status of payments
 */
export const paymentReconciliations = mysqlTable("payment_reconciliations", {
  id: int("id").autoincrement().primaryKey(),
  paymentId: int("paymentId").notNull(),
  reconciliationDate: timestamp("reconciliationDate").notNull(),
  status: mysqlEnum("status", ["matched", "unmatched", "discrepancy", "manual_review"]).notNull(),
  
  // Gateway data
  gatewayTransactionId: varchar("gatewayTransactionId", { length: 255 }),
  gatewayAmount: int("gatewayAmount"), // Amount reported by gateway (cents)
  gatewayStatus: varchar("gatewayStatus", { length: 50 }),
  gatewayTimestamp: timestamp("gatewayTimestamp"),
  
  // Database data
  dbAmount: int("dbAmount"), // Amount in our database (cents)
  dbStatus: varchar("dbStatus", { length: 50 }),
  dbTimestamp: timestamp("dbTimestamp"),
  
  // Discrepancy details
  amountDifference: int("amountDifference"), // Difference in cents
  statusMismatch: boolean("statusMismatch").default(false),
  timeDifference: int("timeDifference"), // Difference in seconds
  
  // Resolution
  resolvedBy: int("resolvedBy"), // User ID who resolved
  resolvedAt: timestamp("resolvedAt"),
  resolutionNotes: text("resolutionNotes"),
  
  metadata: text("metadata"), // JSON for additional data
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type PaymentReconciliation = typeof paymentReconciliations.$inferSelect;
export type InsertPaymentReconciliation = typeof paymentReconciliations.$inferInsert;

/**
 * Reconciliation Reports
 * Daily/weekly/monthly reconciliation summaries
 */
export const reconciliationReports = mysqlTable("reconciliation_reports", {
  id: int("id").autoincrement().primaryKey(),
  reportDate: timestamp("reportDate").notNull(),
  reportType: mysqlEnum("reportType", ["daily", "weekly", "monthly"]).notNull(),
  
  // Summary statistics
  totalPayments: int("totalPayments").notNull(),
  matchedPayments: int("matchedPayments").notNull(),
  unmatchedPayments: int("unmatchedPayments").notNull(),
  discrepancies: int("discrepancies").notNull(),
  
  // Amount reconciliation
  totalAmount: int("totalAmount").notNull(), // Total expected (cents)
  matchedAmount: int("matchedAmount").notNull(), // Successfully matched (cents)
  discrepancyAmount: int("discrepancyAmount").notNull(), // Total discrepancy (cents)
  
  // Gateway breakdown
  gatewayBreakdown: text("gatewayBreakdown"), // JSON: { gateway: { matched, unmatched, amount } }
  
  // Report generation
  generatedBy: int("generatedBy"), // User ID or system
  generatedAt: timestamp("generatedAt").defaultNow().notNull(),
  
  // File storage
  reportFileUrl: varchar("reportFileUrl", { length: 500 }),
  
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ReconciliationReport = typeof reconciliationReports.$inferSelect;
export type InsertReconciliationReport = typeof reconciliationReports.$inferInsert;

/**
 * Reconciliation Audit Logs
 * Track all reconciliation actions
 */
export const reconciliationAuditLogs = mysqlTable("reconciliation_audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  reconciliationId: int("reconciliationId").notNull(),
  action: mysqlEnum("action", [
    "created",
    "matched",
    "flagged_discrepancy",
    "manual_review",
    "resolved",
    "rejected"
  ]).notNull(),
  performedBy: int("performedBy"), // User ID or null for system
  notes: text("notes"),
  previousStatus: varchar("previousStatus", { length: 50 }),
  newStatus: varchar("newStatus", { length: 50 }),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ReconciliationAuditLog = typeof reconciliationAuditLogs.$inferSelect;
export type InsertReconciliationAuditLog = typeof reconciliationAuditLogs.$inferInsert;
