import {
  index,
  integer as int,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Push Subscriptions table - stores Web Push notification subscriptions
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: int("user_id").notNull(),

    // Push subscription details
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(), // Public key
    auth: text("auth").notNull(), // Auth secret
    expirationTime: timestamp("expiration_time"),

    // Device information
    userAgent: text("user_agent"),
    deviceType: varchar("device_type", { length: 50 }), // mobile, tablet, desktop

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  table => ({
    // A browser endpoint identifies one subscription, so re-subscribing must
    // replace the stored keys rather than accumulate rows.
    uniqueEndpoint: unique("push_subscription_endpoint").on(table.endpoint),
    userIdx: index("push_subscription_user_idx").on(table.userId),
  })
);

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = typeof pushSubscriptions.$inferInsert;
