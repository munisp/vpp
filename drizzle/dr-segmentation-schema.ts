import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean } from "drizzle-orm/mysql-core";

/**
 * Participant Performance Scores
 * ML-based scoring for DR participants
 */
export const participantScores = mysqlTable("participant_scores", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  
  // Performance metrics
  reliabilityScore: int("reliabilityScore").notNull(), // 0-100
  // Nullable: null when no DR response can be matched to a real event
  // creation timestamp (factor skipped, overall score renormalized).
  responseTimeScore: int("responseTimeScore"), // 0-100
  reductionAccuracyScore: int("reductionAccuracyScore").notNull(), // 0-100
  participationRateScore: int("participationRateScore").notNull(), // 0-100
  
  // Composite score
  overallScore: int("overallScore").notNull(), // Weighted average 0-100
  
  // Historical stats
  totalEventsParticipated: int("totalEventsParticipated").default(0).notNull(),
  totalEventsOptedOut: int("totalEventsOptedOut").default(0).notNull(),
  averageReduction: int("averageReduction"), // kW
  totalCompensationEarned: int("totalCompensationEarned").default(0).notNull(), // cents
  
  // Capacity
  maxCapacity: int("maxCapacity"), // Maximum kW user can reduce
  averageResponseTime: int("averageResponseTime"), // Average seconds to respond
  
  // Segmentation
  segment: mysqlEnum("segment", ["platinum", "gold", "silver", "bronze", "inactive"]).notNull(),
  
  // Last updated
  lastCalculated: timestamp("lastCalculated").defaultNow().notNull(),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ParticipantScore = typeof participantScores.$inferSelect;
export type InsertParticipantScore = typeof participantScores.$inferInsert;

/**
 * Participant Segments
 * Define segment criteria and targeting rules
 */
export const participantSegments = mysqlTable("participant_segments", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  
  // Criteria
  minOverallScore: int("minOverallScore"),
  minReliabilityScore: int("minReliabilityScore"),
  minParticipationRate: int("minParticipationRate"),
  minCapacity: int("minCapacity"), // Minimum kW capacity
  
  // Targeting preferences
  priority: int("priority").default(0).notNull(), // Higher = more important
  compensationMultiplier: int("compensationMultiplier").default(100).notNull(), // Percentage (100 = 1x)
  
  // Active status
  isActive: boolean("isActive").default(true).notNull(),
  
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ParticipantSegment = typeof participantSegments.$inferSelect;
export type InsertParticipantSegment = typeof participantSegments.$inferInsert;

/**
 * Targeted DR Campaigns
 * DR events targeted at specific segments
 */
export const drCampaigns = mysqlTable("dr_campaigns", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  
  // Event details
  eventId: int("eventId"), // Link to actual DR event
  
  // Targeting
  targetSegments: text("targetSegments"), // JSON array of segment IDs
  minScore: int("minScore"), // Minimum overall score
  maxParticipants: int("maxParticipants"), // Limit number of participants
  
  // Incentives
  bonusCompensation: int("bonusCompensation"), // Extra cents/kWh for this campaign
  
  // Status
  status: mysqlEnum("status", ["draft", "scheduled", "active", "completed", "cancelled"]).default("draft").notNull(),
  
  // Timing
  scheduledStart: timestamp("scheduledStart"),
  scheduledEnd: timestamp("scheduledEnd"),
  
  // Results
  participantsInvited: int("participantsInvited").default(0),
  participantsAccepted: int("participantsAccepted").default(0),
  totalReduction: int("totalReduction"), // Total kW reduced
  totalCompensation: int("totalCompensation"), // Total cents paid
  
  createdBy: int("createdBy").notNull(),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DrCampaign = typeof drCampaigns.$inferSelect;
export type InsertDrCampaign = typeof drCampaigns.$inferInsert;
