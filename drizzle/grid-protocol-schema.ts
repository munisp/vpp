/**
 * Grid protocol tables.
 *
 * These back the protocol services in services/grid-protocols (OCPP 1.6J,
 * OpenADR 2.0b, IEEE 2030.5) and services/modbus-poller. The protocol services
 * hold no business state: they call the platform and the platform decides.
 */

import {
  mysqlTable,
  int,
  varchar,
  timestamp,
  text,
  mysqlEnum,
  index,
  unique,
} from "drizzle-orm/mysql-core";

/**
 * OCPP idTags (RFID cards, app tokens) presented at a charge point.
 *
 * Authorize/StartTransaction decisions are looked up here. An unknown tag is
 * rejected: the central system must never invent an authorization.
 */
export const ocppIdTags = mysqlTable(
  "ocpp_id_tags",
  {
    id: int("id").autoincrement().primaryKey(),
    idTag: varchar("id_tag", { length: 64 }).notNull().unique(),
    userId: int("user_id").notNull(),
    evId: int("ev_id"),
    status: mysqlEnum("status", ["accepted", "blocked", "expired", "invalid"])
      .default("accepted")
      .notNull(),
    expiryDate: timestamp("expiry_date"),
    parentIdTag: varchar("parent_id_tag", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    userIdx: index("ocpp_id_tags_user_idx").on(table.userId),
  })
);

export type OcppIdTag = typeof ocppIdTags.$inferSelect;
export type InsertOcppIdTag = typeof ocppIdTags.$inferInsert;

/**
 * Instructions received from a grid operator over OpenADR 2.0b or IEEE 2030.5,
 * together with the response the platform actually returned.
 *
 * `decision` records what we told the VTN/utility; it is written from the same
 * evaluation that produces the response, so the audit trail cannot claim
 * participation we did not opt into.
 */
export const gridProtocolInstructions = mysqlTable(
  "grid_protocol_instructions",
  {
    id: int("id").autoincrement().primaryKey(),
    source: mysqlEnum("source", ["openadr", "sep2"]).notNull(),
    externalId: varchar("external_id", { length: 128 }).notNull(),
    modificationNumber: int("modification_number").default(0).notNull(),
    programRef: varchar("program_ref", { length: 191 }),
    eventStatus: varchar("event_status", { length: 32 }).notNull(),
    priority: int("priority"),
    startTime: timestamp("start_time").notNull(),
    durationSeconds: int("duration_seconds").notNull(),
    /** Signed watts for absolute setpoints: negative means consume/charge. */
    targetWatts: int("target_watts"),
    /** Percent * 100, as used elsewhere in this schema. */
    targetPercent: int("target_percent"),
    decision: mysqlEnum("decision", ["opt_in", "opt_out", "recorded"]).notNull(),
    decisionReason: text("decision_reason").notNull(),
    payload: text("payload").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
  },
  table => ({
    uniqueRevision: unique("grid_instruction_revision").on(
      table.source,
      table.externalId,
      table.modificationNumber
    ),
    startIdx: index("grid_instruction_start_idx").on(table.startTime),
  })
);

export type GridProtocolInstruction = typeof gridProtocolInstructions.$inferSelect;
export type InsertGridProtocolInstruction = typeof gridProtocolInstructions.$inferInsert;
