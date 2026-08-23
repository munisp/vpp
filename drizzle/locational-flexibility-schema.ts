/**
 * Locational flexibility as a market product: capacity at a place on the network.
 *
 * A fleet-wide megawatt is worthless to a distribution operator whose constraint
 * is one substation at 18:30. What is bought here is a *located* service, so the
 * defining fact about every offer is how we know the asset is behind that node:
 * `grid_node_assets.link_source` records whether the operator declared it, the
 * utility confirmed it, or nobody has verified it. An unverified link may be
 * stored — it is how a site starts — but it can never be awarded, because
 * selling relief at a feeder the asset is not on is selling nothing.
 *
 * The other fact kept explicit is measurement. Delivery is a reduction against a
 * baseline built from that asset's own telemetry on comparable days; if the
 * baseline has too few real samples, or the asset went silent during the window,
 * the award is `unverified`, which is neither delivery nor a breach. Only
 * verified, measured delivery can be settled, and settlement is a separate,
 * deliberate step.
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

/** Where a node sits in the network. Purely descriptive of the topology. */
export const gridNodeKindEnum = pgEnum("grid_node_kind", [
  "substation",
  "feeder",
  "transformer",
]);

/** How we know an asset is electrically behind a node. */
export const gridNodeLinkSourceEnum = pgEnum("grid_node_link_source", [
  /** A platform operator asserted the connection from site records. */
  "operator_declared",
  /** The network operator confirmed the connection point. */
  "utility_verified",
  /**
   * Claimed but unconfirmed, e.g. self-reported at onboarding. Stored so the
   * claim is visible; never eligible for an award.
   */
  "unverified",
]);

/** What the network needs at the node during the window. */
export const flexibilityDirectionEnum = pgEnum("flexibility_direction", [
  /** Reduce net import (load turn-down or export increase). */
  "import_reduction",
  /** Reduce net export (curtailment or load turn-up). */
  "export_reduction",
]);

export const flexibilityRequirementStatusEnum = pgEnum(
  "flexibility_requirement_status",
  [
    /** Published for offers; the window has not been cleared. */
    "open",
    /** Cleared: awards exist and no further offers are accepted. */
    "cleared",
    /**
     * Cleared with less verified-eligible capacity than requested. Kept
     * distinct from `cleared` so an under-served constraint is never reported
     * as a met one.
     */
    "short",
    /** Withdrawn by the operator before delivery. */
    "cancelled",
    /** Window elapsed and every award has been measured. */
    "settled",
  ]
);

export const flexibilityOfferStatusEnum = pgEnum("flexibility_offer_status", [
  "submitted",
  /** Cleared in merit order, in whole or in part. */
  "awarded",
  /** Not needed at this price once the requirement was filled. */
  "not_awarded",
  /**
   * Excluded from clearing with a stated reason: unverified node link, no
   * usable baseline, offer above the operator's price cap, asset inactive.
   */
  "ineligible",
  "withdrawn",
]);

/** Outcome of measuring an award against telemetry. */
export const flexibilityDeliveryStatusEnum = pgEnum(
  "flexibility_delivery_status",
  [
    /** The window has not elapsed, or measurement has not run. */
    "unmeasured",
    /** Measured reduction at or above the awarded capacity. */
    "delivered",
    /** Measured, but short of the awarded capacity. Paid on what was measured. */
    "partial",
    /** Measured with no reduction against baseline. */
    "not_delivered",
    /**
     * No telemetry in the window, or the baseline lacks real samples. Neither
     * delivery nor breach, and not settleable.
     */
    "unverified",
  ]
);

/**
 * A point on the distribution network with a constraint worth paying to relieve.
 */
export const gridNodes = pgTable(
  "grid_nodes",
  {
    id: serial("id").primaryKey(),
    /** Operator's own identifier for the node, e.g. "TZ-DAR-SS-014/F2". */
    code: varchar("code", { length: 80 }).notNull().unique(),
    name: varchar("name", { length: 200 }).notNull(),
    kind: gridNodeKindEnum("kind").notNull(),
    /** Parent node, so a feeder's offers roll up to its substation. */
    parentNodeId: int("parent_node_id"),
    /** Market region, matching `energy_communities.region` vocabulary. */
    region: varchar("region", { length: 100 }),
    /**
     * Firm capacity of the node, watts, as stated by the network operator.
     * Nullable: many operators will not publish it, and a guessed rating would
     * make headroom figures fiction.
     */
    firmCapacityW: int("firm_capacity_w"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    regionIdx: index("grid_nodes_region_idx").on(table.region),
    parentIdx: index("grid_nodes_parent_idx").on(table.parentNodeId),
  })
);

/** Which assets sit behind a node, and how well that is known. */
export const gridNodeAssets = pgTable(
  "grid_node_assets",
  {
    id: serial("id").primaryKey(),
    nodeId: int("node_id").notNull(),
    assetId: int("asset_id").notNull(),
    linkSource: gridNodeLinkSourceEnum("link_source").notNull(),
    /** Who asserted or confirmed it, for audit. */
    linkedByUserId: int("linked_by_user_id"),
    /** Free-text evidence: meter point reference, utility ticket, survey note. */
    evidence: varchar("evidence", { length: 500 }),
    verifiedAt: timestamp("verified_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    // One asset is behind one node at a time; re-linking updates the row.
    assetUnique: unique("grid_node_assets_asset_unique").on(table.assetId),
    nodeIdx: index("grid_node_assets_node_idx").on(table.nodeId),
  })
);

/** A published need for located flexibility. */
export const flexibilityRequirements = pgTable(
  "flexibility_requirements",
  {
    id: serial("id").primaryKey(),
    nodeId: int("node_id").notNull(),
    direction: flexibilityDirectionEnum("direction").notNull(),
    status: flexibilityRequirementStatusEnum("status").default("open").notNull(),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    /** Capacity the operator needs during the window, watts. */
    requiredPowerW: int("required_power_w").notNull(),
    /** Most the operator will pay, cents per kWh x100 (PRICE_SCALE). */
    priceCapCentsPerKwh: int("price_cap_cents_per_kwh").notNull(),
    currency: varchar("currency", { length: 3 }).default("TZS").notNull(),
    /** Awarded verified-eligible capacity after clearing, watts. */
    clearedPowerW: int("cleared_power_w").default(0).notNull(),
    /** Highest awarded price after clearing, same scale as the cap. */
    clearingPriceCentsPerKwh: int("clearing_price_cents_per_kwh"),
    createdByUserId: int("created_by_user_id").notNull(),
    clearedAt: timestamp("cleared_at"),
    notes: varchar("notes", { length: 500 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    nodeIdx: index("flexibility_requirements_node_idx").on(table.nodeId),
    windowIdx: index("flexibility_requirements_window_idx").on(table.startsAt),
    statusIdx: index("flexibility_requirements_status_idx").on(table.status),
  })
);

/** An offer of capacity from one asset against one requirement. */
export const flexibilityOffers = pgTable(
  "flexibility_offers",
  {
    id: serial("id").primaryKey(),
    requirementId: int("requirement_id").notNull(),
    assetId: int("asset_id").notNull(),
    userId: int("user_id").notNull(),
    status: flexibilityOfferStatusEnum("status").default("submitted").notNull(),
    /** Capacity offered, watts. Capped at clearing by the asset's rating. */
    offeredPowerW: int("offered_power_w").notNull(),
    /** Ask, cents per kWh x100. Offers above the cap are ineligible. */
    priceCentsPerKwh: int("price_cents_per_kwh").notNull(),
    /**
     * Link provenance copied at submission, so an award can be audited against
     * what was known then rather than what the topology says today.
     */
    linkSource: gridNodeLinkSourceEnum("link_source").notNull(),
    /** Why the offer could not be cleared, when status is `ineligible`. */
    ineligibleReason: varchar("ineligible_reason", { length: 300 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    offerUnique: unique("flexibility_offers_asset_unique").on(
      table.requirementId,
      table.assetId
    ),
    requirementIdx: index("flexibility_offers_requirement_idx").on(
      table.requirementId
    ),
    userIdx: index("flexibility_offers_user_idx").on(table.userId),
  })
);

/** A cleared award and, once the window elapses, what was measured. */
export const flexibilityAwards = pgTable(
  "flexibility_awards",
  {
    id: serial("id").primaryKey(),
    requirementId: int("requirement_id").notNull(),
    offerId: int("offer_id").notNull(),
    assetId: int("asset_id").notNull(),
    userId: int("user_id").notNull(),
    /** Awarded capacity, watts; may be a partial fill of the offer. */
    awardedPowerW: int("awarded_power_w").notNull(),
    /** Price the award is paid at, cents per kWh x100. */
    priceCentsPerKwh: int("price_cents_per_kwh").notNull(),
    deliveryStatus: flexibilityDeliveryStatusEnum("delivery_status")
      .default("unmeasured")
      .notNull(),
    /** Baseline mean net power for the window, watts, from the asset's history. */
    baselinePowerW: int("baseline_power_w"),
    /** Real telemetry samples behind the baseline. Zero means no baseline. */
    baselineSamples: int("baseline_samples").default(0).notNull(),
    /** Mean net power measured during the window, watts. */
    measuredPowerW: int("measured_power_w"),
    /** Telemetry samples inside the delivery window. */
    measuredSamples: int("measured_samples").default(0).notNull(),
    /** Measured reduction against baseline, watts; never negative. */
    deliveredPowerW: int("delivered_power_w"),
    /** Energy credited from the measured reduction, watt-hours. */
    deliveredEnergyWh: int("delivered_energy_wh"),
    /** Value of the measured delivery, minor currency units. */
    earnedAmount: int("earned_amount"),
    measuredAt: timestamp("measured_at"),
    /** Settlement event id, set only when verified delivery was settled. */
    settlementEventId: int("settlement_event_id"),
    settledAt: timestamp("settled_at"),
    /** Measurement detail: window bounds, baseline days used, exclusions. */
    measurement: jsonb("measurement"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    awardUnique: unique("flexibility_awards_offer_unique").on(table.offerId),
    requirementIdx: index("flexibility_awards_requirement_idx").on(
      table.requirementId
    ),
    userIdx: index("flexibility_awards_user_idx").on(table.userId),
  })
);

export type GridNode = typeof gridNodes.$inferSelect;
export type GridNodeAsset = typeof gridNodeAssets.$inferSelect;
export type FlexibilityRequirement = typeof flexibilityRequirements.$inferSelect;
export type FlexibilityOffer = typeof flexibilityOffers.$inferSelect;
export type FlexibilityAward = typeof flexibilityAwards.$inferSelect;
