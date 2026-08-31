/**
 * Flexible Load Programs Service
 *
 * Admin-defined programs that enroll a user's own assets for flexible
 * dispatch, linkable to the REAL demand response events table
 * (demandResponseEvents, drizzle/schema.ts — the platform's DR event
 * store; there is no separate "dr_events" table).
 *
 * Honesty rules:
 *  - Enrollment requires the caller to own the asset, and the asset's real
 *    assetType to match the program's declared type.
 *  - Dispatch only ever links enrollments to an existing
 *    demandResponseEvents row whose window satisfies the program's event
 *    window rules. The platform records that it dispatched; it does not
 *    claim the load actually moved.
 *  - incentiveCents is NEVER invented. It stays null unless the program
 *    has a real rate AND a real drResponses.compensation row exists for
 *    that user+event; syncIncentives copies only that recorded amount.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, demandResponseEvents, drResponses } from '../../drizzle/schema';
import {
  flexLoadPrograms,
  flexLoadEnrollments,
  FlexEventWindowRules,
  FlexLoadEnrollment,
  FlexLoadProgram,
} from '../../drizzle/innov3-fieldops-schema';

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error('DATABASE_UNAVAILABLE');
  return db;
}

export interface CreateProgramInput {
  name: string;
  description?: string;
  assetType: FlexLoadProgram['assetType'];
  eventWindowRules?: FlexEventWindowRules;
  /** Null is a first-class value: no negotiated rate, no payouts. */
  incentiveRateCentsPerKwh?: number | null;
}

function validateWindowRules(rules: FlexEventWindowRules | undefined) {
  if (!rules) return;
  const { maxEventsPerDay, windowStartHour, windowEndHour, maxEventMinutes } = rules;
  if (maxEventsPerDay !== undefined && (!Number.isInteger(maxEventsPerDay) || maxEventsPerDay < 1)) {
    throw new Error('INVALID_RULES:maxEventsPerDay');
  }
  for (const [label, h] of [['windowStartHour', windowStartHour], ['windowEndHour', windowEndHour]] as const) {
    if (h !== undefined && (!Number.isInteger(h) || h < 0 || h > 23)) throw new Error(`INVALID_RULES:${label}`);
  }
  if (maxEventMinutes !== undefined && (!Number.isInteger(maxEventMinutes) || maxEventMinutes < 1)) {
    throw new Error('INVALID_RULES:maxEventMinutes');
  }
}

export async function createProgram(actorUserId: number, input: CreateProgramInput): Promise<FlexLoadProgram> {
  const db = await requireDb();
  validateWindowRules(input.eventWindowRules);
  const inserted = await db
    .insert(flexLoadPrograms)
    .values({
      name: input.name,
      description: input.description ?? null,
      createdBy: actorUserId,
      assetType: input.assetType,
      eventWindowRules: input.eventWindowRules ?? null,
      incentiveRateCentsPerKwh: input.incentiveRateCentsPerKwh ?? null,
    })
    .returning();
  return inserted[0];
}

export async function setProgramStatus(
  programId: number,
  status: FlexLoadProgram['status']
): Promise<FlexLoadProgram> {
  const db = await requireDb();
  const [program] = await db.select().from(flexLoadPrograms).where(eq(flexLoadPrograms.id, programId)).limit(1);
  if (!program) throw new Error('PROGRAM_NOT_FOUND');
  const allowed: Record<FlexLoadProgram['status'], Array<FlexLoadProgram['status']>> = {
    draft: ['active'],
    active: ['retired'],
    retired: [],
  };
  if (!allowed[program.status].includes(status)) {
    throw new Error(`INVALID_TRANSITION:${program.status}->${status}`);
  }
  const updated = await db.update(flexLoadPrograms).set({ status }).where(eq(flexLoadPrograms.id, programId)).returning();
  return updated[0];
}

/** Enroll the caller's own asset in an active program. */
export async function enrollAsset(userId: number, programId: number, assetId: number): Promise<FlexLoadEnrollment> {
  const db = await requireDb();
  const [program] = await db.select().from(flexLoadPrograms).where(eq(flexLoadPrograms.id, programId)).limit(1);
  if (!program) throw new Error('PROGRAM_NOT_FOUND');
  if (program.status !== 'active') throw new Error('PROGRAM_NOT_ACTIVE');

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.userId !== userId) throw new Error('ASSET_NOT_OWNED');
  if (asset.assetType !== program.assetType) throw new Error('ASSET_TYPE_MISMATCH');

  const existing = await db
    .select()
    .from(flexLoadEnrollments)
    .where(and(eq(flexLoadEnrollments.programId, programId), eq(flexLoadEnrollments.assetId, assetId)))
    .limit(1);
  if (existing[0]) {
    if (existing[0].status === 'withdrawn') {
      const updated = await db
        .update(flexLoadEnrollments)
        .set({ status: 'active' })
        .where(eq(flexLoadEnrollments.id, existing[0].id))
        .returning();
      return updated[0];
    }
    throw new Error('ALREADY_ENROLLED');
  }

  const inserted = await db
    .insert(flexLoadEnrollments)
    .values({ programId, assetId, userId, status: 'active' })
    .returning();
  return inserted[0];
}

/** Enrollment state machine: active ⇄ suspended, either → withdrawn. */
export async function setEnrollmentStatus(
  userId: number,
  enrollmentId: number,
  status: FlexLoadEnrollment['status']
): Promise<FlexLoadEnrollment> {
  const db = await requireDb();
  const [enrollment] = await db
    .select()
    .from(flexLoadEnrollments)
    .where(eq(flexLoadEnrollments.id, enrollmentId))
    .limit(1);
  if (!enrollment) throw new Error('ENROLLMENT_NOT_FOUND');
  if (enrollment.userId !== userId) throw new Error('FORBIDDEN');
  const allowed: Record<FlexLoadEnrollment['status'], Array<FlexLoadEnrollment['status']>> = {
    active: ['suspended', 'withdrawn'],
    suspended: ['active', 'withdrawn'],
    withdrawn: [],
  };
  if (!allowed[enrollment.status].includes(status)) {
    throw new Error(`INVALID_TRANSITION:${enrollment.status}->${status}`);
  }
  const updated = await db
    .update(flexLoadEnrollments)
    .set({ status })
    .where(eq(flexLoadEnrollments.id, enrollmentId))
    .returning();
  return updated[0];
}

/** Check a real DR event's window against the program's window rules. */
function eventWithinRules(rules: FlexEventWindowRules | null, event: { startTime: Date; endTime: Date }): string | null {
  if (!rules) return null;
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  if (rules.maxEventMinutes !== undefined) {
    const minutes = (end.getTime() - start.getTime()) / 60000;
    if (minutes > rules.maxEventMinutes) {
      return `Event duration ${Math.round(minutes)} min exceeds program max ${rules.maxEventMinutes} min.`;
    }
  }
  if (rules.windowStartHour !== undefined && rules.windowEndHour !== undefined) {
    const h = start.getUTCHours();
    const inWindow = rules.windowStartHour <= rules.windowEndHour
      ? h >= rules.windowStartHour && h < rules.windowEndHour
      : h >= rules.windowStartHour || h < rules.windowEndHour; // overnight window
    if (!inWindow) {
      return `Event starts at UTC hour ${h}, outside the program window [${rules.windowStartHour}, ${rules.windowEndHour}).`;
    }
  }
  return null;
}

/**
 * Dispatch all active enrollments of a program to a REAL
 * demandResponseEvents row. Refuses when the event does not exist or
 * violates the program's window rules. incentiveCents is left untouched
 * (null until syncIncentives finds a real recorded compensation).
 */
export async function dispatchProgramToEvent(
  programId: number,
  drEventId: number
): Promise<{ dispatched: number; skipped: number; eventId: number }> {
  const db = await requireDb();
  const [program] = await db.select().from(flexLoadPrograms).where(eq(flexLoadPrograms.id, programId)).limit(1);
  if (!program) throw new Error('PROGRAM_NOT_FOUND');
  if (program.status !== 'active') throw new Error('PROGRAM_NOT_ACTIVE');

  const [event] = await db
    .select()
    .from(demandResponseEvents)
    .where(eq(demandResponseEvents.id, drEventId))
    .limit(1);
  if (!event) throw new Error('DR_EVENT_NOT_FOUND');

  const ruleViolation = eventWithinRules(program.eventWindowRules, event);
  if (ruleViolation) throw new Error(`EVENT_OUTSIDE_RULES:${ruleViolation}`);

  const activeEnrollments = await db
    .select()
    .from(flexLoadEnrollments)
    .where(and(eq(flexLoadEnrollments.programId, programId), eq(flexLoadEnrollments.status, 'active')));

  const now = new Date();
  for (const enrollment of activeEnrollments) {
    await db
      .update(flexLoadEnrollments)
      .set({ drEventId, dispatchedAt: now })
      .where(eq(flexLoadEnrollments.id, enrollment.id));
  }
  return { dispatched: activeEnrollments.length, skipped: 0, eventId: drEventId };
}

/**
 * Copy REAL recorded compensation from drResponses (per user+event) onto
 * enrollments dispatched to that event. Only rows where the program has a
 * real rate AND a real compensation record exists are updated; everything
 * else keeps incentiveCents null.
 */
export async function syncIncentives(programId: number, drEventId: number): Promise<{ credited: number; stillNull: number }> {
  const db = await requireDb();
  const [program] = await db.select().from(flexLoadPrograms).where(eq(flexLoadPrograms.id, programId)).limit(1);
  if (!program) throw new Error('PROGRAM_NOT_FOUND');

  const enrollments = await db
    .select()
    .from(flexLoadEnrollments)
    .where(and(eq(flexLoadEnrollments.programId, programId), eq(flexLoadEnrollments.drEventId, drEventId)));

  let credited = 0;
  let stillNull = 0;
  const hasRate = program.incentiveRateCentsPerKwh !== null;
  for (const enrollment of enrollments) {
    if (!hasRate) {
      stillNull++;
      continue;
    }
    const [response] = await db
      .select({ compensation: drResponses.compensation })
      .from(drResponses)
      .where(and(eq(drResponses.eventId, drEventId), eq(drResponses.userId, enrollment.userId)))
      .limit(1);
    if (response && response.compensation !== null) {
      await db
        .update(flexLoadEnrollments)
        .set({ incentiveCents: response.compensation })
        .where(eq(flexLoadEnrollments.id, enrollment.id));
      credited++;
    } else {
      stillNull++;
    }
  }
  return { credited, stillNull };
}

export async function listPrograms(includeRetired = false): Promise<FlexLoadProgram[]> {
  const db = await requireDb();
  const where = includeRetired ? undefined : inArray(flexLoadPrograms.status, ['draft', 'active']);
  return db.select().from(flexLoadPrograms).where(where).orderBy(desc(flexLoadPrograms.createdAt));
}

export async function listMyEnrollments(userId: number): Promise<FlexLoadEnrollment[]> {
  const db = await requireDb();
  return db
    .select()
    .from(flexLoadEnrollments)
    .where(eq(flexLoadEnrollments.userId, userId))
    .orderBy(asc(flexLoadEnrollments.id));
}

export async function listProgramEnrollments(programId: number): Promise<FlexLoadEnrollment[]> {
  const db = await requireDb();
  const [program] = await db.select({ id: flexLoadPrograms.id }).from(flexLoadPrograms).where(eq(flexLoadPrograms.id, programId)).limit(1);
  if (!program) throw new Error('PROGRAM_NOT_FOUND');
  return db
    .select()
    .from(flexLoadEnrollments)
    .where(eq(flexLoadEnrollments.programId, programId))
    .orderBy(asc(flexLoadEnrollments.id));
}
