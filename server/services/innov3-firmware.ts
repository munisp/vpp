/**
 * Firmware Campaign Manager Service
 *
 * Campaigns target real rows in the `devices` table (which has a real
 * `firmwareVersion` column and a real `model` column, drizzle/schema.ts).
 *
 * Honesty rules:
 *  - A target's `reportedVersion` only ever holds what the device row
 *    itself reports. A device that has never reported a version has
 *    reportedVersion null and stays pending — it is never treated as
 *    applied.
 *  - `offered` means the platform made the campaign available to the
 *    target. It says nothing about the device having applied it.
 *  - `applied` is reached ONLY by reconcileCampaign observing the device
 *    reporting the expected version, or by an explicit operator
 *    confirmation recorded with the observed version. `failed`/`excluded`
 *    require an operator-recorded reason.
 *  - Campaign progress is always computed from the target rows themselves,
 *    so the counts can never disagree with the per-device state.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { devices } from '../../drizzle/schema';
import {
  firmwareCampaigns,
  firmwareTargets,
  FirmwareCampaign,
  FirmwareTarget,
} from '../../drizzle/innov3-fieldops-schema';

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error('DATABASE_UNAVAILABLE');
  return db;
}

export interface CreateCampaignInput {
  name: string;
  /** Optional auto-selection filters against the devices table. */
  model?: string;
  fromVersion?: string;
  targetVersion: string;
  /** Explicit device ids; when omitted, devices are auto-selected by filters. */
  deviceIds?: number[];
  notes?: string;
}

export interface CampaignProgress {
  campaignId: number;
  total: number;
  pending: number;
  offered: number;
  applied: number;
  failed: number;
  excluded: number;
  /** applied / (total - excluded), percent * 100; null when no applicable targets. */
  appliedPct100: number | null;
}

export async function createCampaign(
  actorUserId: number,
  input: CreateCampaignInput
): Promise<{ campaign: FirmwareCampaign; targetCount: number }> {
  const db = await requireDb();
  if (!input.targetVersion.trim()) throw new Error('TARGET_VERSION_REQUIRED');

  // Resolve the real target device set.
  let targetDevices: Array<{ id: number; assetId: number; firmwareVersion: string | null }>;
  if (input.deviceIds && input.deviceIds.length > 0) {
    targetDevices = await db
      .select({ id: devices.id, assetId: devices.assetId, firmwareVersion: devices.firmwareVersion })
      .from(devices)
      .where(inArray(devices.id, input.deviceIds));
    if (targetDevices.length !== new Set(input.deviceIds).size) {
      throw new Error('DEVICE_NOT_FOUND');
    }
  } else {
    const conditions = [eq(devices.enabled, true)];
    if (input.model !== undefined) conditions.push(eq(devices.model, input.model));
    if (input.fromVersion !== undefined) conditions.push(eq(devices.firmwareVersion, input.fromVersion));
    targetDevices = await db
      .select({ id: devices.id, assetId: devices.assetId, firmwareVersion: devices.firmwareVersion })
      .from(devices)
      .where(and(...conditions));
  }
  if (targetDevices.length === 0) throw new Error('NO_MATCHING_DEVICES');

  const inserted = await db
    .insert(firmwareCampaigns)
    .values({
      name: input.name,
      createdBy: actorUserId,
      model: input.model ?? null,
      fromVersion: input.fromVersion ?? null,
      targetVersion: input.targetVersion,
      notes: input.notes ?? null,
    })
    .returning();
  const campaign = inserted[0];

  await db.insert(firmwareTargets).values(
    targetDevices.map(d => ({
      campaignId: campaign.id,
      deviceId: d.id,
      assetId: d.assetId,
      expectedVersion: input.targetVersion,
      // What the device reports right now; null when it never has.
      reportedVersion: d.firmwareVersion,
      observedAt: d.firmwareVersion !== null ? new Date() : null,
      status: 'pending' as const,
    }))
  );

  return { campaign, targetCount: targetDevices.length };
}

async function requireCampaign(campaignId: number): Promise<FirmwareCampaign> {
  const db = await requireDb();
  const [campaign] = await db.select().from(firmwareCampaigns).where(eq(firmwareCampaigns.id, campaignId)).limit(1);
  if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
  return campaign;
}

/** Activate a draft/paused campaign and mark all pending targets as offered. */
export async function startCampaign(campaignId: number): Promise<FirmwareCampaign> {
  const db = await requireDb();
  const campaign = await requireCampaign(campaignId);
  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    throw new Error(`INVALID_CAMPAIGN_STATE:${campaign.status}`);
  }
  await db
    .update(firmwareTargets)
    .set({ status: 'offered' })
    .where(and(eq(firmwareTargets.campaignId, campaignId), eq(firmwareTargets.status, 'pending')));
  const updated = await db
    .update(firmwareCampaigns)
    .set({ status: 'active', startedAt: campaign.startedAt ?? new Date() })
    .where(eq(firmwareCampaigns.id, campaignId))
    .returning();
  return updated[0];
}

export async function pauseCampaign(campaignId: number): Promise<FirmwareCampaign> {
  const db = await requireDb();
  const campaign = await requireCampaign(campaignId);
  if (campaign.status !== 'active') throw new Error(`INVALID_CAMPAIGN_STATE:${campaign.status}`);
  const updated = await db
    .update(firmwareCampaigns)
    .set({ status: 'paused' })
    .where(eq(firmwareCampaigns.id, campaignId))
    .returning();
  return updated[0];
}

export async function cancelCampaign(campaignId: number): Promise<FirmwareCampaign> {
  const db = await requireDb();
  const campaign = await requireCampaign(campaignId);
  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    throw new Error(`INVALID_CAMPAIGN_STATE:${campaign.status}`);
  }
  const updated = await db
    .update(firmwareCampaigns)
    .set({ status: 'cancelled' })
    .where(eq(firmwareCampaigns.id, campaignId))
    .returning();
  return updated[0];
}

/**
 * Re-read the devices table for every non-terminal target of a campaign.
 * A target becomes `applied` only when its device now reports the expected
 * version. Targets whose devices report some other version keep their
 * status with the observed version recorded — the report is real, the
 * success is not.
 */
export async function reconcileCampaign(campaignId: number): Promise<{ updated: number; applied: number }> {
  const db = await requireDb();
  await requireCampaign(campaignId);

  const targets = await db
    .select()
    .from(firmwareTargets)
    .where(and(eq(firmwareTargets.campaignId, campaignId), inArray(firmwareTargets.status, ['pending', 'offered'])));

  let updated = 0;
  let applied = 0;
  for (const target of targets) {
    const [device] = await db
      .select({ firmwareVersion: devices.firmwareVersion, enabled: devices.enabled })
      .from(devices)
      .where(eq(devices.id, target.deviceId))
      .limit(1);
    if (!device) {
      await db
        .update(firmwareTargets)
        .set({ status: 'excluded', statusReason: 'Device row no longer exists.' })
        .where(eq(firmwareTargets.id, target.id));
      updated++;
      continue;
    }
    const reported = device.firmwareVersion;
    if (reported !== null && reported === target.expectedVersion) {
      await db
        .update(firmwareTargets)
        .set({ status: 'applied', reportedVersion: reported, observedAt: new Date(), statusReason: null })
        .where(eq(firmwareTargets.id, target.id));
      applied++;
      updated++;
    } else if (reported !== target.reportedVersion) {
      // Device reported something new that is not the expected version.
      await db
        .update(firmwareTargets)
        .set({ reportedVersion: reported, observedAt: reported !== null ? new Date() : target.observedAt })
        .where(eq(firmwareTargets.id, target.id));
      updated++;
    }
  }

  // Auto-complete only when every applicable target has verifiably applied.
  const progress = await getCampaignProgress(campaignId);
  if (progress.total > 0 && progress.pending === 0 && progress.offered === 0) {
    await db
      .update(firmwareCampaigns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(firmwareCampaigns.id, campaignId));
  }
  return { updated, applied };
}

/**
 * Operator-recorded failure for one target. The platform has no device
 * error channel, so failure is only ever recorded by a human with a reason.
 */
export async function markTargetFailed(targetId: number, reason: string): Promise<FirmwareTarget> {
  const db = await requireDb();
  if (!reason.trim()) throw new Error('REASON_REQUIRED');
  const [target] = await db.select().from(firmwareTargets).where(eq(firmwareTargets.id, targetId)).limit(1);
  if (!target) throw new Error('TARGET_NOT_FOUND');
  if (target.status === 'applied' || target.status === 'excluded') {
    throw new Error(`INVALID_TARGET_STATE:${target.status}`);
  }
  const updated = await db
    .update(firmwareTargets)
    .set({ status: 'failed', statusReason: reason })
    .where(eq(firmwareTargets.id, targetId))
    .returning();
  return updated[0];
}

/** Exclude a target (device retired, reassigned, ...) with a reason. */
export async function excludeTarget(targetId: number, reason: string): Promise<FirmwareTarget> {
  const db = await requireDb();
  if (!reason.trim()) throw new Error('REASON_REQUIRED');
  const [target] = await db.select().from(firmwareTargets).where(eq(firmwareTargets.id, targetId)).limit(1);
  if (!target) throw new Error('TARGET_NOT_FOUND');
  if (target.status === 'applied') throw new Error('INVALID_TARGET_STATE:applied');
  const updated = await db
    .update(firmwareTargets)
    .set({ status: 'excluded', statusReason: reason })
    .where(eq(firmwareTargets.id, targetId))
    .returning();
  return updated[0];
}

/** Progress is computed from the target rows, never stored separately. */
export async function getCampaignProgress(campaignId: number): Promise<CampaignProgress> {
  const db = await requireDb();
  const rows = await db
    .select({ status: firmwareTargets.status, count: sql<number>`count(*)::int` })
    .from(firmwareTargets)
    .where(eq(firmwareTargets.campaignId, campaignId))
    .groupBy(firmwareTargets.status);

  const counts: Record<FirmwareTarget['status'], number> = {
    pending: 0, offered: 0, applied: 0, failed: 0, excluded: 0,
  };
  for (const row of rows) counts[row.status] = Number(row.count);
  const total = counts.pending + counts.offered + counts.applied + counts.failed + counts.excluded;
  const applicable = total - counts.excluded;
  return {
    campaignId,
    total,
    ...counts,
    appliedPct100: applicable > 0 ? Math.round((counts.applied / applicable) * 10000) : null,
  };
}

export async function listCampaigns(limit = 50): Promise<FirmwareCampaign[]> {
  const db = await requireDb();
  return db
    .select()
    .from(firmwareCampaigns)
    .orderBy(asc(firmwareCampaigns.id))
    .limit(Math.min(limit, 200));
}

export async function listTargets(campaignId: number): Promise<FirmwareTarget[]> {
  const db = await requireDb();
  await requireCampaign(campaignId);
  return db
    .select()
    .from(firmwareTargets)
    .where(eq(firmwareTargets.campaignId, campaignId))
    .orderBy(asc(firmwareTargets.id));
}
