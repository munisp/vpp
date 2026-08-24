/**
 * The electrical model of the network the platform dispatches into.
 *
 * `grid_nodes` already names the places on the network that flexibility is
 * bought at, and `grid_node_assets` already records which assets sit behind
 * them. What was missing is the electricity: a node had a name, a parent and an
 * optional firm capacity, which is enough to run a market and not nearly enough
 * to answer "will the transformer survive this?". So the node table is extended
 * here rather than duplicated — a node *is* the bus — and only the connections
 * between nodes are new.
 *
 * Every electrical quantity is stored as an integer at a stated scale, matching
 * the rest of the schema, and every one of them is nullable. A node with no
 * nominal voltage is not modelled at zero volts: it makes the network
 * unsolvable, the feasibility service answers `model_unavailable`, and the
 * decision that needed it is labelled network-unchecked. A guessed impedance
 * would instead produce a confident, wrong "feasible".
 *
 * `network_feasibility_studies` keeps every answer given, with the request that
 * produced it and the engine version that solved it, so a dispatch or an award
 * refused on network grounds can be audited later — and so a study that is too
 * old to rely on can be seen to be old.
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
} from 'drizzle-orm/pg-core';

/** What the study was answering, so the record can be found from the decision. */
export const feasibilitySubjectEnum = pgEnum('feasibility_subject', [
  /** A candidate dispatch schedule for a site. */
  'dispatch',
  /** Prospective flexibility awards at clearing. */
  'flexibility_clearing',
  /** A connection or hosting-capacity enquiry with no decision attached. */
  'connection_enquiry',
]);

/**
 * The engine's answer. Mirrors `FeasibilityStatus` in
 * `services/gridmodel/gridmodel/schemas.py`; the two must not drift, and the
 * absence of `feasible`-by-default is the point of the enum.
 */
export const feasibilityStatusEnum = pgEnum('feasibility_status', [
  'feasible',
  'violations',
  /** No solvable electrical model. Never to be read as feasible. */
  'model_unavailable',
  /** The solver ran and did not converge. */
  'not_converged',
  /** The feasibility service itself could not be reached or refused. */
  'service_unavailable',
]);

/**
 * A branch between two nodes.
 *
 * Both ends are `grid_nodes` rows, so the market's node and the model's bus are
 * the same object. A line with no rating cannot be checked for overload, so
 * `max_current_ma` is required: an unrated conductor in the model would make
 * every flow look acceptable.
 */
export const gridNetworkLines = pgTable(
  'grid_network_lines',
  {
    id: serial('id').primaryKey(),
    /** Operator's identifier for the section, e.g. "F2-SEC-03". */
    code: varchar('code', { length: 80 }).notNull().unique(),
    fromNodeId: int('from_node_id').notNull(),
    toNodeId: int('to_node_id').notNull(),
    /** Route length, metres. */
    lengthM: int('length_m').notNull(),
    /** Positive-sequence resistance, milliohms per kilometre. */
    resistanceMohmPerKm: int('resistance_mohm_per_km').notNull(),
    /** Positive-sequence reactance, milliohms per kilometre. */
    reactanceMohmPerKm: int('reactance_mohm_per_km').notNull(),
    /** Shunt capacitance, nanofarads per kilometre. Zero is a valid model. */
    capacitanceNfPerKm: int('capacitance_nf_per_km').default(0).notNull(),
    /** Continuous current rating, milliamps. */
    maxCurrentMa: int('max_current_ma').notNull(),
    /** Circuits in parallel on the same route. */
    parallelCircuits: int('parallel_circuits').default(1).notNull(),
    /** Where the data came from: as-built drawing, survey, utility GIS export. */
    dataSource: varchar('data_source', { length: 200 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    fromIdx: index('grid_network_lines_from_idx').on(table.fromNodeId),
    toIdx: index('grid_network_lines_to_idx').on(table.toNodeId),
  })
);

/**
 * A two-winding transformer between two nodes.
 *
 * This is the element most microgrid awards actually run into, and the one the
 * platform must be able to name when it refuses: "TX1 at 118% of its 250 kVA
 * rating" is actionable, "infeasible" is not.
 */
export const gridNetworkTransformers = pgTable(
  'grid_network_transformers',
  {
    id: serial('id').primaryKey(),
    code: varchar('code', { length: 80 }).notNull().unique(),
    hvNodeId: int('hv_node_id').notNull(),
    lvNodeId: int('lv_node_id').notNull(),
    /** Nameplate rating, kVA. */
    ratedKva: int('rated_kva').notNull(),
    /** HV winding rated voltage, volts. */
    hvVolts: int('hv_volts').notNull(),
    /** LV winding rated voltage, volts. */
    lvVolts: int('lv_volts').notNull(),
    /** Short-circuit voltage, percent x100 (e.g. 4.00% is 400). */
    shortCircuitPercentX100: int('short_circuit_percent_x100').notNull(),
    /** Real part of the short-circuit voltage, percent x100. */
    shortCircuitResistivePercentX100: int('short_circuit_resistive_percent_x100')
      .default(0)
      .notNull(),
    /** Iron losses, watts. */
    ironLossW: int('iron_loss_w').default(0).notNull(),
    /** Open-loop (magnetising) current, percent x100. */
    openLoopCurrentPercentX100: int('open_loop_current_percent_x100').default(0).notNull(),
    dataSource: varchar('data_source', { length: 200 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    hvIdx: index('grid_network_transformers_hv_idx').on(table.hvNodeId),
    lvIdx: index('grid_network_transformers_lv_idx').on(table.lvNodeId),
    pairUnique: unique('grid_network_transformers_pair_unique').on(
      table.hvNodeId,
      table.lvNodeId
    ),
  })
);

/**
 * One answer from the feasibility engine, kept as evidence.
 *
 * `request` and `response` are stored whole. A refusal that cost somebody an
 * award has to be reproducible, and "the model said no" is not evidence unless
 * the model it said no to is still there.
 */
export const networkFeasibilityStudies = pgTable(
  'network_feasibility_studies',
  {
    id: serial('id').primaryKey(),
    subject: feasibilitySubjectEnum('subject').notNull(),
    /** Decision this study was run for: requirement id, site id, enquiry ref. */
    subjectReference: varchar('subject_reference', { length: 120 }),
    /** Root node of the modelled network, when the study was scoped to one. */
    nodeId: int('node_id'),
    status: feasibilityStatusEnum('status').notNull(),
    /** Why the model or the service could not answer. Shown verbatim. */
    reason: varchar('reason', { length: 500 }),
    /** Engine that solved it, e.g. "pandapower 3.5.4". Null when none did. */
    engine: varchar('engine', { length: 80 }),
    buses: int('buses').default(0).notNull(),
    violationCount: int('violation_count').default(0).notNull(),
    /** Worst element found, named. Null when nothing was violated. */
    limitingElement: varchar('limiting_element', { length: 80 }),
    request: jsonb('request').notNull(),
    response: jsonb('response'),
    requestedByUserId: int('requested_by_user_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  table => ({
    subjectIdx: index('network_feasibility_studies_subject_idx').on(
      table.subject,
      table.subjectReference
    ),
    nodeIdx: index('network_feasibility_studies_node_idx').on(table.nodeId),
    createdIdx: index('network_feasibility_studies_created_idx').on(table.createdAt),
  })
);

export type GridNetworkLine = typeof gridNetworkLines.$inferSelect;
export type GridNetworkTransformer = typeof gridNetworkTransformers.$inferSelect;
export type NetworkFeasibilityStudy = typeof networkFeasibilityStudies.$inferSelect;
