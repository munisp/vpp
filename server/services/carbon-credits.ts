/**
 * Carbon Credit Tracking Service
 *
 * Tracks per-user solar generation (real telemetry), converts it to CO2
 * avoided using the DB-backed grid emission factors from the
 * `emissions_factors` table (the same table server/services/carbon-aware-
 * dispatch.ts reads via raw SQL — here accessed through the drizzle
 * `emissionsFactors` schema). One certificate is minted per 100 kWh of
 * verified solar generation, with a deterministic SHA-256 id over the
 * certificate's factual fields so anyone can verify it publicly.
 *
 * Fails loud: when no DB-backed emission factor exists for the user's
 * region, co2Avoided is reported as null (with emissionFactorSource null)
 * and no certificates are minted — hardcoded fallback factors are never
 * used for minting.
 */

import { createHash } from 'crypto';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, emissionsFactors, telemetry, users } from '../../drizzle/schema';
import { carbonCertificates } from '../../drizzle/innovations-schema';

export const CERTIFICATE_ENERGY_WH = 100_000; // 100 kWh per certificate
const GAP_CAP_MS = 60 * 60 * 1000;
const MAX_SAMPLES_PER_ASSET = 50000;

// users.country -> emissions_factors.region codes used by carbon-aware-dispatch.
const COUNTRY_TO_REGION: Record<'nigeria' | 'tanzania', string> = {
  nigeria: 'NG-LAGOS',
  tanzania: 'TZ-DAR',
};

export function computeCertificateHash(cert: {
  userId: number;
  sequence: number;
  region: string;
  energyWh: number;
  emissionFactorGramsPerKwh: number;
  co2AvoidedGrams: number;
}): string {
  return createHash('sha256')
    .update(
      `vpp-carbon-cert|${cert.userId}|${cert.sequence}|${cert.region}|${cert.energyWh}|${cert.emissionFactorGramsPerKwh}|${cert.co2AvoidedGrams}`
    )
    .digest('hex');
}

/**
 * Total solar generation (Wh) for a user since `since` (or all time when
 * omitted). Prefers the cumulative `energy` counter per asset; falls back
 * to integrating real power samples over real intervals (gaps > 1h
 * excluded). Also returns the first/last telemetry timestamps seen and the
 * timestamp at which generation last advanced (for certificate periods).
 */
async function solarGeneration(userId: number, since?: Date): Promise<{
  totalWh: number;
  method: 'cumulative_delta' | 'power_integral' | 'mixed' | 'unavailable';
  firstSampleAt: Date | null;
  lastSampleAt: Date | null;
  assetsWithData: number;
}> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const solarAssets = await db
    .select()
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.assetType, 'solar')));

  let totalWh = 0;
  let assetsWithData = 0;
  let firstSampleAt: Date | null = null;
  let lastSampleAt: Date | null = null;
  const methods = new Set<string>();

  for (const asset of solarAssets) {
    // Try the cheap cumulative-counter path first.
    const bounds = await db
      .select({
        minEnergy: sql<number | null>`MIN(${telemetry.energy})`,
        maxEnergy: sql<number | null>`MAX(${telemetry.energy})`,
        firstTs: sql<Date | null>`MIN(${telemetry.timestamp})`,
        lastTs: sql<Date | null>`MAX(${telemetry.timestamp})`,
      })
      .from(telemetry)
      .where(since ? and(eq(telemetry.assetId, asset.id), gte(telemetry.timestamp, since)) : eq(telemetry.assetId, asset.id));

    const b = bounds[0];
    if (b?.minEnergy !== null && b?.minEnergy !== undefined && b?.maxEnergy !== null && b?.maxEnergy !== undefined && b.maxEnergy >= b.minEnergy) {
      totalWh += b.maxEnergy - b.minEnergy;
      assetsWithData++;
      methods.add('cumulative_delta');
      if (b.firstTs && (!firstSampleAt || new Date(b.firstTs) < firstSampleAt)) firstSampleAt = new Date(b.firstTs);
      if (b.lastTs && (!lastSampleAt || new Date(b.lastTs) > lastSampleAt)) lastSampleAt = new Date(b.lastTs);
      continue;
    }

    // Fallback: integrate power over real intervals.
    const samples = await db
      .select({ timestamp: telemetry.timestamp, power: telemetry.power })
      .from(telemetry)
      .where(since ? and(eq(telemetry.assetId, asset.id), gte(telemetry.timestamp, since)) : eq(telemetry.assetId, asset.id))
      .orderBy(asc(telemetry.timestamp))
      .limit(MAX_SAMPLES_PER_ASSET);

    let wh = 0;
    let used = 0;
    for (let i = 0; i < samples.length - 1; i++) {
      const p = samples[i].power;
      if (p === null) continue;
      const dtMs = new Date(samples[i + 1].timestamp).getTime() - new Date(samples[i].timestamp).getTime();
      if (dtMs <= 0 || dtMs > GAP_CAP_MS) continue;
      wh += (p * dtMs) / 3600000;
      used++;
    }
    if (samples.length > 0) {
      const f = new Date(samples[0].timestamp);
      const l = new Date(samples[samples.length - 1].timestamp);
      if (!firstSampleAt || f < firstSampleAt) firstSampleAt = f;
      if (!lastSampleAt || l > lastSampleAt) lastSampleAt = l;
    }
    if (used > 0) {
      totalWh += Math.round(wh);
      assetsWithData++;
      methods.add('power_integral');
    }
  }

  const method =
    methods.size === 0 ? 'unavailable' : methods.size === 1 ? ([...methods][0] as 'cumulative_delta' | 'power_integral') : 'mixed';
  return { totalWh, method, firstSampleAt, lastSampleAt, assetsWithData };
}

async function getRegionForUser(userId: number): Promise<{ country: 'nigeria' | 'tanzania'; region: string }> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [user] = await db.select({ country: users.country }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error('USER_NOT_FOUND');
  return { country: user.country, region: COUNTRY_TO_REGION[user.country] };
}

/**
 * Latest currently-valid DB-backed emission factor for a region, or null.
 * Mirrors the query in carbon-aware-dispatch.ts getCurrentEmissions but
 * returns null instead of a hardcoded default.
 */
export async function getLiveEmissionFactor(region: string): Promise<{
  gramsPerKwh: number;
  factorTimestamp: Date;
  dataSource: string | null;
} | null> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const now = new Date();
  const [row] = await db
    .select()
    .from(emissionsFactors)
    .where(
      and(
        eq(emissionsFactors.region, region),
        sql`${emissionsFactors.timestamp} <= ${now}`,
        sql`${emissionsFactors.validUntil} > ${now}`
      )
    )
    .orderBy(desc(emissionsFactors.timestamp))
    .limit(1);
  if (!row) return null;
  return {
    gramsPerKwh: row.averageEmissions, // average intensity is the reporting factor per carbon-aware-dispatch comments
    factorTimestamp: row.timestamp,
    dataSource: row.dataSource,
  };
}

export interface CarbonSummary {
  userId: number;
  region: string;
  periodStart: string | null;
  periodEnd: string | null;
  solarGenerationWh: number;
  energyMethod: string;
  emissionFactorGramsPerKwh: number | null;
  emissionFactorSource: 'live' | null;
  emissionFactorDataSource: string | null;
  co2AvoidedGrams: number | null;
  certificatesMintedTotal: number;
  certifiedEnergyWh: number;
  uncertifiedEnergyWh: number;
  newCertificatesMinted: number;
  mintSkippedReason: string | null;
}

/**
 * Compute the user's carbon summary and mint any certificates newly earned
 * (one per 100 kWh of all-time solar generation not yet certified).
 */
export async function getCarbonSummaryAndMint(userId: number): Promise<CarbonSummary> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const { region } = await getRegionForUser(userId);
  const generation = await solarGeneration(userId);
  const factor = await getLiveEmissionFactor(region);

  // Already-certified energy from real certificate rows.
  const certAgg = await db
    .select({
      totalEnergy: sql<number>`COALESCE(SUM(${carbonCertificates.energyWh}), 0)`,
      count: sql<number>`COUNT(*)`,
      maxSequence: sql<number | null>`MAX(${carbonCertificates.sequence})`,
      lastPeriodEnd: sql<Date | null>`MAX(${carbonCertificates.periodEnd})`,
    })
    .from(carbonCertificates)
    .where(eq(carbonCertificates.userId, userId));
  const certifiedEnergyWh = Number(certAgg[0]?.totalEnergy ?? 0);
  const certificatesMintedTotal = Number(certAgg[0]?.count ?? 0);
  let nextSequence = Number(certAgg[0]?.maxSequence ?? 0) + 1;
  let periodCursor: Date = certAgg[0]?.lastPeriodEnd
    ? new Date(certAgg[0].lastPeriodEnd as unknown as Date)
    : generation.firstSampleAt ?? new Date();

  const uncertifiedEnergyWh = Math.max(0, generation.totalWh - certifiedEnergyWh);
  const co2AvoidedGrams = factor ? Math.round((generation.totalWh / 1000) * factor.gramsPerKwh) : null;

  let newCertificatesMinted = 0;
  let mintSkippedReason: string | null = null;
  const mintable = Math.floor(uncertifiedEnergyWh / CERTIFICATE_ENERGY_WH);

  if (mintable > 0 && !factor) {
    mintSkippedReason = `No live emission factor available for region ${region}; ${mintable} certificate(s) pending until a DB-backed factor exists.`;
  } else if (mintable > 0 && factor) {
    for (let i = 0; i < mintable; i++) {
      const co2 = Math.round((CERTIFICATE_ENERGY_WH / 1000) * factor.gramsPerKwh);
      const sequence = nextSequence++;
      const periodStart = periodCursor;
      const periodEnd = generation.lastSampleAt ?? new Date();
      const certificateHash = computeCertificateHash({
        userId,
        sequence,
        region,
        energyWh: CERTIFICATE_ENERGY_WH,
        emissionFactorGramsPerKwh: factor.gramsPerKwh,
        co2AvoidedGrams: co2,
      });

      await db.insert(carbonCertificates).values({
        userId,
        sequence,
        certificateHash,
        region,
        energyWh: CERTIFICATE_ENERGY_WH,
        emissionFactorGramsPerKwh: factor.gramsPerKwh,
        emissionFactorSource: 'live',
        co2AvoidedGrams: co2,
        periodStart,
        periodEnd,
        status: 'minted',
        metadata: JSON.stringify({ emissionFactorDataSource: factor.dataSource, factorTimestamp: factor.factorTimestamp.toISOString() }),
      });

      periodCursor = periodEnd;
      newCertificatesMinted++;
    }
  }

  return {
    userId,
    region,
    periodStart: generation.firstSampleAt?.toISOString() ?? null,
    periodEnd: generation.lastSampleAt?.toISOString() ?? null,
    solarGenerationWh: generation.totalWh,
    energyMethod: generation.method,
    emissionFactorGramsPerKwh: factor?.gramsPerKwh ?? null,
    emissionFactorSource: factor ? 'live' : null,
    emissionFactorDataSource: factor?.dataSource ?? null,
    co2AvoidedGrams,
    certificatesMintedTotal: certificatesMintedTotal + newCertificatesMinted,
    certifiedEnergyWh: certifiedEnergyWh + newCertificatesMinted * CERTIFICATE_ENERGY_WH,
    uncertifiedEnergyWh: uncertifiedEnergyWh - newCertificatesMinted * CERTIFICATE_ENERGY_WH,
    newCertificatesMinted,
    mintSkippedReason,
  };
}

export async function listCertificates(userId: number, limit: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db
    .select()
    .from(carbonCertificates)
    .where(eq(carbonCertificates.userId, userId))
    .orderBy(desc(carbonCertificates.sequence))
    .limit(limit);
}

/**
 * Public certificate verification by hash: recomputes the deterministic
 * hash from the stored factual fields and compares.
 */
export async function verifyCertificate(certificateHash: string): Promise<{
  found: boolean;
  valid: boolean;
  certificate: {
    certificateHash: string;
    userId: number;
    sequence: number;
    region: string;
    energyWh: number;
    co2AvoidedGrams: number;
    emissionFactorGramsPerKwh: number;
    emissionFactorSource: string;
    periodStart: string;
    periodEnd: string;
    status: string;
    mintedAt: string;
  } | null;
}> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const [cert] = await db
    .select()
    .from(carbonCertificates)
    .where(eq(carbonCertificates.certificateHash, certificateHash.toLowerCase()))
    .limit(1);

  if (!cert) return { found: false, valid: false, certificate: null };

  const recomputed = computeCertificateHash({
    userId: cert.userId,
    sequence: cert.sequence,
    region: cert.region,
    energyWh: cert.energyWh,
    emissionFactorGramsPerKwh: cert.emissionFactorGramsPerKwh,
    co2AvoidedGrams: cert.co2AvoidedGrams,
  });

  return {
    found: true,
    valid: recomputed === cert.certificateHash,
    certificate: {
      certificateHash: cert.certificateHash,
      userId: cert.userId,
      sequence: cert.sequence,
      region: cert.region,
      energyWh: cert.energyWh,
      co2AvoidedGrams: cert.co2AvoidedGrams,
      emissionFactorGramsPerKwh: cert.emissionFactorGramsPerKwh,
      emissionFactorSource: cert.emissionFactorSource,
      periodStart: cert.periodStart.toISOString(),
      periodEnd: cert.periodEnd.toISOString(),
      status: cert.status,
      mintedAt: cert.mintedAt.toISOString(),
    },
  };
}
