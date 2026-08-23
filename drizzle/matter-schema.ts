/**
 * Matter smart-home load tables.
 *
 * These record what a Matter controller (services/grid-protocols, talking to a
 * matter-server fabric) reported: which nodes exist, whether they are reachable,
 * and the last raw value of each attribute. Nothing here is inferred — a node
 * that has never reported a cluster has no capability row, and an attribute the
 * platform cannot interpret is still stored verbatim.
 *
 * Node and fabric ids are 64-bit Matter identifiers stored as decimal strings:
 * they exceed the exact integer range of the runtime that reads them, and
 * rounding two ids together would merge two devices into one row.
 */

import {
  boolean,
  index,
  integer as int,
  jsonb,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * A commissioned Matter node as the controller sees it.
 *
 * `available` is the controller's reachability view, not evidence that a load
 * followed a command. `isTestNode` marks the controller's synthetic nodes, which
 * acknowledge commands no device performs; they are stored so an operator can
 * see them, and refused for dispatch unless the deployment opted in.
 */
export const matterNodes = pgTable(
  'matter_nodes',
  {
    id: serial('id').primaryKey(),
    fabricId: varchar('fabric_id', { length: 20 }).notNull(),
    nodeId: varchar('node_id', { length: 20 }).notNull(),
    available: boolean('available').notNull(),
    isBridge: boolean('is_bridge').default(false).notNull(),
    isTestNode: boolean('is_test_node').default(false).notNull(),
    /** The node's descriptor attributes exactly as the controller reported them. */
    reportedAttributes: jsonb('reported_attributes'),
    /** Set when the controller stops reporting the node; the row is kept for audit. */
    removedAt: timestamp('removed_at'),
    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastReportedAt: timestamp('last_reported_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    fabricNodeUnique: unique('matter_nodes_fabric_node_unique').on(table.fabricId, table.nodeId),
    availableIdx: index('matter_nodes_available_idx').on(table.available),
  })
);

export type MatterNode = typeof matterNodes.$inferSelect;
export type InsertMatterNode = typeof matterNodes.$inferInsert;

/**
 * The last reported value of one Matter attribute, keyed by the controller's
 * "<endpoint>/<cluster>/<attribute>" path.
 *
 * The value is the raw JSON the node produced, including `null`: a null reading
 * means the node has no value to give, which is not the same as zero and must
 * never be settled or aggregated as zero.
 */
export const matterNodeAttributes = pgTable(
  'matter_node_attributes',
  {
    id: serial('id').primaryKey(),
    matterNodeId: int('matter_node_id')
      .notNull()
      .references(() => matterNodes.id, { onDelete: 'cascade' }),
    endpointId: int('endpoint_id').notNull(),
    clusterId: int('cluster_id').notNull(),
    attributeId: int('attribute_id').notNull(),
    attributePath: varchar('attribute_path', { length: 64 }).notNull(),
    value: jsonb('value'),
    reportedAt: timestamp('reported_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    nodePathUnique: unique('matter_node_attributes_node_path_unique').on(
      table.matterNodeId,
      table.attributePath
    ),
    nodeIdx: index('matter_node_attributes_node_idx').on(table.matterNodeId),
  })
);

export type MatterNodeAttribute = typeof matterNodeAttributes.$inferSelect;
export type InsertMatterNodeAttribute = typeof matterNodeAttributes.$inferInsert;
