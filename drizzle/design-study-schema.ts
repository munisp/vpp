/**
 * Techno-economic design studies: sizing a site that does not exist yet.
 *
 * A study is a question asked of the optimizer ("what should this site be built
 * from?") and the answer is only worth anything with the inputs frozen beside
 * it. The load profile, the resource series, the diesel price and every capex
 * assumption are stored whole in `request`, because a recommendation of "40 kW
 * PV, 80 kWh storage, payback 4.2 years" is a claim about a set of assumptions
 * and is unauditable — and, worse, unfalsifiable — without them.
 *
 * Studies are versioned, never updated. Re-running with a dearer diesel price
 * gives a new version; the old one keeps saying what it said. `input_digest` is
 * the digest of the canonical request, so two versions with the same digest and
 * different outputs would be a bug in the engine rather than a business change,
 * and the pair can be found.
 *
 * Money and energy are integers at stated scales, as elsewhere in the schema.
 * Every recommendation figure is nullable: a study that served no energy has no
 * LCOE, and a study with no positive saving against its baseline has no payback.
 * Zero would read as free power and as instant payback respectively.
 */

import {
  bigint,
  index,
  integer as int,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

import { feasibilityStatusEnum } from './network-model-schema';

/**
 * Where a submitted profile came from. Mirrors `ProfileSource` in
 * `services/optimizer/optimizer/design_schemas.py`.
 *
 * `synthetic` is a first-class answer rather than a hidden default: a site with
 * no meter can still be studied, but the output has to say the load was invented
 * and no study may substitute one silently.
 */
export const profileSourceEnum = pgEnum('profile_source', [
  /** Measured by a meter the platform reads. */
  'metered',
  /** Stated by the developer, agency or community. */
  'declared',
  /** From a named external dataset, e.g. NASA POWER. */
  'sourced',
  /** Generated. Labelled everywhere it is reported. */
  'synthetic',
]);

/** What the study concluded. */
export const designStudyStatusEnum = pgEnum('design_study_status', [
  /** A candidate met the stated tolerance for unserved energy. */
  'optimal',
  /** The sweep was searched and nothing met the tolerance. No recommendation. */
  'no_feasible_candidate',
  /** The optimizer could not be reached. Nothing was sized. */
  'service_unavailable',
  /** The platform refused to ask: an input was missing or unusable. */
  'refused',
]);

/**
 * A site under study. Named once; sized repeatedly.
 *
 * `node_id` links a study to the network model when the site is being added to
 * a feeder the platform knows, which is what lets a recommendation be checked
 * against the wires rather than only against the money.
 */
export const designStudies = pgTable(
  'design_studies',
  {
    id: serial('id').primaryKey(),
    /** Stable reference for the project, e.g. "MG-KADUNA-04". */
    reference: varchar('reference', { length: 120 }).notNull().unique(),
    siteName: varchar('site_name', { length: 200 }).notNull(),
    /** Grid node the site would connect at, when it is a modelled one. */
    nodeId: int('node_id'),
    notes: varchar('notes', { length: 500 }),
    createdByUserId: int('created_by_user_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    nodeIdx: index('design_studies_node_idx').on(table.nodeId),
  })
);

/** One run of one site's study, with its inputs frozen. */
export const designStudyVersions = pgTable(
  'design_study_versions',
  {
    id: serial('id').primaryKey(),
    studyId: int('study_id').notNull(),
    /** 1, 2, 3 … in the order they were run for this study. */
    version: int('version').notNull(),
    status: designStudyStatusEnum('status').notNull(),
    /** Why nothing was recommended. Shown verbatim. */
    reason: varchar('reason', { length: 500 }),
    /** SHA-256 of the canonical request: identical inputs, identical digest. */
    inputDigest: varchar('input_digest', { length: 64 }).notNull(),
    /** The whole frozen assumption set as sent to the optimizer. */
    request: jsonb('request').notNull(),
    /** The whole answer, including every candidate that lost. */
    response: jsonb('response'),

    /** Provenance of the load the sizing was driven by. */
    loadSource: profileSourceEnum('load_source').notNull(),
    loadReference: varchar('load_reference', { length: 200 }),

    /** Recommended sizing. Null unless a candidate met the tolerance. */
    recommendedPvW: int('recommended_pv_w'),
    recommendedWindW: int('recommended_wind_w'),
    recommendedBatteryWh: int('recommended_battery_wh'),
    recommendedBatteryW: int('recommended_battery_w'),
    /** Unserved share of annual demand, parts per million. */
    unmetPpm: int('unmet_ppm'),
    /** Levelised cost, cents per kWh x100. Null when nothing was served. */
    lcoeCentsPerKwhX100: int('lcoe_cents_per_kwh_x100'),
    /** Simple payback against the baseline, months. Null when there is no saving. */
    paybackMonths: int('payback_months'),
    capexCents: bigint('capex_cents', { mode: 'number' }),
    /** Litres of fuel the recommendation displaces per year. Null for a grid baseline. */
    fuelLitresSavedPerYear: int('fuel_litres_saved_per_year'),
    /** kg CO2e displaced per year. Null when no emissions intensity was given. */
    emissionsKgSavedPerYear: int('emissions_kg_saved_per_year'),

    /**
     * The network study run against the recommendation, when there was one.
     * Null means the wires were not checked — never that they were found fine.
     */
    networkStudyId: int('network_study_id'),
    networkStatus: feasibilityStatusEnum('network_status'),

    createdByUserId: int('created_by_user_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  table => ({
    studyVersionUnique: unique('design_study_versions_study_version_unique').on(
      table.studyId,
      table.version
    ),
    digestIdx: index('design_study_versions_digest_idx').on(table.inputDigest),
    createdIdx: index('design_study_versions_created_idx').on(table.createdAt),
  })
);

export type DesignStudy = typeof designStudies.$inferSelect;
export type DesignStudyVersion = typeof designStudyVersions.$inferSelect;
