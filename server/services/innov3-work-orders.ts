/**
 * Maintenance Work Orders Service
 *
 * Asset-linked maintenance orders with a strict status flow
 * (open → assigned → in_progress → done → verified; open/assigned → cancelled)
 * and an append-only, actor-stamped event log.
 *
 * Honesty rules:
 *  - A work order may link to a real grid_anomaly_scores or ntl_flags row,
 *    but the link is validated at creation: the row must exist and be
 *    asset-scoped to the same asset. No dangling references.
 *  - Assignment and verification are staff actions. The users table has only
 *    'user' and 'admin' roles (drizzle/schema.ts users_role enum), so "staff"
 *    here means platform admin — there is no global operator role to check.
 *  - The event log has no update path: history is never rewritten.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, users } from '../../drizzle/schema';
import { gridAnomalyScores } from '../../drizzle/grid-intel-schema';
import { ntlFlags } from '../../drizzle/trust-access-schema';
import {
  workOrders,
  workOrderEvents,
  WorkOrder,
  WorkOrderEvent,
} from '../../drizzle/innov3-fieldops-schema';

export type WorkOrderStatus = WorkOrder['status'];
export type WorkOrderPriority = WorkOrder['priority'];

/** Allowed forward transitions. Terminal states (verified, cancelled) have none. */
const TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  open: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['done'],
  done: ['verified'],
  verified: [],
  cancelled: [],
};

export interface CreateWorkOrderInput {
  assetId: number;
  title: string;
  description?: string;
  priority?: WorkOrderPriority;
  gridAnomalyScoreId?: number;
  ntlFlagId?: number;
  dueAt?: Date;
}

export interface WorkOrderWithEvents {
  order: WorkOrder;
  events: WorkOrderEvent[];
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error('DATABASE_UNAVAILABLE');
  return db;
}

async function requireAsset(assetId: number) {
  const db = await requireDb();
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  return asset;
}

function assertStaff(actorIsAdmin: boolean) {
  if (!actorIsAdmin) throw new Error('STAFF_REQUIRED');
}

function assertTransition(from: WorkOrderStatus, to: WorkOrderStatus) {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`INVALID_TRANSITION:${from}->${to}`);
  }
}

async function logEvent(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  event: {
    workOrderId: number;
    actorUserId: number;
    eventType: WorkOrderEvent['eventType'];
    fromStatus?: WorkOrderStatus | null;
    toStatus?: WorkOrderStatus | null;
    note?: string | null;
  }
) {
  await db.insert(workOrderEvents).values({
    workOrderId: event.workOrderId,
    actorUserId: event.actorUserId,
    eventType: event.eventType,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus ?? null,
    note: event.note ?? null,
  });
}

/**
 * Raise a work order on an asset. The creator must own the asset or be
 * staff. Optional detection links are validated against the real tables.
 */
export async function createWorkOrder(
  actorUserId: number,
  actorIsAdmin: boolean,
  input: CreateWorkOrderInput
): Promise<WorkOrder> {
  const db = await requireDb();
  const asset = await requireAsset(input.assetId);
  if (asset.userId !== actorUserId && !actorIsAdmin) throw new Error('FORBIDDEN');

  if (input.gridAnomalyScoreId !== undefined) {
    const [score] = await db
      .select()
      .from(gridAnomalyScores)
      .where(eq(gridAnomalyScores.id, input.gridAnomalyScoreId))
      .limit(1);
    if (!score) throw new Error('ANOMALY_SCORE_NOT_FOUND');
    if (score.assetId !== input.assetId) throw new Error('ANOMALY_SCORE_ASSET_MISMATCH');
  }
  if (input.ntlFlagId !== undefined) {
    const [flag] = await db.select().from(ntlFlags).where(eq(ntlFlags.id, input.ntlFlagId)).limit(1);
    if (!flag) throw new Error('NTL_FLAG_NOT_FOUND');
    if (flag.assetId !== input.assetId) throw new Error('NTL_FLAG_ASSET_MISMATCH');
  }

  const inserted = await db
    .insert(workOrders)
    .values({
      assetId: input.assetId,
      createdBy: actorUserId,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? 'medium',
      gridAnomalyScoreId: input.gridAnomalyScoreId ?? null,
      ntlFlagId: input.ntlFlagId ?? null,
      dueAt: input.dueAt ?? null,
    })
    .returning();
  const order = inserted[0];

  await logEvent(db, {
    workOrderId: order.id,
    actorUserId,
    eventType: 'created',
    toStatus: 'open',
    note: input.description ?? null,
  });
  return order;
}

/** Assign an open order. Staff only; the assignee must be a real user. */
export async function assignWorkOrder(
  workOrderId: number,
  assigneeUserId: number,
  actorUserId: number,
  actorIsAdmin: boolean
): Promise<WorkOrder> {
  const db = await requireDb();
  assertStaff(actorIsAdmin);

  const [order] = await db.select().from(workOrders).where(eq(workOrders.id, workOrderId)).limit(1);
  if (!order) throw new Error('WORK_ORDER_NOT_FOUND');
  assertTransition(order.status, 'assigned');

  const [assignee] = await db.select({ id: users.id }).from(users).where(eq(users.id, assigneeUserId)).limit(1);
  if (!assignee) throw new Error('ASSIGNEE_NOT_FOUND');

  const updated = await db
    .update(workOrders)
    .set({ status: 'assigned', assignedTo: assigneeUserId })
    .where(eq(workOrders.id, workOrderId))
    .returning();

  await logEvent(db, {
    workOrderId,
    actorUserId,
    eventType: 'assigned',
    fromStatus: order.status,
    toStatus: 'assigned',
    note: `Assigned to user ${assigneeUserId}`,
  });
  return updated[0];
}

/**
 * Move an order forward. in_progress/done may be set by the assignee or
 * staff; verified is staff-only (a second pair of eyes); cancelled is
 * staff or the creator while the order is still open/assigned.
 */
export async function updateWorkOrderStatus(
  workOrderId: number,
  actorUserId: number,
  actorIsAdmin: boolean,
  toStatus: WorkOrderStatus,
  note?: string
): Promise<WorkOrder> {
  const db = await requireDb();
  const [order] = await db.select().from(workOrders).where(eq(workOrders.id, workOrderId)).limit(1);
  if (!order) throw new Error('WORK_ORDER_NOT_FOUND');
  assertTransition(order.status, toStatus);

  const isAssignee = order.assignedTo === actorUserId;
  const isCreator = order.createdBy === actorUserId;
  if (toStatus === 'verified') {
    assertStaff(actorIsAdmin);
  } else if (toStatus === 'cancelled') {
    if (!actorIsAdmin && !isCreator) throw new Error('FORBIDDEN');
  } else if (!actorIsAdmin && !isAssignee) {
    throw new Error('FORBIDDEN');
  }

  const updates: Partial<typeof workOrders.$inferInsert> = { status: toStatus };
  if (toStatus === 'done') updates.completedAt = new Date();
  if (toStatus === 'verified') {
    updates.verifiedAt = new Date();
    updates.verifiedBy = actorUserId;
  }

  const updated = await db.update(workOrders).set(updates).where(eq(workOrders.id, workOrderId)).returning();

  await logEvent(db, {
    workOrderId,
    actorUserId,
    eventType: toStatus === 'verified' ? 'verified' : toStatus === 'cancelled' ? 'cancelled' : 'status_changed',
    fromStatus: order.status,
    toStatus,
    note: note ?? null,
  });
  return updated[0];
}

/** Append an actor-stamped note. Anyone who can see the order may note it. */
export async function addWorkOrderNote(
  workOrderId: number,
  actorUserId: number,
  actorIsAdmin: boolean,
  note: string
): Promise<void> {
  const db = await requireDb();
  const [order] = await db.select().from(workOrders).where(eq(workOrders.id, workOrderId)).limit(1);
  if (!order) throw new Error('WORK_ORDER_NOT_FOUND');
  await assertCanView(order, actorUserId, actorIsAdmin);
  if (!note.trim()) throw new Error('NOTE_REQUIRED');
  await logEvent(db, { workOrderId, actorUserId, eventType: 'note', note });
}

async function assertCanView(order: WorkOrder, actorUserId: number, actorIsAdmin: boolean) {
  if (actorIsAdmin) return;
  if (order.createdBy === actorUserId || order.assignedTo === actorUserId) return;
  const asset = await requireAsset(order.assetId);
  if (asset.userId !== actorUserId) throw new Error('FORBIDDEN');
}

export async function getWorkOrder(
  workOrderId: number,
  actorUserId: number,
  actorIsAdmin: boolean
): Promise<WorkOrderWithEvents> {
  const db = await requireDb();
  const [order] = await db.select().from(workOrders).where(eq(workOrders.id, workOrderId)).limit(1);
  if (!order) throw new Error('WORK_ORDER_NOT_FOUND');
  await assertCanView(order, actorUserId, actorIsAdmin);
  const events = await db
    .select()
    .from(workOrderEvents)
    .where(eq(workOrderEvents.workOrderId, workOrderId))
    .orderBy(asc(workOrderEvents.id));
  return { order, events };
}

/**
 * List orders the caller may see: staff see all; others see orders on
 * their own assets, orders they created, and orders assigned to them.
 */
export async function listWorkOrders(
  actorUserId: number,
  actorIsAdmin: boolean,
  filter: { assetId?: number; status?: WorkOrderStatus; limit?: number } = {}
): Promise<WorkOrder[]> {
  const db = await requireDb();
  const limit = Math.min(filter.limit ?? 50, 200);

  const conditions = [];
  if (filter.assetId !== undefined) {
    if (!actorIsAdmin) {
      const asset = await requireAsset(filter.assetId);
      if (asset.userId !== actorUserId) throw new Error('FORBIDDEN');
    }
    conditions.push(eq(workOrders.assetId, filter.assetId));
  }
  if (filter.status !== undefined) conditions.push(eq(workOrders.status, filter.status));

  if (!actorIsAdmin && filter.assetId === undefined) {
    const owned = await db.select({ id: assets.id }).from(assets).where(eq(assets.userId, actorUserId));
    const ownedIds = owned.map(a => a.id);
    const visible = ownedIds.length > 0
      ? inArray(workOrders.assetId, ownedIds)
      : eq(workOrders.createdBy, actorUserId);
    conditions.push(visible);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(workOrders).where(where).orderBy(desc(workOrders.createdAt)).limit(limit);
}
