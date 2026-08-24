/**
 * Control assignment tables.
 *
 * Every setpoint the platform sends to hardware is bounded in time and has a
 * declared fallback. An asset must never hold an optimizer setpoint forever
 * because the platform went away: the window recorded here is the same window
 * carried in the protocol message (OCPP validFrom/validTo, IEEE 2030.5
 * DERControl interval), so the audit trail and the device agree on when the
 * instruction stops applying.
 */

import {
  check,
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * What an asset should do once a control window closes.
 *
 * `safe_limit` — apply the configured safe limit (a charge point reverts to its
 *   default profile capped at the fallback limit). Correct for grid-facing
 *   control: the asset keeps operating, but never at an optimizer setpoint
 *   nobody is refreshing.
 * `resume_local` — clear our profile entirely and let the device follow its own
 *   local logic (household solar self-consumption, EV user preference).
 * `hold_last` — deliberately keep the last setpoint past its window. Only valid
 *   where an operator has accepted the risk in writing; recorded so an audit can
 *   find it.
 */
export const controlFallbackPolicies = [
  "safe_limit",
  "resume_local",
  "hold_last",
] as const;

export const controlAssignmentsProtocolEnum = pgEnum("control_assignments_protocol", [
  "ocpp16",
  "sep2",
  "openadr",
  "modbus",
  "mqtt",
]);
export const controlAssignmentsSourceEnum = pgEnum("control_assignments_source", [
  "optimizer",
  "v2g_schedule",
  "dr_event",
  "grid_instruction",
  "manual",
  "p2p_trade",
]);
export const controlAssignmentsFallbackPolicyEnum = pgEnum(
  "control_assignments_fallback_policy",
  controlFallbackPolicies
);
/**
 * `broker_queued` is what an MQTT setpoint can honestly claim: the broker took
 * the message at QoS 1, but the device has not answered, and no MQTT device on
 * this platform reports command acknowledgements. It counts as in force — the
 * setpoint will reach the device — while staying distinguishable from a device
 * that actually confirmed.
 */
export const controlAssignmentsDeliveryEnum = pgEnum("control_assignments_delivery", [
  "accepted",
  "broker_queued",
  "rejected",
  "unconfirmed",
]);
/**
 * Whether the wire that carried this control had been shown to work.
 *
 * `proven` means a conformance run over this protocol passed every case inside
 * the deployment's evidence window (see drizzle/conformance-schema.ts).
 * `claimed_unproven` and `suite_failed` mean the platform commanded hardware
 * over an adapter nobody had proved — legitimate during commissioning, but it
 * has to be findable afterwards rather than inferred. `no_suite` is the honest
 * answer for MQTT, which has no vector set here.
 */
export const controlAssignmentsProtocolProofEnum = pgEnum(
  "control_assignments_protocol_proof",
  ["proven", "claimed_unproven", "suite_failed", "proof_stale", "no_suite"]
);
export const controlAssignmentsFallbackOutcomeEnum = pgEnum(
  "control_assignments_fallback_outcome",
  ["applied", "device_offline", "rejected", "unconfirmed", "not_required"]
);
export const controlFallbackEventsReasonEnum = pgEnum("control_fallback_events_reason", [
  "window_expired",
  "superseded",
  "device_offline",
  "operator_revoked",
]);
export const controlFallbackEventsOutcomeEnum = pgEnum("control_fallback_events_outcome", [
  "applied",
  "device_offline",
  "rejected",
  "unconfirmed",
]);

export const controlAssignments = pgTable(
  "control_assignments",
  {
    id: serial("id").primaryKey(),
    protocol: controlAssignmentsProtocolEnum("protocol").notNull(),
    /** Charge point id, 2030.5 LFDI or Modbus device id the command was sent to. */
    targetRef: varchar("target_ref", { length: 191 }).notNull(),
    /** OCPP connector id / Modbus unit id; 0 when the target is the whole device. */
    subTargetRef: int("sub_target_ref").default(0).notNull(),
    /** Protocol-level handle used to revoke the control (OCPP chargingProfileId). */
    commandRef: varchar("command_ref", { length: 128 }),
    assetId: int("asset_id"),
    evId: int("ev_id"),
    userId: int("user_id"),
    source: controlAssignmentsSourceEnum("source").notNull(),
    /** Row in the originating table (v2g_schedules.id, dr_events.id, ...). */
    sourceId: int("source_id"),
    /** Signed watts at the start of the window: negative charges/consumes. */
    setpointWatts: int("setpoint_watts"),
    validFrom: timestamp("valid_from").notNull(),
    validTo: timestamp("valid_to").notNull(),
    fallbackPolicy: controlAssignmentsFallbackPolicyEnum("fallback_policy").notNull(),
    /** Safe signed watts applied by `safe_limit`; null for the other policies. */
    fallbackLimitWatts: int("fallback_limit_watts"),
    /**
     * Delivery outcome as reported by the device, never assumed: `accepted` only
     * when the hardware answered Accepted.
     */
    delivery: controlAssignmentsDeliveryEnum("delivery").notNull(),
    deliveryDetail: text("delivery_detail"),
    /**
     * Proof state of `protocol` when this control was issued, frozen here rather
     * than resolved at read time: proving the adapter next month does not make
     * last month's dispatch proven.
     */
    protocolProof: controlAssignmentsProtocolProofEnum("protocol_proof"),
    /** The passing run the `proven` label rests on. */
    protocolProofRunId: int("protocol_proof_run_id"),
    /** Set when a newer assignment took over the same target before expiry. */
    supersededAt: timestamp("superseded_at"),
    /**
     * Claimed by the sweeper that is about to deliver the fallback. The claim is
     * a conditional update, so two sweepers cannot both command the device or
     * both write a fallback event for the same expiry.
     */
    fallbackClaimedAt: timestamp("fallback_claimed_at"),
    /** Set when the fallback was actually delivered, with the outcome below. */
    fallbackAppliedAt: timestamp("fallback_applied_at"),
    /**
     * `unconfirmed` is distinct from `device_offline`: a command that timed out may
     * or may not have reached the device, and collapsing the two would claim
     * knowledge the platform does not have.
     */
    fallbackOutcome: controlAssignmentsFallbackOutcomeEnum("fallback_outcome"),
    fallbackDetail: text("fallback_detail"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => ({
    targetIdx: index("control_assignments_target_idx").on(
      table.protocol,
      table.targetRef,
      table.validTo
    ),
    assetIdx: index("control_assignments_asset_idx").on(table.assetId),
    expiryIdx: index("control_assignments_expiry_idx").on(table.validTo),
    fallbackClaimIdx: index("control_assignments_fallback_claim_idx").on(
      table.delivery,
      table.validTo,
      table.fallbackClaimedAt
    ),
    boundedWindow: check(
      "control_assignments_bounded_window",
      sql`${table.validTo} > ${table.validFrom}`
    ),
  })
);

export type ControlAssignment = typeof controlAssignments.$inferSelect;
export type InsertControlAssignment = typeof controlAssignments.$inferInsert;

/**
 * Degraded-mode transitions, kept separate from the assignment so that repeated
 * failures to reach a device are all visible rather than overwriting each other.
 */
export const controlFallbackEvents = pgTable(
  "control_fallback_events",
  {
    id: serial("id").primaryKey(),
    assignmentId: int("assignment_id")
      .notNull()
      .references(() => controlAssignments.id, { onDelete: "cascade" }),
    reason: controlFallbackEventsReasonEnum("reason").notNull(),
    outcome: controlFallbackEventsOutcomeEnum("outcome").notNull(),
    detail: text("detail").notNull(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  },
  table => ({
    assignmentIdx: index("control_fallback_events_assignment_idx").on(table.assignmentId),
  })
);

export type ControlFallbackEvent = typeof controlFallbackEvents.$inferSelect;
export type InsertControlFallbackEvent = typeof controlFallbackEvents.$inferInsert;
