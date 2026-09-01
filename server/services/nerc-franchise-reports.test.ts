/**
 * NERC franchise reporting tests.
 *
 * Mock pattern mirrors server/analytics-honesty.test.ts and
 * server/services/payment-gateway-service.test.ts: getDb is mocked, and the
 * fake db routes each query chain by the table object passed to .from().
 * Only rows that would survive the service's WHERE clauses are seeded.
 *
 * The service persists the canonical source JSON it checksums; the tests
 * capture that insert payload and pin the computed numbers on it, and
 * recompute the SHA-256 to prove the returned checksum matches what was
 * stored.
 */

import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDbMock = vi.fn();

vi.mock('../db', () => ({
  getDb: () => getDbMock(),
}));

import { assets, billings, payments, telemetry } from '../../drizzle/schema';
import { prepaidSupplyEvents } from '../../drizzle/prepaid-schema';
import {
  generateFranchiseReport,
  REASON_INSUFFICIENT_METER_COVERAGE,
  REASON_NO_BILLED_AMOUNT,
  REASON_NO_BOUNDARY_METERS,
} from './nerc-franchise-reports';

const START = new Date('2026-01-01T00:00:00.000Z');
const END = new Date('2026-01-02T00:00:00.000Z'); // exactly 24 hours
const AREA = 'IBEDC Franchise — Ibadan North';

interface Seed {
  assetRows?: Array<{ id: number; assetType: string; metadata: string | null }>;
  telemetryRows?: Array<{
    assetId: number;
    timestamp: Date;
    power: number | null;
    energy: number | null;
    assetType: string;
    metadata: string | null;
  }>;
  billingRows?: Array<Record<string, unknown>>;
  paymentRows?: Array<Record<string, unknown>>;
  supplyEventRows?: Array<{ id: number }>;
}

let capturedInsert: any = null;

function dbWith(seed: Seed) {
  capturedInsert = null;
  return {
    select: () => ({
      from: (table: any) => {
        if (table === assets) return Promise.resolve(seed.assetRows ?? []);
        if (table === telemetry) {
          return {
            innerJoin: () => ({
              where: () => ({
                // collectSourceData reads the counter time-ordered per asset
                // for meter-reset detection; fixtures are already in that order.
                orderBy: () => Promise.resolve(seed.telemetryRows ?? []),
              }),
            }),
          };
        }
        if (table === billings) return { where: () => Promise.resolve(seed.billingRows ?? []) };
        if (table === payments) return { where: () => Promise.resolve(seed.paymentRows ?? []) };
        if (table === prepaidSupplyEvents) {
          return { where: () => Promise.resolve(seed.supplyEventRows ?? []) };
        }
        throw new Error('unexpected table in franchise report query');
      },
    }),
    insert: () => ({
      values: (v: any) => {
        capturedInsert = v;
        return { returning: () => Promise.resolve([{ id: 42 }]) };
      },
    }),
  };
}

/** The canonical source data exactly as persisted/checksummed. */
function storedSource() {
  expect(capturedInsert).toBeTruthy();
  return JSON.parse(capturedInsert.sourceJson);
}

const HAPPY_ASSETS: Seed['assetRows'] = [
  { id: 1, assetType: 'meter', metadata: '{"role":"boundary"}' },
  { id: 2, assetType: 'meter', metadata: null },
  { id: 3, assetType: 'meter', metadata: '{}' },
  { id: 4, assetType: 'solar', metadata: null },
  { id: 5, assetType: 'battery', metadata: null }, // excluded: bidirectional storage
];

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));

const HAPPY_TELEMETRY: Seed['telemetryRows'] = [
  // Boundary meter 1: 10000 -> 13000 Wh = 3 kWh imported
  { assetId: 1, timestamp: t(0), power: 4000, energy: 10000, assetType: 'meter', metadata: '{"role":"boundary"}' },
  { assetId: 1, timestamp: t(1), power: 5000, energy: 13000, assetType: 'meter', metadata: '{"role":"boundary"}' },
  // Customer meter 2: 2000 -> 3500 Wh = 1.5 kWh delivered
  { assetId: 2, timestamp: t(0, 30), power: 1000, energy: 2000, assetType: 'meter', metadata: null },
  { assetId: 2, timestamp: t(2), power: 1200, energy: 3500, assetType: 'meter', metadata: null },
  // Customer meter 3: 5000 -> 5500 Wh = 0.5 kWh delivered
  { assetId: 3, timestamp: t(1, 15), power: 800, energy: 5000, assetType: 'meter', metadata: '{}' },
  { assetId: 3, timestamp: t(2, 30), power: 900, energy: 5500, assetType: 'meter', metadata: '{}' },
  // Solar 4: 50000 -> 52000 Wh = 2 kWh generated
  { assetId: 4, timestamp: t(0), power: 0, energy: 50000, assetType: 'solar', metadata: null },
  { assetId: 4, timestamp: t(2), power: 3000, energy: 52000, assetType: 'solar', metadata: null },
  // Battery 5: delta exists but must be excluded from all energy sums
  { assetId: 5, timestamp: t(0), power: -500, energy: 7000, assetType: 'battery', metadata: null },
  { assetId: 5, timestamp: t(2), power: 500, energy: 8000, assetType: 'battery', metadata: null },
];

describe('nerc-franchise-reports', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    capturedInsert = null;
  });

  it('(a) happy path: real telemetry/billing/payments produce pinned kWh sums, efficiency math, checksum and PDF', async () => {
    getDbMock.mockResolvedValue(
      dbWith({
        assetRows: HAPPY_ASSETS,
        telemetryRows: HAPPY_TELEMETRY,
        billingRows: [
          { id: 1, userId: 10, totalValue: 100000, periodStart: t(0) }, // NGN 1000.00
          { id: 2, userId: 11, totalValue: 50000, periodStart: t(6) }, //  NGN 500.00
        ],
        paymentRows: [
          { id: 1, userId: 10, amount: 90000, currency: 'NGN', status: 'completed', createdAt: t(3) },
          { id: 2, userId: 11, amount: 30000, currency: 'NGN', status: 'completed', createdAt: t(4) },
          { id: 3, userId: 12, amount: 50000, currency: 'TZS', status: 'completed', createdAt: t(5) },
        ],
        supplyEventRows: [{ id: 1 }, { id: 2 }],
      })
    );

    const result = await generateFranchiseReport({
      generatedBy: 7,
      periodStart: START,
      periodEnd: END,
      franchiseAreaName: AREA,
    });

    // Envelope
    expect(result.reportId).toBe(42);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pdfBase64.length).toBeGreaterThan(0);
    expect(Buffer.from(result.pdfBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');

    // The returned checksum must equal SHA-256 over the persisted source JSON.
    expect(capturedInsert.checksum).toBe(result.checksum);
    expect(createHash('sha256').update(capturedInsert.sourceJson).digest('hex')).toBe(result.checksum);

    const s = storedSource();
    expect(s.reportType).toBe('nerc_franchise');
    expect(s.franchiseAreaName).toBe(AREA);

    // Technical — pinned computed numbers
    expect(s.technical.energyImportedKwh).toEqual({ value: 3, reason: null });
    expect(s.technical.energyGeneratedKwh).toEqual({ value: 2, reason: null });
    expect(s.technical.energyDistributedKwh).toEqual({ value: 2, reason: null }); // battery excluded
    expect(s.technical.distributionLossKwh).toEqual({ value: 1, reason: null });
    expect(s.technical.distributionLossPercent).toEqual({ value: 33.33, reason: null });
    // 3 distinct hours with readings out of 24 hours in the period
    expect(s.technical.availabilityEvidence).toEqual({ hoursWithReadings: 3, hoursInPeriod: 24 });
    expect(s.technical.systemAvailabilityPercent).toBe(12.5);
    expect(s.technical.peakDemandKw).toEqual({ value: 5, reason: null });
    expect(s.technical.supplyInterruptions.count).toBe(2);
    expect(s.technical.supplyInterruptions.source).toBe('prepaid_supply_events');
    expect(s.technical.metering).toEqual({
      assetsWithReadings: 5,
      boundaryMeterAssetIds: [1],
      assetsWithInsufficientReadings: [],
      assetsWithMeterReset: [],
    });

    // Commercial — pinned computed numbers
    expect(s.commercial.totalBilledNaira).toBe(1500);
    expect(s.commercial.billingCount).toBe(2);
    expect(s.commercial.totalCollectedNaira).toBe(1200); // TZS excluded from NGN headline
    expect(s.commercial.collectedPaymentCount).toBe(2);
    expect(s.commercial.collectedByCurrencyNaira).toEqual({ NGN: 1200, TZS: 500 });
    expect(s.commercial.collectionEfficiencyPercent).toEqual({ value: 80, reason: null });
    expect(s.commercial.activeCustomerCount).toBe(2);
  });

  it('(b) no boundary-meter coverage: distribution loss is null with the exact reason, never an assumed percentage', async () => {
    getDbMock.mockResolvedValue(
      dbWith({
        assetRows: [
          { id: 2, assetType: 'meter', metadata: null },
          { id: 3, assetType: 'meter', metadata: null },
        ],
        telemetryRows: [
          { assetId: 2, timestamp: t(0), power: 1000, energy: 2000, assetType: 'meter', metadata: null },
          { assetId: 2, timestamp: t(1), power: 1000, energy: 3000, assetType: 'meter', metadata: null },
          { assetId: 3, timestamp: t(0), power: 500, energy: 1000, assetType: 'meter', metadata: null },
          { assetId: 3, timestamp: t(1), power: 500, energy: 1500, assetType: 'meter', metadata: null },
        ],
      })
    );

    await generateFranchiseReport({ generatedBy: 7, periodStart: START, periodEnd: END, franchiseAreaName: AREA });
    const s = storedSource();

    expect(s.technical.energyImportedKwh).toEqual({ value: null, reason: REASON_NO_BOUNDARY_METERS });
    expect(s.technical.energyDistributedKwh).toEqual({ value: 1.5, reason: null });
    expect(s.technical.distributionLossKwh).toEqual({ value: null, reason: REASON_INSUFFICIENT_METER_COVERAGE });
    expect(s.technical.distributionLossPercent).toEqual({ value: null, reason: REASON_INSUFFICIENT_METER_COVERAGE });
  });

  it('(b2) a configured boundary meter with too few readings also yields null loss, not a fabricated one', async () => {
    getDbMock.mockResolvedValue(
      dbWith({
        assetRows: [
          { id: 1, assetType: 'meter', metadata: '{"role":"grid_import"}' },
          { id: 2, assetType: 'meter', metadata: null },
        ],
        telemetryRows: [
          // Boundary meter has a single in-window reading: no computable delta.
          { assetId: 1, timestamp: t(0), power: 4000, energy: 10000, assetType: 'meter', metadata: '{"role":"grid_import"}' },
          { assetId: 2, timestamp: t(0), power: 1000, energy: 2000, assetType: 'meter', metadata: null },
          { assetId: 2, timestamp: t(1), power: 1000, energy: 3000, assetType: 'meter', metadata: null },
        ],
      })
    );

    await generateFranchiseReport({ generatedBy: 7, periodStart: START, periodEnd: END, franchiseAreaName: AREA });
    const s = storedSource();

    expect(s.technical.energyImportedKwh).toEqual({ value: null, reason: REASON_INSUFFICIENT_METER_COVERAGE });
    expect(s.technical.distributionLossKwh).toEqual({ value: null, reason: REASON_INSUFFICIENT_METER_COVERAGE });
    expect(s.technical.metering.assetsWithInsufficientReadings).toEqual([1]);
  });

  it('(c) billed = 0: collection efficiency is null + reason, never NaN or a silent zero', async () => {
    getDbMock.mockResolvedValue(
      dbWith({
        paymentRows: [
          { id: 1, userId: 10, amount: 5000, currency: 'NGN', status: 'completed', createdAt: t(3) },
        ],
      })
    );

    await generateFranchiseReport({ generatedBy: 7, periodStart: START, periodEnd: END, franchiseAreaName: AREA });
    const s = storedSource();

    expect(s.commercial.totalBilledNaira).toBe(0);
    expect(s.commercial.billingCount).toBe(0);
    expect(s.commercial.totalCollectedNaira).toBe(50);
    expect(s.commercial.collectionEfficiencyPercent).toEqual({ value: null, reason: REASON_NO_BILLED_AMOUNT });
    expect(s.commercial.activeCustomerCount).toBe(0);

    // Empty window honesty: unknowns are null + reason, real zeros stay zero.
    expect(s.technical.energyImportedKwh.value).toBeNull();
    expect(s.technical.energyGeneratedKwh).toEqual({ value: null, reason: 'no_metered_generation_data' });
    expect(s.technical.distributionLossKwh).toEqual({ value: null, reason: REASON_INSUFFICIENT_METER_COVERAGE });
    expect(s.technical.peakDemandKw).toEqual({ value: null, reason: 'no_power_readings' });
    expect(s.technical.systemAvailabilityPercent).toBe(0); // zero coverage is a real measurement
    expect(s.technical.supplyInterruptions.count).toBe(0);
  });

  it('(b3) a meter reset is handled: post-reset reading counted as the delta and the asset flagged, not excluded', async () => {
    getDbMock.mockResolvedValue(
      dbWith({
        assetRows: [{ id: 2, assetType: 'meter', metadata: null }],
        telemetryRows: [
          // 900 -> 950 (+50), counter resets to 100 (+100 post-reset reading;
          // the pre-reset tail is unknown), 100 -> 120 (+20). Total: 170 Wh.
          { assetId: 2, timestamp: t(0), power: 900, energy: 900, assetType: 'meter', metadata: null },
          { assetId: 2, timestamp: t(1), power: 950, energy: 950, assetType: 'meter', metadata: null },
          { assetId: 2, timestamp: t(2), power: 100, energy: 100, assetType: 'meter', metadata: null },
          { assetId: 2, timestamp: t(3), power: 120, energy: 120, assetType: 'meter', metadata: null },
        ],
      })
    );

    await generateFranchiseReport({ generatedBy: 7, periodStart: START, periodEnd: END, franchiseAreaName: AREA });
    const s = storedSource();

    expect(s.technical.energyDistributedKwh).toEqual({ value: 0.17, reason: null });
    expect(s.technical.metering.assetsWithMeterReset).toEqual([2]);
  });

  it('(d) database unavailable: throws instead of fabricating a report', async () => {
    getDbMock.mockResolvedValue(null);
    await expect(
      generateFranchiseReport({ generatedBy: 7, periodStart: START, periodEnd: END, franchiseAreaName: AREA })
    ).rejects.toThrow('Database not available');
    expect(capturedInsert).toBeNull();
  });

  it('(e) rejects an inverted reporting period before touching data', async () => {
    getDbMock.mockResolvedValue(dbWith({}));
    await expect(
      generateFranchiseReport({ generatedBy: 7, periodStart: END, periodEnd: START, franchiseAreaName: AREA })
    ).rejects.toThrow('periodEnd must be after periodStart');
    await expect(
      generateFranchiseReport({ generatedBy: 7, periodStart: START, periodEnd: START, franchiseAreaName: AREA })
    ).rejects.toThrow('periodEnd must be after periodStart');
    expect(capturedInsert).toBeNull();
  });
});
