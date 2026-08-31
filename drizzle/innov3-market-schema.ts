/**
 * Innovation wave 3 — market, detection & engagement tables.
 *
 * Five features share this file because they share one rule: every row is
 * derived from, or points at, a real record somewhere else in the platform,
 * and anything the platform cannot know is stored as unknown — never
 * invented.
 *
 *  - `grid_service_revenues`: one row per earning event, always referencing
 *    a real source record (a drCompensation row, a p2p_matches row, or a
 *    referral_rewards row). The (sourceType, sourceId) pair is unique, so a
 *    repeated recording of the same source re-reads the row it already
 *    wrote instead of double-counting the earning. Unknown or mismatched
 *    sources are refused by the service, not recorded.
 *  - `offset_listings` / `offset_transfers`: a user lists a real
 *    carbon_certificates row for sale at their own asking price. A purchase
 *    moves the certificate's ownership by a conditional UPDATE that only
 *    succeeds while the certificate is still in a sellable state; the
 *    transfer row is the receipt of that update, and a listing's `sold`
 *    state is only ever set together with one.
 *  - `inverter_faults`: a detected fault on a real solar/inverter asset.
 *    The evidence (the telemetry window, the device log row, the computed
 *    performance ratio) is stored on the row; a rule whose evidence is too
 *    thin raises nothing.
 *  - `community_challenges` / `challenge_entries`: a creator sets a
 *    consumption-reduction goal against an explicit baseline window.
 *    Progress is computed from real telemetry at read time — nothing is
 *    precomputed here — and a participant whose baseline window has no
 *    readings is shown as unavailable, not as zero.
 *  - `digest_subscriptions` / `digest_runs`: opt-in weekly digests. A run
 *    row is recorded per recipient per week with the real dispatch outcome:
 *    `sent` only after the email/SMS service confirmed acceptance,
 *    otherwise `failed` with the error, or `skipped` with the reason.
 *
 * Integer-scaling conventions follow drizzle/schema.ts and
 * drizzle/prepaid-schema.ts: energy in whole watt-hours, money in whole
 * minor currency units (cents), percentages * 100.
 */

import {
  boolean,
  index,
  integer as int,
  json,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

// ============================================================================
// 11. GRID-SERVICES REVENUE LEDGER
// ============================================================================

/**
 * The real table a revenue row points at. Each source type has a resolver in
 * the service that reads the amount, currency and timestamp from that table;
 * a source type with no resolver cannot be recorded.
 */
export const gridRevenueSourceEnum = pgEnum('grid_service_revenues_source', [
  /** drCompensation row (demand-response event compensation). */
  'dr_compensation',
  /** p2p_matches row where the user was the seller. */
  'p2p_match',
  /** referral_rewards row. */
  'referral_reward',
]);

export const gridServiceRevenues = pgTable(
  'grid_service_revenues',
  {
    id: serial('id').primaryKey(),
    /** The user who earned it; must match the source record's owner. */
    userId: int('userId').notNull(),
    sourceType: gridRevenueSourceEnum('sourceType').notNull(),
    /** Primary key of the row in the source table. */
    sourceId: int('sourceId').notNull(),
    /**
     * Amount in whole minor currency units, copied from the source record at
     * recording time. varchar currency (not the ledger enum) because
     * referral rewards can be denominated in CREDITS.
     */
    amountCents: int('amountCents').notNull(),
    currency: varchar('currency', { length: 8 }).notNull(),
    /** When the earning occurred, taken from the source record. */
    occurredAt: timestamp('occurredAt').notNull(),
    metadata: text('metadata'),
    recordedAt: timestamp('recordedAt').defaultNow().notNull(),
  },
  (t) => ({
    /** One revenue row per source record — recording is idempotent. */
    sourceUq: uniqueIndex('grid_service_revenues_source_uq').on(t.sourceType, t.sourceId),
    userIdx: index('grid_service_revenues_user_idx').on(t.userId),
    occurredIdx: index('grid_service_revenues_occurred_idx').on(t.occurredAt),
  })
);

export type GridServiceRevenue = typeof gridServiceRevenues.$inferSelect;
export type InsertGridServiceRevenue = typeof gridServiceRevenues.$inferInsert;

// ============================================================================
// 12. CARBON OFFSET MARKETPLACE
// ============================================================================

export const offsetListingStatusEnum = pgEnum('offset_listings_status', [
  /** Open for purchase. */
  'active',
  /** Purchased; exactly one offset_transfers row references this listing. */
  'sold',
  /** Withdrawn by the seller before any purchase. */
  'cancelled',
]);

/**
 * A carbon certificate offered for sale. The asking price is the seller's
 * own declaration — it is real because it is their ask, and it is stored in
 * the seller's stated currency. Only one active listing per certificate may
 * exist; the service enforces this inside the listing transaction.
 */
export const offsetListings = pgTable(
  'offset_listings',
  {
    id: serial('id').primaryKey(),
    sellerUserId: int('sellerUserId').notNull(),
    /** The real carbon_certificates row being sold. */
    certificateId: int('certificateId').notNull(),
    askingPriceCents: int('askingPriceCents').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    status: offsetListingStatusEnum('status').default('active').notNull(),
    buyerUserId: int('buyerUserId'),
    soldAt: timestamp('soldAt'),
    cancelledAt: timestamp('cancelledAt'),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => ({
    certIdx: index('offset_listings_cert_idx').on(t.certificateId),
    sellerIdx: index('offset_listings_seller_idx').on(t.sellerUserId),
    statusIdx: index('offset_listings_status_idx').on(t.status),
  })
);

export type OffsetListing = typeof offsetListings.$inferSelect;
export type InsertOffsetListing = typeof offsetListings.$inferInsert;

/**
 * The receipt of an ownership change: written only in the same transaction
 * as the conditional certificate update that actually moved ownership, so a
 * transfer row can never exist for a certificate that did not move.
 */
export const offsetTransfers = pgTable(
  'offset_transfers',
  {
    id: serial('id').primaryKey(),
    /** One transfer per listing. */
    listingId: int('listingId').notNull().unique(),
    certificateId: int('certificateId').notNull(),
    fromUserId: int('fromUserId').notNull(),
    toUserId: int('toUserId').notNull(),
    /** The price actually paid: the listing's asking price at purchase time. */
    priceCents: int('priceCents').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    transferredAt: timestamp('transferredAt').defaultNow().notNull(),
  },
  (t) => ({
    certIdx: index('offset_transfers_cert_idx').on(t.certificateId),
    toIdx: index('offset_transfers_to_idx').on(t.toUserId),
  })
);

export type OffsetTransfer = typeof offsetTransfers.$inferSelect;
export type InsertOffsetTransfer = typeof offsetTransfers.$inferInsert;

// ============================================================================
// 13. SOLAR INVERTER FAULT DETECTOR
// ============================================================================

export const inverterFaultTypeEnum = pgEnum('inverter_faults_type', [
  /** Daylight hours with real telemetry showing no generation while the
   *  clear-sky expectation for the day was positive. */
  'zero_output_daylight',
  /** The inverter's device reported an error through device_logs. */
  'error_code_reported',
  /** Recent performance ratio below the asset's own learned threshold
   *  (server/services/solar-yield.ts). */
  'sustained_underperformance',
]);

export const inverterFaultStatusEnum = pgEnum('inverter_faults_status', [
  'open',
  'acknowledged',
  'resolved',
]);

/**
 * A detected fault. `evidence` carries the exact numbers the rule fired on
 * (sample counts, observed vs expected Wh, device log ids, PR values) so the
 * detection is auditable; detections whose evidence is below the rule's
 * minimum are never inserted.
 */
export const inverterFaults = pgTable(
  'inverter_faults',
  {
    id: serial('id').primaryKey(),
    assetId: int('assetId').notNull(),
    userId: int('userId').notNull(),
    faultType: inverterFaultTypeEnum('faultType').notNull(),
    status: inverterFaultStatusEnum('status').default('open').notNull(),
    detectedAt: timestamp('detectedAt').defaultNow().notNull(),
    evidence: json('evidence').$type<Record<string, unknown>>().notNull(),
    acknowledgedAt: timestamp('acknowledgedAt'),
    resolvedAt: timestamp('resolvedAt'),
    resolutionNote: text('resolutionNote'),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => ({
    assetIdx: index('inverter_faults_asset_idx').on(t.assetId),
    userIdx: index('inverter_faults_user_idx').on(t.userId),
    statusIdx: index('inverter_faults_status_idx').on(t.status),
  })
);

export type InverterFault = typeof inverterFaults.$inferSelect;
export type InsertInverterFault = typeof inverterFaults.$inferInsert;

// ============================================================================
// 14. COMMUNITY CHALLENGES
// ============================================================================

export const challengeMetricEnum = pgEnum('community_challenges_metric', [
  /** Reduce consumption by X% versus the baseline window (percent * 100). */
  'consumption_reduction_pct',
]);

export const challengeStatusEnum = pgEnum('community_challenges_status', [
  /** Created; entries allowed, measurement window not started. */
  'open',
  /** Measurement window has ended; leaderboard is final. */
  'closed',
  /** Withdrawn by its creator; progress is still readable but nothing counts. */
  'cancelled',
]);

export const challengeEntryStatusEnum = pgEnum('challenge_entries_status', [
  'active',
  'withdrawn',
]);

/**
 * A reduction goal with explicit baseline and measurement windows. No
 * progress columns live here: progress is computed from real telemetry per
 * participant at read time, so this row can never disagree with the meters.
 */
export const communityChallenges = pgTable(
  'community_challenges',
  {
    id: serial('id').primaryKey(),
    creatorUserId: int('creatorUserId').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    metric: challengeMetricEnum('metric').notNull(),
    /** Goal in percent * 100 (e.g. 1500 = reduce by 15%). */
    goalPercent100: int('goalPercent100').notNull(),
    /** Baseline window the reduction is measured against. */
    baselineStart: timestamp('baselineStart').notNull(),
    baselineEnd: timestamp('baselineEnd').notNull(),
    /** Measurement window. */
    periodStart: timestamp('periodStart').notNull(),
    periodEnd: timestamp('periodEnd').notNull(),
    status: challengeStatusEnum('status').default('open').notNull(),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => ({
    creatorIdx: index('community_challenges_creator_idx').on(t.creatorUserId),
    statusIdx: index('community_challenges_status_idx').on(t.status),
  })
);

export type CommunityChallenge = typeof communityChallenges.$inferSelect;
export type InsertCommunityChallenge = typeof communityChallenges.$inferInsert;

export const challengeEntries = pgTable(
  'challenge_entries',
  {
    id: serial('id').primaryKey(),
    challengeId: int('challengeId').notNull(),
    userId: int('userId').notNull(),
    status: challengeEntryStatusEnum('status').default('active').notNull(),
    joinedAt: timestamp('joinedAt').defaultNow().notNull(),
    withdrawnAt: timestamp('withdrawnAt'),
  },
  (t) => ({
    membershipUq: uniqueIndex('challenge_entries_membership_uq').on(t.challengeId, t.userId),
    challengeIdx: index('challenge_entries_challenge_idx').on(t.challengeId),
  })
);

export type ChallengeEntry = typeof challengeEntries.$inferSelect;
export type InsertChallengeEntry = typeof challengeEntries.$inferInsert;

// ============================================================================
// 15. WEEKLY DIGEST ENGINE
// ============================================================================

export const digestChannelEnum = pgEnum('digest_subscriptions_channel', [
  'email',
  'sms',
]);

export const digestRunStatusEnum = pgEnum('digest_runs_status', [
  /** The channel service accepted the message. */
  'sent',
  /** The channel service refused or errored; `error` says why. */
  'failed',
  /** Not attempted (missing address/phone, disabled mid-run); `error` says why. */
  'skipped',
]);

export const digestSubscriptions = pgTable(
  'digest_subscriptions',
  {
    id: serial('id').primaryKey(),
    userId: int('userId').notNull(),
    channel: digestChannelEnum('channel').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
    updatedAt: timestamp('updatedAt').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => ({
    userChannelUq: uniqueIndex('digest_subscriptions_user_channel_uq').on(t.userId, t.channel),
  })
);

export type DigestSubscription = typeof digestSubscriptions.$inferSelect;
export type InsertDigestSubscription = typeof digestSubscriptions.$inferInsert;

/**
 * One row per recipient per weekly run: the period covered, the real
 * computed stats that were sent, and the real dispatch outcome. A run is
 * `sent` only when the email/SMS service confirmed; a failure is recorded
 * with its error and never rewritten to `sent` afterwards — the next run is
 * a new row.
 */
export const digestRuns = pgTable(
  'digest_runs',
  {
    id: serial('id').primaryKey(),
    subscriptionId: int('subscriptionId').notNull(),
    userId: int('userId').notNull(),
    channel: digestChannelEnum('channel').notNull(),
    periodStart: timestamp('periodStart').notNull(),
    periodEnd: timestamp('periodEnd').notNull(),
    /** The real weekly stats the digest was compiled from. */
    stats: json('stats').$type<Record<string, unknown>>().notNull(),
    status: digestRunStatusEnum('status').notNull(),
    error: text('error'),
    sentAt: timestamp('sentAt'),
    createdAt: timestamp('createdAt').defaultNow().notNull(),
  },
  (t) => ({
    /** At most one run per subscription per period — reruns skip recipients
     *  already recorded for the same week. */
    periodUq: uniqueIndex('digest_runs_period_uq').on(t.subscriptionId, t.periodStart),
    userIdx: index('digest_runs_user_idx').on(t.userId),
    statusIdx: index('digest_runs_status_idx').on(t.status),
  })
);

export type DigestRun = typeof digestRuns.$inferSelect;
export type InsertDigestRun = typeof digestRuns.$inferInsert;
