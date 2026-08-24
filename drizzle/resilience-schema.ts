/**
 * Microgrid resilience tables.
 *
 * "How long can this site run on its own, and what stays on while it does?" is
 * the question a clinic, a water pump or a school asks before it accepts a
 * mini-grid. The platform used to answer it from assumptions: island autonomy
 * was computed as the community's shared power rating multiplied by two ("assume
 * a 2-hour battery"), and critical loads were reported as served whenever
 * generation happened to exceed half of the measured load. Both produce a
 * plausible number for a site nobody has surveyed, which is exactly the kind of
 * answer that gets a freezer full of vaccines lost.
 *
 * `critical_loads` is the register that replaces the assumption. A load is only
 * critical because somebody declared it so, with a rated power, a priority and
 * an autonomy target, and the declaration is attributable. Nothing infers a
 * critical load from an asset type.
 *
 * Storage energy is deliberately NOT duplicated here: `assets.capacity` already
 * holds watt-hours for batteries (the same column the fleet aggregates read),
 * and `der_capabilities.min_soc` / `max_power_export` already hold the usable
 * floor and the discharge limit. Resilience reads those, and reports the ones
 * that are missing rather than substituting a default for them.
 */

import {
  boolean,
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * What the load is for. Categories exist so a report can say which public
 * services survive an outage, not merely how many kilowatts do.
 */
export const criticalLoadCategoryEnum = pgEnum('critical_load_category', [
  'health',
  'water',
  'education',
  'communications',
  'security',
  'cold_chain',
  'agriculture',
  'residential',
  'commercial',
  'other',
]);

/**
 * Where the load's power figure comes from. A nameplate rating is a design
 * figure; a metered figure is what the load actually draws. Both are usable,
 * but a reader must be able to tell them apart.
 */
export const criticalLoadRatingSourceEnum = pgEnum('critical_load_rating_source', [
  'nameplate',
  'commissioning_measurement',
  'operator_estimate',
]);

export const criticalLoads = pgTable(
  'critical_loads',
  {
    id: serial('id').primaryKey(),
    communityId: int('community_id').notNull(),
    /**
     * The asset that meters this load, when one exists. Present means the load's
     * demand can be measured; absent means only the declared rating is known,
     * and the assessment says so.
     */
    assetId: int('asset_id'),
    label: varchar('label', { length: 160 }).notNull(),
    category: criticalLoadCategoryEnum('category').notNull(),
    /** 1 is shed last. Priorities need not be unique or contiguous. */
    priority: int('priority').notNull().default(1),
    /** Declared demand in watts. Never derived from an asset's capacity. */
    ratedPowerW: int('rated_power_w').notNull(),
    ratingSource: criticalLoadRatingSourceEnum('rating_source').notNull(),
    /** Hours of supply this load is required to survive without the grid. */
    autonomyTargetHours: int('autonomy_target_hours'),
    active: boolean('active').notNull().default(true),
    /** The user who declared it, so a survey can be traced to its surveyor. */
    declaredBy: int('declared_by').notNull(),
    notes: varchar('notes', { length: 500 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('critical_loads_community_label_key').on(table.communityId, table.label),
    index('critical_loads_community_priority_idx').on(table.communityId, table.priority),
  ]
);

export type CriticalLoadRow = typeof criticalLoads.$inferSelect;
export type InsertCriticalLoad = typeof criticalLoads.$inferInsert;
