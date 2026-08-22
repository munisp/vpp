import {
  boolean,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const reconciliationAuditLogsActionEnum = pgEnum("reconciliation_audit_logs_action", [
    "created",
    "matched",
    "flagged_discrepancy",
    "manual_review",
    "resolved",
    "rejected"
  ]);
export const reconciliationReportsReportTypeEnum = pgEnum("reconciliation_reports_report_type", ["daily", "weekly", "monthly"]);
export const paymentReconciliationsStatusEnum = pgEnum("payment_reconciliations_status", ["matched", "unmatched", "discrepancy", "manual_review"]);


/**
 * Payment Reconciliation Records
 * Tracks reconciliation status of payments
 */
export const paymentReconciliations = pgTable("payment_reconciliations", {
  id: serial("id").primaryKey(),
  paymentId: int("paymentId").notNull(),
  reconciliationDate: timestamp("reconciliationDate").notNull(),
  status: paymentReconciliationsStatusEnum("status").notNull(),
  
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
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type PaymentReconciliation = typeof paymentReconciliations.$inferSelect;
export type InsertPaymentReconciliation = typeof paymentReconciliations.$inferInsert;

/**
 * Reconciliation Reports
 * Daily/weekly/monthly reconciliation summaries
 */
export const reconciliationReports = pgTable("reconciliation_reports", {
  id: serial("id").primaryKey(),
  reportDate: timestamp("reportDate").notNull(),
  reportType: reconciliationReportsReportTypeEnum("reportType").notNull(),
  
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
export const reconciliationAuditLogs = pgTable("reconciliation_audit_logs", {
  id: serial("id").primaryKey(),
  reconciliationId: int("reconciliationId").notNull(),
  action: reconciliationAuditLogsActionEnum("action").notNull(),
  performedBy: int("performedBy"), // User ID or null for system
  notes: text("notes"),
  previousStatus: varchar("previousStatus", { length: 50 }),
  newStatus: varchar("newStatus", { length: 50 }),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ReconciliationAuditLog = typeof reconciliationAuditLogs.$inferSelect;
export type InsertReconciliationAuditLog = typeof reconciliationAuditLogs.$inferInsert;
