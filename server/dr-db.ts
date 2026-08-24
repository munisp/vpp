import { eq, and, gte, lte, desc } from "drizzle-orm";
import { getDb } from "./db";
import {
  demandResponseEvents,
  drParticipants,
  drResponses,
  drCompensation,
  InsertDemandResponseEvent,
  InsertDrParticipant,
  InsertDrResponse,
  InsertDrCompensation,
} from "../drizzle/schema";
import { redisCache } from "./services/redis-cache";

// Demand Response Events
export async function createDREvent(event: InsertDemandResponseEvent): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [inserted] = await db
    .insert(demandResponseEvents)
    .values(event)
    .returning({ id: demandResponseEvents.id });
  if (!inserted) {
    throw new Error("Demand response event was not stored");
  }
  return inserted.id;
}

export async function getDREvents(filters?: {
  status?: string;
  startAfter?: Date;
  endBefore?: Date;
}) {
  const db = await getDb();
  if (!db) return [];
  
  let query = db.select().from(demandResponseEvents);
  
  const conditions = [];
  if (filters?.status) {
    conditions.push(eq(demandResponseEvents.status, filters.status as any));
  }
  if (filters?.startAfter) {
    conditions.push(gte(demandResponseEvents.startTime, filters.startAfter));
  }
  if (filters?.endBefore) {
    conditions.push(lte(demandResponseEvents.endTime, filters.endBefore));
  }
  
  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as any;
  }
  
  return await query.orderBy(desc(demandResponseEvents.startTime));
}

export async function getDREventById(eventId: number) {
  // Check cache first
  const cached = await redisCache.getDREvent(eventId);
  if (cached) {
    return cached;
  }
  
  const db = await getDb();
  if (!db) return undefined;  const result = await db.select().from(demandResponseEvents).where(eq(demandResponseEvents.id, eventId)).limit(1);
  const event = result.length > 0 ? result[0] : null;
  
  // Cache the result
  if (event) {
    await redisCache.cacheDREvent(eventId, event);
  }
  
  return event;
}

export async function updateDREventStatus(eventId: number, status: string, actualReduction?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  // Invalidate cache
  await redisCache.invalidateDREvent(eventId);
  
  await db
    .update(demandResponseEvents)
    .set({ status: status as any, actualReduction, updatedAt: new Date() })
    .where(eq(demandResponseEvents.id, eventId));
}

// DR Participants
export async function enrollUserInDR(participant: InsertDrParticipant) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.insert(drParticipants).values(participant);
  return 0; // Return success
}

export async function getDRParticipant(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db
    .select()
    .from(drParticipants)
    .where(eq(drParticipants.userId, userId))
    .limit(1);
  
  return result[0];
}

export async function updateDRParticipant(userId: number, updates: Partial<InsertDrParticipant>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db
    .update(drParticipants)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(drParticipants.userId, userId));
}

export async function getAllDRParticipants(status?: string) {
  const db = await getDb();
  if (!db) return [];
  
  let query = db.select().from(drParticipants);
  
  if (status) {
    query = query.where(eq(drParticipants.status, status as any)) as any;
  }
  
  return await query;
}

// DR Responses
export async function createDRResponse(response: InsertDrResponse) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.insert(drResponses).values(response);
  return 0; // Return success
}

export async function getDRResponses(eventId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db
    .select()
    .from(drResponses)
    .where(eq(drResponses.eventId, eventId));
}

export async function getUserDRResponses(userId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db
    .select()
    .from(drResponses)
    .where(eq(drResponses.userId, userId))
    .orderBy(desc(drResponses.createdAt));
}

export async function updateDRResponse(responseId: number, updates: Partial<InsertDrResponse>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db
    .update(drResponses)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(drResponses.id, responseId));
}

// DR Compensation
export async function createDRCompensation(compensation: InsertDrCompensation) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.insert(drCompensation).values(compensation);
  return 0; // Return success
}

export async function getUserDRCompensation(userId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return await db
    .select()
    .from(drCompensation)
    .where(eq(drCompensation.userId, userId))
    .orderBy(desc(drCompensation.createdAt));
}

export async function updateDRCompensationStatus(
  compensationId: number,
  status: string,
  paymentReference?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const updates: any = { status, updatedAt: new Date() };
  if (paymentReference) {
    updates.paymentReference = paymentReference;
  }
  if (status === "paid") {
    updates.paidAt = new Date();
  }
  
  await db
    .update(drCompensation)
    .set(updates)
    .where(eq(drCompensation.id, compensationId));
}

// Analytics
export async function getDRAnalytics(userId?: number) {
  const db = await getDb();
  if (!db) return null;
  
  // Get total events
  const totalEvents = await db
    .select()
    .from(demandResponseEvents)
    .where(eq(demandResponseEvents.status, "completed"));
  
  // Get user responses if userId provided
  let userResponses: any[] = [];
  if (userId) {
    userResponses = await db
      .select()
      .from(drResponses)
      .where(eq(drResponses.userId, userId));
  }
  
  // Get total compensation
  let totalCompensation = 0;
  if (userId) {
    const compensations = await db
      .select()
      .from(drCompensation)
      .where(and(
        eq(drCompensation.userId, userId),
        eq(drCompensation.status, "paid")
      ));
    
    totalCompensation = compensations.reduce((sum, c) => sum + (c.amount || 0), 0);
  }
  
  return {
    totalEvents: totalEvents.length,
    participationCount: userResponses.length,
    totalCompensation,
    averageReduction: userResponses.length > 0
      ? userResponses.reduce((sum, r) => sum + (r.actualReduction || 0), 0) / userResponses.length
      : 0,
  };
}
