/**
 * Rolling fleet telemetry aggregates.
 *
 * A grid operator buying capacity from an aggregator is buying a number, so the
 * number has to say how much of the fleet it actually saw. Every bucket here
 * records the measured quantities next to their coverage: how many assets were
 * expected in scope, how many reported, and how much rated capacity reported
 * nothing at all. Silence is stored as silence — no asset is ever extrapolated
 * from its neighbours, and an asset with an unknown state of charge contributes
 * no available energy.
 *
 * Energy is integrated from the samples in the bucket, not read off a revenue
 * meter, so it is an estimate of what the fleet did and is named accordingly.
 * Settlement uses the metered energy paths, not this table.
 */

import {
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

export const fleetWindowScopeEnum = pgEnum("fleet_window_scope", [
  /** Every active asset on the platform. */
  "fleet",
  /** Assets of the active members of one energy community. */
  "community",
  /** Assets of the active members of every community in one region. */
  "region",
]);

export const fleetWindowStateEnum = pgEnum("fleet_window_state", [
  /**
   * The bucket's end is still in the future: late-arriving telemetry will
   * change these numbers, so they are not evidence of anything yet.
   */
  "open",
  /** The bucket has elapsed. Recomputed only if telemetry arrives late. */
  "closed",
]);

export const fleetTelemetryWindows = pgTable(
  "fleet_telemetry_windows",
  {
    id: serial("id").primaryKey(),

    scopeType: fleetWindowScopeEnum("scope_type").notNull(),
    /** Canonical scope key: `fleet`, `community:12`, `region:TZ-DAR`. */
    scopeKey: varchar("scope_key", { length: 96 }).notNull(),
    scopeId: int("scope_id"),
    region: varchar("region", { length: 50 }),

    bucketStartsAt: timestamp("bucket_starts_at").notNull(),
    bucketMinutes: int("bucket_minutes").notNull(),
    state: fleetWindowStateEnum("state").default("open").notNull(),

    /**
     * Sum over reporting assets of each asset's mean power in the bucket, in
     * watts. Generation-positive, matching the telemetry table.
     */
    meanNetPowerWatts: int("mean_net_power_watts").notNull(),
    /** Mean power integrated over the bucket, watt-hours. An estimate. */
    integratedEnergyWh: int("integrated_energy_wh").notNull(),

    /** Active assets in scope, whether or not they reported. */
    expectedAssets: int("expected_assets").notNull(),
    /** Assets with at least one sample in the bucket. */
    reportingAssets: int("reporting_assets").notNull(),
    /** Expected minus reporting. Never folded into the measured totals. */
    silentAssets: int("silent_assets").notNull(),
    /** Telemetry rows behind the measured quantities. */
    samples: int("samples").notNull(),

    /** Rated capacity of the reporting assets, watt-hours. */
    reportingCapacityWh: int("reporting_capacity_wh").notNull(),
    /** Rated capacity that reported nothing: the size of the blind spot. */
    silentCapacityWh: int("silent_capacity_wh").notNull(),

    /** Batteries whose last sample in the bucket carried a state of charge. */
    socKnownAssets: int("soc_known_assets").notNull(),
    /** Batteries with no state of charge. Contribute no available energy. */
    socUnknownAssets: int("soc_unknown_assets").notNull(),
    /** Stored energy from known states of charge only, watt-hours. */
    availableEnergyWh: int("available_energy_wh").notNull(),

    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  table => ({
    scopeBucketUnique: unique("fleet_telemetry_windows_scope_bucket_unique").on(
      table.scopeKey,
      table.bucketStartsAt,
      table.bucketMinutes
    ),
    scopeIdx: index("fleet_telemetry_windows_scope_idx").on(table.scopeKey, table.bucketStartsAt),
    stateIdx: index("fleet_telemetry_windows_state_idx").on(table.state),
  })
);

export type FleetTelemetryWindow = typeof fleetTelemetryWindows.$inferSelect;
export type InsertFleetTelemetryWindow = typeof fleetTelemetryWindows.$inferInsert;
