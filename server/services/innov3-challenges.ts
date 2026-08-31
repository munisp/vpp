/**
 * Community Challenges (innovation 14)
 *
 * A creator sets a goal ("reduce consumption by X% versus a baseline
 * window") and other users join. Nothing about progress is stored: the
 * challenge row holds the goal and the windows, and progress is computed
 * from real telemetry on every read, so the leaderboard can never disagree
 * with the meters.
 *
 * Consumption is measured from the user's meter assets (assets.assetType =
 * 'meter') as the delta of their cumulative energy register over a window.
 * A participant with no meter, or a meter that did not report inside the
 * baseline window, has an unknown baseline: their entry reports
 * progressAvailable:false with the reason. Unknown is never shown as zero
 * — a participant who simply has no data does not "win" a reduction
 * challenge with a fabricated 100% reduction.
 */

import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, telemetry } from '../../drizzle/schema';
import {
  challengeEntries,
  communityChallenges,
  type ChallengeEntry,
  type CommunityChallenge,
} from '../../drizzle/innov3-market-schema';

const MS_PER_DAY = 86400000;

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db;
}

export interface WindowConsumption {
  /** Total Wh consumed in the window; null when unknown. */
  totalWh: number | null;
  /** Meter assets that had usable readings in the window. */
  assetsWithData: number;
  /** Telemetry samples seen in the window. */
  sampleCount: number;
}

/**
 * Real consumption for a user over [start, end), from cumulative meter
 * registers. Returns totalWh null when no meter asset reported at least
 * once in the window — the caller must treat that as "unknown", not zero.
 * Negative register movement (meter resets) removes that asset from the
 * window rather than contributing negative consumption.
 */
export async function getConsumptionWh(userId: number, start: Date, end: Date): Promise<WindowConsumption> {
  const db = await requireDb();

  const meterAssets = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.assetType, 'meter')));

  let totalWh = 0;
  let assetsWithData = 0;
  let sampleCount = 0;

  for (const asset of meterAssets) {
    const [agg] = await db
      .select({
        minEnergy: sql<number | null>`MIN(${telemetry.energy})`,
        maxEnergy: sql<number | null>`MAX(${telemetry.energy})`,
        samples: sql<number>`COUNT(*)`,
      })
      .from(telemetry)
      .where(and(eq(telemetry.assetId, asset.id), gte(telemetry.timestamp, start), lt(telemetry.timestamp, end)));

    const samples = Number(agg?.samples ?? 0);
    sampleCount += samples;
    if (agg?.minEnergy != null && agg?.maxEnergy != null && agg.maxEnergy >= agg.minEnergy) {
      totalWh += agg.maxEnergy - agg.minEnergy;
      assetsWithData++;
    }
    // maxEnergy < minEnergy (register moved backwards) => this asset's
    // consumption in the window is unknown; it contributes nothing.
  }

  if (assetsWithData === 0) return { totalWh: null, assetsWithData: 0, sampleCount };
  return { totalWh, assetsWithData, sampleCount };
}

export async function createChallenge(
  creatorUserId: number,
  input: {
    title: string;
    description?: string;
    goalPercent100: number;
    baselineStart: Date;
    baselineEnd: Date;
    periodStart: Date;
    periodEnd: Date;
  }
): Promise<CommunityChallenge> {
  const db = await requireDb();

  if (!input.title.trim()) throw new Error('INVALID_INPUT');
  if (!Number.isInteger(input.goalPercent100) || input.goalPercent100 <= 0 || input.goalPercent100 > 10000) {
    throw new Error('INVALID_GOAL');
  }
  if (!(input.baselineStart < input.baselineEnd)) throw new Error('INVALID_WINDOW');
  if (!(input.periodStart < input.periodEnd)) throw new Error('INVALID_WINDOW');
  if (input.baselineEnd > input.periodStart) throw new Error('INVALID_WINDOW'); // baseline must fully precede the measurement window

  const [challenge] = await db
    .insert(communityChallenges)
    .values({
      creatorUserId,
      title: input.title.trim(),
      description: input.description ?? null,
      metric: 'consumption_reduction_pct',
      goalPercent100: input.goalPercent100,
      baselineStart: input.baselineStart,
      baselineEnd: input.baselineEnd,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: 'open',
    })
    .returning();
  return challenge;
}

export async function getChallenge(challengeId: number): Promise<CommunityChallenge> {
  const db = await requireDb();
  const [challenge] = await db.select().from(communityChallenges).where(eq(communityChallenges.id, challengeId)).limit(1);
  if (!challenge) throw new Error('CHALLENGE_NOT_FOUND');
  return challenge;
}

export async function listChallenges(opts: { limit: number; status?: 'open' | 'closed' | 'cancelled' }) {
  const db = await requireDb();
  const where = opts.status ? eq(communityChallenges.status, opts.status) : undefined;
  return db
    .select()
    .from(communityChallenges)
    .where(where)
    .orderBy(desc(communityChallenges.createdAt))
    .limit(opts.limit);
}

/**
 * Join an open challenge. Rejoining after withdrawing re-activates the same
 * membership row (membership is unique per challenge+user).
 */
export async function joinChallenge(userId: number, challengeId: number): Promise<ChallengeEntry> {
  const db = await requireDb();
  const challenge = await getChallenge(challengeId);
  if (challenge.status !== 'open') throw new Error('CHALLENGE_NOT_OPEN');

  const [existing] = await db
    .select()
    .from(challengeEntries)
    .where(and(eq(challengeEntries.challengeId, challengeId), eq(challengeEntries.userId, userId)))
    .limit(1);

  if (existing) {
    if (existing.status === 'active') throw new Error('ALREADY_JOINED');
    const [reactivated] = await db
      .update(challengeEntries)
      .set({ status: 'active', withdrawnAt: null })
      .where(and(eq(challengeEntries.id, existing.id), eq(challengeEntries.status, 'withdrawn')))
      .returning();
    if (!reactivated) throw new Error('ALREADY_JOINED'); // lost a race with a concurrent rejoin
    return reactivated;
  }

  const [entry] = await db.insert(challengeEntries).values({ challengeId, userId, status: 'active' }).returning();
  return entry;
}

export async function withdrawFromChallenge(userId: number, challengeId: number): Promise<ChallengeEntry> {
  const db = await requireDb();
  const updated = await db
    .update(challengeEntries)
    .set({ status: 'withdrawn', withdrawnAt: new Date() })
    .where(and(eq(challengeEntries.challengeId, challengeId), eq(challengeEntries.userId, userId), eq(challengeEntries.status, 'active')))
    .returning();
  if (updated.length === 0) throw new Error('ENTRY_NOT_ACTIVE');
  return updated[0];
}

/**
 * Close or cancel a challenge. Only the creator, and only from 'open'.
 * Closing is the normal end (leaderboard becomes final); cancelling says
 * the challenge should not have existed. Both are terminal.
 */
export async function setChallengeStatus(
  userId: number,
  challengeId: number,
  status: 'closed' | 'cancelled'
): Promise<CommunityChallenge> {
  const db = await requireDb();
  const updated = await db
    .update(communityChallenges)
    .set({ status })
    .where(and(eq(communityChallenges.id, challengeId), eq(communityChallenges.creatorUserId, userId), eq(communityChallenges.status, 'open')))
    .returning();
  if (updated.length === 0) throw new Error('CHALLENGE_NOT_OPEN');
  return updated[0];
}

export interface ParticipantProgress {
  userId: number;
  entryStatus: 'active' | 'withdrawn';
  joinedAt: string;
  progressAvailable: boolean;
  /** Why progress cannot be computed, when it cannot. */
  unavailableReason: string | null;
  baselineWh: number | null;
  baselineDailyWh: number | null;
  currentWh: number | null;
  currentDailyWh: number | null;
  /** Achieved reduction, percent * 100. Negative = consumption grew. */
  reductionPercent100: number | null;
  goalMet: boolean | null;
}

async function computeProgress(challenge: CommunityChallenge, entry: ChallengeEntry, now: Date): Promise<ParticipantProgress> {
  const base: Omit<ParticipantProgress, 'progressAvailable' | 'unavailableReason'> = {
    userId: entry.userId,
    entryStatus: entry.status,
    joinedAt: entry.joinedAt.toISOString(),
    baselineWh: null,
    baselineDailyWh: null,
    currentWh: null,
    currentDailyWh: null,
    reductionPercent100: null,
    goalMet: null,
  };

  const baselineDays = (challenge.baselineEnd.getTime() - challenge.baselineStart.getTime()) / MS_PER_DAY;
  const baseline = await getConsumptionWh(entry.userId, challenge.baselineStart, challenge.baselineEnd);
  if (baseline.totalWh === null) {
    return {
      ...base,
      progressAvailable: false,
      unavailableReason: 'no meter readings in the baseline window — baseline consumption is unknown',
    };
  }
  const baselineDailyWh = baseline.totalWh / baselineDays;

  // Measurement window: from periodStart to min(now, periodEnd). A window
  // that has not started yields no days, not a zero.
  const measureEnd = now < challenge.periodEnd ? now : challenge.periodEnd;
  const elapsedDays = (measureEnd.getTime() - challenge.periodStart.getTime()) / MS_PER_DAY;
  if (elapsedDays <= 0) {
    return {
      ...base,
      progressAvailable: false,
      unavailableReason: 'the measurement window has not started yet',
      baselineWh: baseline.totalWh,
      baselineDailyWh,
    };
  }

  const current = await getConsumptionWh(entry.userId, challenge.periodStart, measureEnd);
  if (current.totalWh === null) {
    return {
      ...base,
      progressAvailable: false,
      unavailableReason: 'no meter readings in the measurement window — current consumption is unknown',
      baselineWh: baseline.totalWh,
      baselineDailyWh,
    };
  }
  const currentDailyWh = current.totalWh / elapsedDays;

  if (baselineDailyWh <= 0) {
    // A real but zero baseline makes a percentage meaningless (x/0).
    return {
      ...base,
      progressAvailable: false,
      unavailableReason: 'baseline consumption is zero — a percentage reduction is undefined',
      baselineWh: baseline.totalWh,
      baselineDailyWh,
      currentWh: current.totalWh,
      currentDailyWh,
    };
  }

  const reductionPercent100 = Math.round((1 - currentDailyWh / baselineDailyWh) * 10000);
  return {
    ...base,
    progressAvailable: true,
    unavailableReason: null,
    baselineWh: baseline.totalWh,
    baselineDailyWh,
    currentWh: current.totalWh,
    currentDailyWh,
    reductionPercent100,
    goalMet: reductionPercent100 >= challenge.goalPercent100,
  };
}

/**
 * Leaderboard: computed progress for every joined participant. Only entries
 * with progressAvailable:true are ranked; entries with unknown baselines
 * are listed after the ranked ones, unranked, with their reason.
 */
export async function getLeaderboard(challengeId: number, now: Date = new Date()): Promise<{
  challenge: CommunityChallenge;
  leaderboard: Array<ParticipantProgress & { rank: number | null }>;
}> {
  const db = await requireDb();
  const challenge = await getChallenge(challengeId);

  const entries = await db
    .select()
    .from(challengeEntries)
    .where(eq(challengeEntries.challengeId, challengeId))
    .orderBy(asc(challengeEntries.joinedAt));

  const progress: ParticipantProgress[] = [];
  for (const entry of entries) {
    progress.push(await computeProgress(challenge, entry, now));
  }

  const ranked = progress
    .filter((p) => p.progressAvailable && p.entryStatus === 'active')
    .sort((a, b) => (b.reductionPercent100 ?? 0) - (a.reductionPercent100 ?? 0));
  const unranked = progress.filter((p) => !p.progressAvailable || p.entryStatus !== 'active');

  let rank = 0;
  const leaderboard = [
    ...ranked.map((p) => ({ ...p, rank: ++rank })),
    ...unranked.map((p) => ({ ...p, rank: null })),
  ];

  return { challenge, leaderboard };
}

/** The caller's own progress in one challenge (null when not joined). */
export async function getMyProgress(userId: number, challengeId: number, now: Date = new Date()): Promise<ParticipantProgress | null> {
  const db = await requireDb();
  const challenge = await getChallenge(challengeId);
  const [entry] = await db
    .select()
    .from(challengeEntries)
    .where(and(eq(challengeEntries.challengeId, challengeId), eq(challengeEntries.userId, userId)))
    .limit(1);
  if (!entry) return null;
  return computeProgress(challenge, entry, now);
}
