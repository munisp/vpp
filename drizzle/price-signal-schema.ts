/**
 * Price-signal dispatch: co-optimising the grid objective and the customer's.
 *
 * A setpoint pushed down a wire assumes the aggregator knows the customer's
 * constraints. A price does not: the aggregator publishes what an interval is
 * worth, each site plans against its own load, assets and comfort, and the
 * aggregator learns what the fleet intends by aggregating the plans back up.
 * The signal, the plan each site returned, and what each site actually did are
 * stored separately here, because they are three different facts and only the
 * third one is evidence.
 *
 * A published signal is not a control: it carries no validity window and no
 * fallback, and following it is voluntary. Anything that must happen goes
 * through the bounded control path in control-validity.ts instead.
 */

import {
  index,
  integer as int,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

export const priceSignalStatusEnum = pgEnum("price_signal_status", [
  /** Solved and stored, not yet offered to any site. */
  "draft",
  /** Offered to at least one site. */
  "published",
  /** Site responses measured against telemetry. */
  "scored",
  /**
   * The coordination could not reach the grid profile within its iteration
   * budget. Kept, never published: a signal that misses the profile it was
   * built for would move the fleet somewhere nobody asked for.
   */
  "not_converged",
]);

/** How a site was told about its signal. Never "the site obeyed". */
export const priceSignalDeliveryEnum = pgEnum("price_signal_delivery", [
  "pending",
  /** Published to the broker. MQTT gives no receipt, so receipt is unproven. */
  "broker_queued",
  "failed",
]);

export const priceSignalResponseEnum = pgEnum("price_signal_response", [
  /** The window has not elapsed, or nothing has been measured yet. */
  "unmeasured",
  /** Telemetry within tolerance of the plan the site returned. */
  "followed",
  /** Telemetry outside tolerance: the site was paid for a plan it did not run. */
  "deviated",
  /** The window elapsed with no telemetry. Not compliance, and not a breach. */
  "no_telemetry",
]);

export const priceSignals = pgTable(
  "price_signals",
  {
    id: serial("id").primaryKey(),

    /** Public identifier; what the site sees and quotes back. */
    signalId: varchar("signal_id", { length: 64 }).notNull().unique(),

    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    scopeId: int("scope_id"),
    region: varchar("region", { length: 50 }),

    status: priceSignalStatusEnum("status").notNull().default("draft"),

    intervalMinutes: int("interval_minutes").notNull(),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),

    /** Solver identity and iteration count: a signal must be reproducible. */
    solver: varchar("solver", { length: 50 }).notNull(),
    iterations: int("iterations").notNull(),
    /**
     * Worst residual between the fleet's aggregated plan and the grid profile,
     * in watts. Zero only when the coordination actually closed the gap.
     */
    maxDeviationWatts: int("max_deviation_watts").notNull(),

    createdBy: int("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    publishedAt: timestamp("published_at"),
    scoredAt: timestamp("scored_at"),
  },
  (table) => ({
    scopeIdx: index("price_signals_scope_idx").on(
      table.scopeType,
      table.scopeId,
    ),
    startsAtIdx: index("price_signals_starts_at_idx").on(table.startsAt),
    statusIdx: index("price_signals_status_idx").on(table.status),
  }),
);

export const priceSignalIntervals = pgTable(
  "price_signal_intervals",
  {
    id: serial("id").primaryKey(),
    signalId: varchar("signal_id", { length: 64 }).notNull(),
    intervalIndex: int("interval_index").notNull(),
    startsAt: timestamp("starts_at").notNull(),

    /** Tariff the fleet would have seen without coordination, cents/kWh * 100. */
    baseImportPriceValue: int("base_import_price_value").notNull(),
    /**
     * Coordination component, cents/kWh * 100 and signed: negative pays sites
     * to absorb energy in an interval the fleet is under the grid's target.
     */
    signalAdjustmentValue: int("signal_adjustment_value").notNull(),

    /** Aggregate net import the grid asked for, watts. */
    targetNetWatts: int("target_net_watts"),
    /** Aggregate net import the fleet's returned plans add up to, watts. */
    plannedNetWatts: int("planned_net_watts").notNull(),
  },
  (table) => ({
    signalIdx: index("price_signal_intervals_signal_idx").on(
      table.signalId,
      table.intervalIndex,
    ),
    signalIndexUnique: unique("price_signal_intervals_signal_index_unique").on(
      table.signalId,
      table.intervalIndex,
    ),
  }),
);

export const priceSignalSites = pgTable(
  "price_signal_sites",
  {
    id: serial("id").primaryKey(),
    signalId: varchar("signal_id", { length: 64 }).notNull(),

    /** Site key as sent to the optimizer, e.g. `user-42`. */
    siteRef: varchar("site_ref", { length: 64 }).notNull(),
    userId: int("user_id"),

    /**
     * The plan the site returned under this signal: per-interval net import in
     * watts. Stored as given, so a later deviation can be attributed.
     */
    plannedNetWatts: jsonb("planned_net_watts").notNull(),
    /** Energy the plan imports over the window, watt-hours (negative = export). */
    plannedNetWh: int("planned_net_wh").notNull(),
    /** What the plan is worth to the site under the signal, in cents. */
    plannedBillCents: int("planned_bill_cents").notNull(),

    delivery: priceSignalDeliveryEnum("delivery").notNull().default("pending"),
    deliveryDetail: varchar("delivery_detail", { length: 255 }),
    deliveredAt: timestamp("delivered_at"),

    response: priceSignalResponseEnum("response").notNull().default("unmeasured"),
    /** Metered net energy over the window, watt-hours. Null when unmeasured. */
    actualNetWh: int("actual_net_wh"),
    /** Telemetry samples the measurement is made of. Zero means no evidence. */
    telemetrySamples: int("telemetry_samples").notNull().default(0),
    scoredAt: timestamp("scored_at"),
  },
  (table) => ({
    signalIdx: index("price_signal_sites_signal_idx").on(table.signalId),
    userIdx: index("price_signal_sites_user_idx").on(table.userId),
    signalSiteUnique: unique("price_signal_sites_signal_site_unique").on(
      table.signalId,
      table.siteRef,
    ),
  }),
);

export type PriceSignal = typeof priceSignals.$inferSelect;
export type InsertPriceSignal = typeof priceSignals.$inferInsert;
export type PriceSignalInterval = typeof priceSignalIntervals.$inferSelect;
export type PriceSignalSite = typeof priceSignalSites.$inferSelect;
