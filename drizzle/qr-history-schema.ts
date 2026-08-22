import {
  decimal,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const qrCodeHistoryStatusEnum = pgEnum("qr_code_history_status", ["pending", "completed", "failed", "expired"]);
export const qrCodeHistoryPaymentTypeEnum = pgEnum("qr_code_history_payment_type", ["merchant", "p2p", "bill", "token"]);
export const qrCodeHistoryOperationTypeEnum = pgEnum("qr_code_history_operation_type", ["scan", "generate"]);


/**
 * QR Code History table - tracks all QR code scans and generations
 */
export const qrCodeHistory = pgTable("qr_code_history", {
  id: serial("id").primaryKey(),
  userId: int("user_id").notNull(),
  
  // QR code operation type
  operationType: qrCodeHistoryOperationTypeEnum("operation_type").notNull(),
  
  // Payment details
  paymentType: qrCodeHistoryPaymentTypeEnum("payment_type").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 10 }).notNull(),
  
  // Transaction details
  merchantId: varchar("merchant_id", { length: 255 }),
  merchantName: varchar("merchant_name", { length: 255 }),
  recipientId: varchar("recipient_id", { length: 255 }),
  recipientName: varchar("recipient_name", { length: 255 }),
  billId: varchar("bill_id", { length: 255 }),
  billType: varchar("bill_type", { length: 100 }),
  reference: varchar("reference", { length: 255 }),
  description: text("description"),
  
  // QR code data
  qrCodeData: text("qr_code_data").notNull(), // The actual QR code content
  qrCodeImage: text("qr_code_image"), // Base64 image for generated codes
  
  // Status tracking
  status: qrCodeHistoryStatusEnum("status").default("pending").notNull(),
  
  // Timestamps
  scannedAt: timestamp("scanned_at"),
  generatedAt: timestamp("generated_at"),
  completedAt: timestamp("completed_at"),
  expiresAt: timestamp("expires_at"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export type QRCodeHistory = typeof qrCodeHistory.$inferSelect;
export type InsertQRCodeHistory = typeof qrCodeHistory.$inferInsert;
