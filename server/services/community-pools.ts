/**
 * Community Energy Pools — Allocation Rules Engine
 *
 * Extends the existing community energy service
 * (server/services/community-energy.ts, imported but not modified) with a
 * configurable allocation RULES layer:
 *
 *   - Pool admins store a rule per community: proportional-to-consumption,
 *     equal, proportional-to-generation, or custom per-member weights.
 *   - An allocation run computes each member's share of the pool's real
 *     surplus/deficit over a period from real telemetry, applies the rule,
 *     and persists allocation_runs + allocation_entries (member statements).
 *
 * Prices come from the community service's real getPeriodPrices (recorded
 * market prices, then trained ML forecast); it throws when no real price
 * source exists and that error is propagated — pool money is never valued
 * with invented rates.
 */

import { getDb } from '../db';
import { sql, desc, eq } from 'drizzle-orm';
import {
  poolAllocationRules,
  allocationRuns,
  allocationEntries,
  PoolAllocationRule,
  AllocationRun,
  AllocationEntry,
} from '../../drizzle/grid-intel-schema';
import { communityEnergy } from './community-energy';
import type { SqlRow } from '../sql-row';

export type PoolRuleType = 'proportional_consumption' | 'equal' | 'proportional_generation' | 'custom_weights';

export interface MemberEnergy {
  userId: number;
  generationWh: number;
  consumptionWh: number;
}

export interface AllocationRunResult {
  run: AllocationRun;
  entries: AllocationEntry[];
}

export class CommunityPoolsService {
  /**
   * Create or replace a community's allocation rule (pool admin only).
   */
  async setPoolRules(
    communityId: number,
    actorUserId: number,
    actorIsPlatformAdmin: boolean,
    rule: { ruleType: PoolRuleType; customWeights?: Record<string, number> }
  ): Promise<PoolAllocationRule> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await this.assertPoolAdmin(communityId, actorUserId, actorIsPlatformAdmin);

    const community = await communityEnergy.getCommunity(communityId);
    if (!community) throw new Error('Community not found');

    let customWeightsJson: string | null = null;
    if (rule.ruleType === 'custom_weights') {
      if (!rule.customWeights || Object.keys(rule.customWeights).length === 0) {
        throw new Error('custom_weights rule requires a non-empty customWeights map of userId -> weight');
      }
      for (const [uid, w] of Object.entries(rule.customWeights)) {
        if (!/^\d+$/.test(uid) || typeof w !== 'number' || !(w > 0)) {
          throw new Error('customWeights must map numeric userIds to positive numeric weights');
        }
      }
      customWeightsJson = JSON.stringify(rule.customWeights);
    }

    const updateSet: Record<string, unknown> = {
      ruleType: rule.ruleType,
      customWeights: customWeightsJson,
      updatedBy: actorUserId,
    };

    await db
      .insert(poolAllocationRules)
      .values({
        communityId,
        ruleType: rule.ruleType,
        customWeights: customWeightsJson,
        updatedBy: actorUserId,
      })
      .onConflictDoUpdate({ target: poolAllocationRules.communityId, set: updateSet });

    const rules = await this.getPoolRules(communityId);
    return rules!;
  }

  /** Fetch the stored rule for a community (null when not configured). */
  async getPoolRules(communityId: number): Promise<PoolAllocationRule | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    const rows = await db.select().from(poolAllocationRules).where(eq(poolAllocationRules.communityId, communityId)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Run an allocation over a period using the community's stored rule.
   */
  async runAllocation(
    communityId: number,
    periodStart: Date,
    periodEnd: Date,
    runBy: number,
    actorIsPlatformAdmin: boolean
  ): Promise<AllocationRunResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await this.assertPoolAdmin(communityId, runBy, actorIsPlatformAdmin);
    if (periodEnd <= periodStart) throw new Error('periodEnd must be after periodStart');

    const rule = await this.getPoolRules(communityId);
    if (!rule) {
      throw new Error(`No allocation rule configured for community ${communityId}; a pool admin must call setPoolRules first`);
    }

    const members = (await communityEnergy.getCommunityMembers(communityId)).filter(m => m.status === 'active');
    if (members.length === 0) throw new Error('Community has no active members');

    // Real per-member energy over the period (same telemetry aggregation as
    // the community energy service: positive power = generation/export,
    // negative = consumption/import, 5-minute sampling interval).
    const memberEnergy: MemberEnergy[] = [];
    for (const member of members) {
      const telemetryResult = await db.execute<SqlRow>(sql`
        SELECT
          COALESCE(SUM(CASE WHEN t.power > 0 THEN t.power * 5 / 60 ELSE 0 END), 0) as generation_wh,
          COALESCE(SUM(CASE WHEN t.power < 0 THEN ABS(t.power) * 5 / 60 ELSE 0 END), 0) as consumption_wh
        FROM telemetry t
        JOIN assets a ON a.id = t."assetId"
        WHERE a."userId" = ${member.userId}
          AND t.timestamp >= ${periodStart}
          AND t.timestamp <= ${periodEnd}
      `);
      const row = telemetryResult.rows[0] || {};
      memberEnergy.push({
        userId: member.userId,
        generationWh: Number(row.generation_wh || 0),
        consumptionWh: Number(row.consumption_wh || 0),
      });
    }

    const totalGenerationWh = memberEnergy.reduce((s, m) => s + m.generationWh, 0);
    const totalConsumptionWh = memberEnergy.reduce((s, m) => s + m.consumptionWh, 0);
    const surplusWh = Math.max(0, totalGenerationWh - totalConsumptionWh);
    const deficitWh = Math.max(0, totalConsumptionWh - totalGenerationWh);

    // Real period prices via the community service's resolver (throws when
    // no recorded prices and no trained ML forecast — propagated).
    const priceResolver = communityEnergy as unknown as {
      getPeriodPrices(periodStart: Date, periodEnd: Date): Promise<{ exportPrice: number; importPrice: number }>;
    };
    const { exportPrice, importPrice } = await priceResolver.getPeriodPrices(periodStart, periodEnd);

    const netValueCents = Math.round((surplusWh / 1000) * exportPrice) - Math.round((deficitWh / 1000) * importPrice);

    // ---- Apply the allocation rule ----
    const shares = this.computeShares(rule, memberEnergy, totalGenerationWh, totalConsumptionWh);

    // Convert shares to cents; fix rounding drift on the largest shareholder
    const rawCents = shares.map(s => Math.round(netValueCents * s.share));
    const drift = netValueCents - rawCents.reduce((a, b) => a + b, 0);
    if (drift !== 0 && rawCents.length > 0) {
      let maxIdx = 0;
      for (let i = 1; i < rawCents.length; i++) if (Math.abs(rawCents[i]) > Math.abs(rawCents[maxIdx])) maxIdx = i;
      rawCents[maxIdx] += drift;
    }

    // ---- Persist run + entries ----
    const runInsert = await db.insert(allocationRuns).values({
      communityId,
      periodStart,
      periodEnd,
      ruleType: rule.ruleType,
      totalGenerationWh: Math.round(totalGenerationWh),
      totalConsumptionWh: Math.round(totalConsumptionWh),
      surplusWh: Math.round(surplusWh),
      deficitWh: Math.round(deficitWh),
      exportPriceCents: Math.round(exportPrice * 100) / 100,
      importPriceCents: Math.round(importPrice * 100) / 100,
      netValueCents,
      status: 'computed',
      runBy,
    }).returning({ id: allocationRuns.id });
    const runId = Number(runInsert[0].id);

    for (let i = 0; i < shares.length; i++) {
      await db.insert(allocationEntries).values({
        runId,
        communityId,
        userId: shares[i].userId,
        shareBps: Math.round(shares[i].share * 10000),
        generationWh: Math.round(shares[i].generationWh),
        consumptionWh: Math.round(shares[i].consumptionWh),
        allocatedValueCents: rawCents[i],
      });
    }

    console.log(`[CommunityPools] Allocation run ${runId} for community ${communityId}: rule=${rule.ruleType}, net=${netValueCents}c across ${shares.length} members`);

    const runRows = await db.select().from(allocationRuns).where(eq(allocationRuns.id, runId)).limit(1);
    const entryRows = await db.select().from(allocationEntries).where(eq(allocationEntries.runId, runId));
    return { run: runRows[0], entries: entryRows };
  }

  /**
   * Compute each member's share (0..1) under the configured rule.
   */
  private computeShares(
    rule: PoolAllocationRule,
    memberEnergy: MemberEnergy[],
    totalGenerationWh: number,
    totalConsumptionWh: number
  ): Array<{ userId: number; share: number; generationWh: number; consumptionWh: number }> {
    const n = memberEnergy.length;

    const weightOf = (m: MemberEnergy): number => {
      switch (rule.ruleType) {
        case 'equal':
          return 1;
        case 'proportional_consumption':
          return m.consumptionWh;
        case 'proportional_generation':
          return m.generationWh;
        case 'custom_weights': {
          const weights = JSON.parse(rule.customWeights || '{}') as Record<string, number>;
          const w = weights[String(m.userId)];
          if (typeof w !== 'number' || !(w > 0)) {
            throw new Error(`custom_weights rule is missing a positive weight for user ${m.userId}`);
          }
          return w;
        }
      }
    };

    const weights = memberEnergy.map(m => weightOf(m));
    let totalWeight = weights.reduce((a, b) => a + b, 0);

    if (totalWeight <= 0) {
      // e.g. proportional_consumption with zero recorded consumption for all
      // members: no real signal to differentiate — fall back to equal shares.
      if (rule.ruleType === 'custom_weights') {
        throw new Error('custom_weights resolved to zero total weight');
      }
      console.warn(`[CommunityPools] Rule ${rule.ruleType} produced zero total weight (no real signal); using equal shares`);
      totalWeight = n;
      return memberEnergy.map(m => ({
        userId: m.userId,
        share: 1 / n,
        generationWh: m.generationWh,
        consumptionWh: m.consumptionWh,
      }));
    }

    return memberEnergy.map((m, i) => ({
      userId: m.userId,
      share: weights[i] / totalWeight,
      generationWh: m.generationWh,
      consumptionWh: m.consumptionWh,
    }));
  }

  /**
   * A member's statement for a run (defaults to the latest run).
   */
  async getMyStatement(
    communityId: number,
    userId: number,
    runId?: number
  ): Promise<{ run: AllocationRun; entry: AllocationEntry | null }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await this.assertMember(communityId, userId);

    let run: AllocationRun | undefined;
    if (runId) {
      const rows = await db.select().from(allocationRuns).where(eq(allocationRuns.id, runId)).limit(1);
      run = rows[0];
      if (run && run.communityId !== communityId) throw new Error('Run does not belong to this community');
    } else {
      const rows = await db
        .select()
        .from(allocationRuns)
        .where(eq(allocationRuns.communityId, communityId))
        .orderBy(desc(allocationRuns.createdAt))
        .limit(1);
      run = rows[0];
    }
    if (!run) throw new Error('No allocation runs found for this community');

    const entries = await db
      .select()
      .from(allocationEntries)
      .where(eq(allocationEntries.runId, run.id));
    const entry = entries.find(e => e.userId === userId) ?? null;

    return { run, entry };
  }

  /**
   * List allocation runs for a community (members can list their pool's runs).
   */
  async listRuns(communityId: number, userId: number, actorIsPlatformAdmin: boolean, limit: number = 20): Promise<AllocationRun[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    if (!actorIsPlatformAdmin) await this.assertMember(communityId, userId);
    return db
      .select()
      .from(allocationRuns)
      .where(eq(allocationRuns.communityId, communityId))
      .orderBy(desc(allocationRuns.createdAt))
      .limit(limit);
  }

  /** Caller must be an active admin/operator member of the pool (or platform admin). */
  private async assertPoolAdmin(communityId: number, userId: number, actorIsPlatformAdmin: boolean): Promise<void> {
    if (actorIsPlatformAdmin) return;
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    const result = await db.execute<SqlRow>(sql`
      SELECT id FROM community_members
      WHERE community_id = ${communityId} AND user_id = ${userId}
        AND role IN ('admin', 'operator') AND status = 'active'
      LIMIT 1
    `);
    if (!(result.rows?.length > 0)) {
      throw new Error('Only an active pool admin/operator can perform this action');
    }
  }

  /** Public membership check for read endpoints (platform admins bypass). */
  async requireMembership(communityId: number, userId: number, actorIsPlatformAdmin: boolean): Promise<void> {
    if (actorIsPlatformAdmin) return;
    await this.assertMember(communityId, userId);
  }

  /** Caller must be an active member of the pool. */
  private async assertMember(communityId: number, userId: number): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    const result = await db.execute<SqlRow>(sql`
      SELECT id FROM community_members
      WHERE community_id = ${communityId} AND user_id = ${userId} AND status = 'active'
      LIMIT 1
    `);
    if (!(result.rows?.length > 0)) {
      throw new Error('You are not an active member of this community');
    }
  }
}

export const communityPools = new CommunityPoolsService();
