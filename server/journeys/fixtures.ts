/**
 * The platform state a journey needs before it can start.
 *
 * Journeys are re-runnable, so these helpers are find-or-create rather than
 * create: running the same journey twice re-uses the same asset instead of
 * leaving a second one behind. Everything is created through the same services
 * a member or operator would use, so the fixture itself is part of what the
 * journey proves.
 */

import { createHash } from 'crypto';
import { TRPCError } from '@trpc/server';
import { handleModbusReadings } from '../services/grid-protocol-ingest';
import type { StepContext } from './step';

/** Assets a journey creates are named so a human can tell where they came from. */
export const JOURNEY_ASSET_PREFIX = 'Journey fixture';

export type AssetType = 'solar' | 'battery' | 'meter';

type AssetRow = {
  id: number;
  name: string;
  assetType: string;
  capacity: number;
  status: string;
};

function assetName(assetType: AssetType): string {
  return `${JOURNEY_ASSET_PREFIX} ${assetType}`;
}

async function listAssets(ctx: StepContext): Promise<AssetRow[]> {
  const result = await ctx.member.caller.assets.list();
  const assets = (result as { assets?: unknown }).assets;
  return Array.isArray(assets) ? (assets as AssetRow[]) : [];
}

/**
 * The journey's asset of a given type, registered if the member does not have
 * one yet. Capacity is in watts, as `assets.register` expects.
 */
export async function ensureAsset(
  ctx: StepContext,
  assetType: AssetType,
  capacityW = 5_000
): Promise<AssetRow> {
  const existing = (await listAssets(ctx)).find(
    asset => asset.assetType === assetType && asset.name === assetName(assetType)
  );
  if (existing) return existing;

  await ctx.member.caller.assets.register({
    assetType,
    name: assetName(assetType),
    capacity: capacityW,
    make: 'Journey',
    model: assetType,
    serialNumber: `journey-${assetType}-${ctx.member.user.id}`,
  });

  const created = (await listAssets(ctx)).find(
    asset => asset.assetType === assetType && asset.name === assetName(assetType)
  );
  if (!created) {
    throw new Error(`assets.register accepted a ${assetType} that assets.list does not return.`);
  }
  return created;
}

/**
 * An asset an operator has approved. Only approved assets may trade or be
 * dispatched, so market and grid journeys need this rather than a bare
 * registration.
 */
export async function ensureApprovedAsset(
  ctx: StepContext,
  assetType: AssetType,
  capacityW = 5_000
): Promise<AssetRow> {
  const asset = await ensureAsset(ctx, assetType, capacityW);
  if (asset.status === 'active') return asset;

  await ctx.admin.caller.admin.approveAsset({ assetId: asset.id, approved: true });
  const approved = (await listAssets(ctx)).find(candidate => candidate.id === asset.id);
  return approved ?? asset;
}

export type DeviceCredential = {
  deviceId: string;
  deviceRowId: number;
  password: string;
};

/**
 * Register a device against an asset and keep its credential.
 *
 * The secret is returned once at registration and only ever stored hashed, so a
 * journey that needs to ingest telemetry cannot recover the credential of a
 * device an earlier run registered — it rotates that device's secret instead,
 * which is what the platform tells an operator to do. The device id is derived
 * from the step and the asset (device ids are unique, so two steps of one run
 * against the same asset would otherwise collide) and stays inside the column's
 * width, so a long journey name cannot truncate two steps into one id.
 */
export async function registerDevice(
  ctx: StepContext,
  assetId: number,
  deviceType: 'smart_meter' | 'inverter' | 'battery_controller' | 'sensor' = 'smart_meter'
): Promise<DeviceCredential> {
  const discriminator = createHash('sha256').update(`${assetId}:${ctx.stepId}`).digest('hex').slice(0, 12);
  const deviceId = `journey-${assetId}-${ctx.stepId}`.slice(0, 46) + `-${discriminator}`;
  let issued: unknown;
  try {
    issued = await ctx.admin.caller.devices.register({
      assetId,
      deviceId,
      deviceType,
      manufacturer: 'Journey',
      model: 'fixture',
      telemetryInterval: 5,
    });
  } catch (error) {
    if (!(error instanceof TRPCError) || error.code !== 'CONFLICT') throw error;
    issued = await ctx.admin.caller.devices.rotateCredential({ deviceId });
  }

  const password = (issued as { mqttCredentials?: { password?: string } }).mqttCredentials?.password;
  const deviceRowId = (issued as { deviceId?: number }).deviceId;
  if (typeof password !== 'string' || typeof deviceRowId !== 'number') {
    throw new Error('The devices router did not return the credential it says it issues once.');
  }

  return { deviceId, deviceRowId, password };
}

/**
 * Present a device credential on the member's next calls. Telemetry ingestion
 * authenticates the device, not the account, so this is what makes an ingest
 * step possible at all.
 */
export function presentDeviceCredential(ctx: StepContext, credential: DeviceCredential): void {
  ctx.member.headers['x-device-id'] = credential.deviceId;
  ctx.member.headers['x-device-key'] = credential.password;
}

export function withdrawDeviceCredential(ctx: StepContext): void {
  delete ctx.member.headers['x-device-id'];
  delete ctx.member.headers['x-device-key'];
}

/**
 * Ingest a run of readings spread back over `hours`, through the same Modbus
 * ingest path a real poller uses.
 *
 * The member telemetry route stamps the server's clock on every row, so it can
 * only ever produce readings at one instant; anything that needs history —
 * forecast scoring, rolling aggregates, price-signal metering — has to come in
 * through the device path, which carries the instant the meter read.
 *
 * Returns the number of samples the ingest path reports as stored.
 */
export async function ingestHistory(
  credential: DeviceCredential,
  hours = 6,
  samplesPerHour = 4
): Promise<number> {
  const readings = [];
  const now = Date.now();
  const stepMs = Math.floor((60 * 60 * 1000) / samplesPerHour);
  for (let index = hours * samplesPerHour - 1; index >= 0; index -= 1) {
    const timestampMs = now - index * stepMs;
    // A plausible daily shape, but nothing here is presented as a measurement
    // of a real site: the rows carry the journey run in their metadata via the
    // device id, which is named for the run.
    const hour = new Date(timestampMs).getHours();
    const daylight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
    readings.push(
      {
        device_id: credential.deviceId,
        name: 'active_power',
        unit: 'W',
        address: 1,
        value: Math.round(500 + 2_000 * daylight),
        timestamp_ms: timestampMs,
      },
      {
        device_id: credential.deviceId,
        name: 'total_energy',
        unit: 'Wh',
        address: 2,
        value: Math.round((500 + 2_000 * daylight) / samplesPerHour),
        timestamp_ms: timestampMs,
      }
    );
  }
  const result = await handleModbusReadings(readings);
  return result.samples;
}

/**
 * Readings for one flexibility delivery window and for the same clock window on
 * the previous days, through the Modbus ingest path.
 *
 * Delivery is measured against the asset's own history in the same clock window,
 * so an award can only be verified when that history exists. Member telemetry is
 * stamped with the server clock and cannot carry it; the device path can, which
 * is the same path a poller replaying a spool uses.
 *
 * `baselinePowerW` is the asset's ordinary net power and `windowPowerW` what it
 * reported while delivering; the service derives the reduction itself, so the
 * fixture states measurements rather than an outcome.
 */
export async function ingestFlexibilityWindow(
  credential: DeviceCredential,
  startsAtMs: number,
  endsAtMs: number,
  options: {
    baselineDays?: number;
    samplesPerWindow?: number;
    baselinePowerW?: number;
    windowPowerW?: number;
  } = {}
): Promise<{ baselineSamples: number; windowSamples: number }> {
  const baselineDays = options.baselineDays ?? 4;
  const samplesPerWindow = options.samplesPerWindow ?? 3;
  const baselinePowerW = options.baselinePowerW ?? 400;
  const windowPowerW = options.windowPowerW ?? 2_600;
  const spanMs = endsAtMs - startsAtMs;
  const stepMs = Math.max(1, Math.floor(spanMs / samplesPerWindow));

  const readingsAt = (timestampMs: number, powerW: number) => [
    {
      device_id: credential.deviceId,
      name: 'active_power',
      unit: 'W',
      address: 1,
      value: powerW,
      timestamp_ms: timestampMs,
    },
    {
      device_id: credential.deviceId,
      name: 'total_energy',
      unit: 'Wh',
      address: 2,
      value: Math.max(1, Math.round((powerW * stepMs) / 3_600_000)),
      timestamp_ms: timestampMs,
    },
  ];

  const baseline = [];
  for (let day = baselineDays; day >= 1; day -= 1) {
    for (let index = 0; index < samplesPerWindow; index += 1) {
      baseline.push(
        ...readingsAt(startsAtMs - day * 86_400_000 + index * stepMs, baselinePowerW)
      );
    }
  }
  const baselineResult = await handleModbusReadings(baseline);

  const inWindow = [];
  for (let index = 0; index < samplesPerWindow; index += 1) {
    inWindow.push(...readingsAt(startsAtMs + index * stepMs, windowPowerW));
  }
  const windowResult = await handleModbusReadings(inWindow);

  return { baselineSamples: baselineResult.samples, windowSamples: windowResult.samples };
}

/**
 * A run of operator-entered market prices covering the hours a tariff is
 * learned from, entered through the admin price route.
 *
 * The tariff engine refuses to compute a tariff without enough real price
 * history, and that refusal is correct — so a journey that needs a tariff has
 * to give the platform prices an operator actually entered. Existing history is
 * left alone: this seeds only what is missing, so a re-run does not stack a
 * second set of prices on the same hours.
 */
export async function ensureMarketPriceHistory(
  ctx: StepContext,
  country: 'nigeria' | 'tanzania',
  days = 3
): Promise<{ existing: number; seeded: number }> {
  const before = await ctx.admin.caller.admin.getMarketPrices();
  const existingRows =
    (before as Array<{ country?: string; timestamp?: string | Date }> | null) ?? [];
  const windowStart = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const existing = existingRows.filter(
    row =>
      row.country === country &&
      row.timestamp !== undefined &&
      new Date(row.timestamp).getTime() >= windowStart
  ).length;

  // 48 samples across at least 18 of 24 hours is what the tariff engine needs.
  if (existing >= 48) {
    return { existing, seeded: 0 };
  }

  let seeded = 0;
  for (let day = days; day >= 1; day -= 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date();
      at.setDate(at.getDate() - day);
      at.setHours(hour, 0, 0, 0);
      const band =
        hour >= 18 && hour < 22 ? 'peak' : hour >= 9 && hour < 18 ? 'shoulder' : 'off_peak';
      await ctx.admin.caller.admin.setMarketPrice({
        priceType: band,
        country,
        price: band === 'peak' ? 3_200 : band === 'shoulder' ? 2_400 : 1_600,
        effectiveFrom: at,
        validUntil: new Date(at.getTime() + 60 * 60 * 1000),
      });
      seeded += 1;
    }
  }
  return { existing, seeded };
}

/**
 * Ingest a short run of readings for an asset, ending now.
 *
 * Telemetry is stored at integer scales (deciwatts, watt-hours, basis points of
 * state of charge), and the journey writes the same scales the poller does so
 * that anything reading it back — twin, forecast scoring, settlement — sees
 * real magnitudes rather than a token row.
 */
export async function ingestReadings(
  ctx: StepContext,
  assetId: number,
  credential: DeviceCredential,
  samples = 6
): Promise<number> {
  presentDeviceCredential(ctx, credential);
  try {
    let written = 0;
    for (let index = samples - 1; index >= 0; index -= 1) {
      await ctx.member.caller.telemetry.insert({
        assetId,
        power: 1_200 + index * 25,
        energy: 400 + index * 10,
        voltage: 2_300,
        current: 520,
        frequency: 5_000,
        stateOfCharge: 6_000,
        temperature: 3_100,
        metadata: JSON.stringify({ source: 'journey', runKey: ctx.runKey }),
      });
      written += 1;
    }
    return written;
  } finally {
    withdrawDeviceCredential(ctx);
  }
}

/**
 * The member's active aggregation contract, signed by the operator if they are
 * not under one yet. Invoicing refuses a member with no contract, so a journey
 * that bills has to put a real contract in place through the operator's own
 * router rather than writing the row behind it.
 */
export async function ensureActiveContract(
  ctx: StepContext,
  contractType: 'asset_aggregation' | 'full_control' | 'prepaid' = 'asset_aggregation'
): Promise<{ contractId: number; created: boolean }> {
  const active = await ctx.member.caller.contracts.myActive();
  if (active) {
    return { contractId: active.id, created: false };
  }
  const created = await ctx.admin.caller.contracts.create({
    userId: ctx.member.user.id,
    contractType,
    revenueSharePercentage: 70,
    monthlyFee: 0,
    minimumRevenue: 0,
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    terms: `Journey fixture contract (${ctx.runKey})`,
  });
  return { contractId: created.contractId, created: true };
}
