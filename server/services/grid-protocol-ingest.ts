/**
 * Grid protocol ingest.
 *
 * The protocol services (services/grid-protocols in Go, services/modbus-poller
 * in Rust) speak the wire protocols; every decision with money or grid
 * commitments attached is made here, against the database.
 *
 * Invariants:
 *  - an unknown charge point, idTag or device is rejected, never provisioned
 *    on the fly;
 *  - OpenADR opt-in is returned only when enrolled flexible capacity exists;
 *  - meter values are attributed to an open transaction or rejected, so no
 *    energy is booked against a session we cannot identify.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { telemetry, devices, drParticipants } from '../../drizzle/schema';
import {
  chargingSessions,
  chargingStations,
} from '../../drizzle/nextgen-vpp-schema';
import {
  gridProtocolInstructions,
  ocppIdTags,
} from '../../drizzle/grid-protocol-schema';

/** Signed requests older than this are replays and are rejected. */
export const SIGNATURE_MAX_AGE_SECONDS = 300;

export class GridProtocolError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'GridProtocolError';
  }
}

/**
 * The shared secret used by the Go/Rust protocol services. Absent or weak
 * secrets are a hard failure: an unauthenticated ingest endpoint would let
 * anyone book energy.
 */
export function gridSharedSecret(): string {
  const secret = process.env.GRID_PROTOCOL_SHARED_SECRET;
  if (!secret) {
    throw new Error(
      'GRID_PROTOCOL_SHARED_SECRET is required to accept grid protocol requests'
    );
  }
  if (secret.length < 32) {
    throw new Error('GRID_PROTOCOL_SHARED_SECRET must be at least 32 characters');
  }
  return secret;
}

/**
 * Verifies `x-grid-signature` over `timestamp + "." + rawBody`, the scheme
 * implemented by internal/platform in the Go service and platform.rs in the
 * Rust poller.
 */
export function verifyGridSignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): void {
  if (!timestamp || !signature) {
    throw new GridProtocolError(401, 'missing x-grid-timestamp or x-grid-signature');
  }
  const sent = Number(timestamp);
  if (!Number.isInteger(sent)) {
    throw new GridProtocolError(401, 'x-grid-timestamp must be a unix timestamp');
  }
  if (Math.abs(nowSeconds - sent) > SIGNATURE_MAX_AGE_SECONDS) {
    throw new GridProtocolError(401, 'x-grid-timestamp is outside the accepted window');
  }

  const expected = createHmac('sha256', gridSharedSecret())
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    throw new GridProtocolError(401, 'x-grid-signature is not hex encoded');
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new GridProtocolError(401, 'x-grid-signature does not match');
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new GridProtocolError(
      503,
      'database unavailable: grid protocol requests cannot be accepted'
    );
  }
  return db;
}

async function requireStation(chargePointId: string) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(chargingStations)
    .where(eq(chargingStations.stationId, chargePointId))
    .limit(1);
  const station = rows[0];
  if (!station) {
    throw new GridProtocolError(
      404,
      `charge point ${chargePointId} is not registered on this platform`
    );
  }
  return station;
}

// ============================ OCPP 1.6 ============================

export interface BootNotification {
  chargePointVendor: string;
  chargePointModel: string;
  chargePointSerialNumber?: string;
  firmwareVersion?: string;
}

/**
 * Accepts a boot notification only for a provisioned station: a charge point
 * we do not know about is rejected rather than auto-registered.
 */
export async function handleBootNotification(
  chargePointId: string,
  req: BootNotification
): Promise<{ status: 'Accepted'; currentTime: string; interval: number }> {
  const station = await requireStation(chargePointId);
  const db = await requireDb();
  await db
    .update(chargingStations)
    .set({
      status: 'available',
      lastHeartbeat: new Date(),
      ocppVersion: '1.6',
      metadata: JSON.stringify({
        vendor: req.chargePointVendor,
        model: req.chargePointModel,
        serialNumber: req.chargePointSerialNumber ?? null,
        firmwareVersion: req.firmwareVersion ?? null,
      }),
    })
    .where(eq(chargingStations.id, station.id));

  return {
    status: 'Accepted',
    currentTime: new Date().toISOString(),
    interval: 300,
  };
}

export async function handleHeartbeat(chargePointId: string): Promise<{ currentTime: string }> {
  const station = await requireStation(chargePointId);
  const db = await requireDb();
  await db
    .update(chargingStations)
    .set({ lastHeartbeat: new Date() })
    .where(eq(chargingStations.id, station.id));
  return { currentTime: new Date().toISOString() };
}

const OCPP_STATUS_MAP: Record<string, 'available' | 'occupied' | 'charging' | 'faulted' | 'offline'> = {
  Available: 'available',
  Preparing: 'occupied',
  Charging: 'charging',
  SuspendedEV: 'occupied',
  SuspendedEVSE: 'occupied',
  Finishing: 'occupied',
  Reserved: 'occupied',
  Unavailable: 'offline',
  Faulted: 'faulted',
};

export async function handleStatusNotification(
  chargePointId: string,
  req: { connectorId: number; status: string; errorCode: string }
): Promise<void> {
  const station = await requireStation(chargePointId);
  const mapped = OCPP_STATUS_MAP[req.status];
  if (!mapped) {
    throw new GridProtocolError(400, `unknown OCPP connector status ${req.status}`);
  }
  const db = await requireDb();
  await db
    .update(chargingStations)
    .set({ status: mapped, lastHeartbeat: new Date() })
    .where(eq(chargingStations.id, station.id));
}

export interface IdTagInfo {
  status: 'Accepted' | 'Blocked' | 'Expired' | 'Invalid';
  expiryDate?: string;
  parentIdTag?: string;
}

/**
 * Resolves an idTag against the database. An unknown tag is `Invalid`; the
 * central system has no rule that could accept it.
 */
export async function authorizeIdTag(idTag: string): Promise<IdTagInfo> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(ocppIdTags)
    .where(eq(ocppIdTags.idTag, idTag))
    .limit(1);
  const tag = rows[0];
  if (!tag) {
    return { status: 'Invalid' };
  }
  if (tag.status === 'blocked') return { status: 'Blocked' };
  if (tag.status === 'invalid') return { status: 'Invalid' };
  if (tag.status === 'expired') return { status: 'Expired' };
  if (tag.expiryDate && tag.expiryDate.getTime() <= Date.now()) {
    return { status: 'Expired', expiryDate: tag.expiryDate.toISOString() };
  }
  return {
    status: 'Accepted',
    expiryDate: tag.expiryDate ? tag.expiryDate.toISOString() : undefined,
    parentIdTag: tag.parentIdTag ?? undefined,
  };
}

export interface StartTransactionRequest {
  connectorId: number;
  idTag: string;
  meterStart: number;
  timestamp: string;
  reservationId?: number;
}

/**
 * Opens a charging session. The transaction id is the session row id, so meter
 * values and the stop transaction resolve to a row that really exists.
 */
export async function handleStartTransaction(
  chargePointId: string,
  req: StartTransactionRequest
): Promise<{ transactionId: number; idTagInfo: IdTagInfo }> {
  const station = await requireStation(chargePointId);
  const db = await requireDb();

  const tagRows = await db
    .select()
    .from(ocppIdTags)
    .where(eq(ocppIdTags.idTag, req.idTag))
    .limit(1);
  const tag = tagRows[0];
  const info = await authorizeIdTag(req.idTag);
  if (!tag || info.status !== 'Accepted') {
    throw new GridProtocolError(
      403,
      `idTag ${req.idTag} is not authorized to start a transaction (${info.status})`
    );
  }
  if (!tag.evId) {
    throw new GridProtocolError(
      409,
      `idTag ${req.idTag} has no vehicle assigned; a session cannot be attributed`
    );
  }

  const startedAt = parseTimestamp(req.timestamp, 'timestamp');
  const sessionId = `ocpp:${chargePointId}:${req.connectorId}:${startedAt.getTime()}`;
  await db.insert(chargingSessions).values({
    evId: tag.evId,
    stationId: station.id,
    userId: tag.userId,
    sessionId,
    startTime: startedAt,
    energyDeliveredWh: 0,
    energyExportedWh: 0,
    sessionType: station.v2gCapable ? 'v2g' : 'standard_charge',
    status: 'charging',
    metadata: JSON.stringify({
      idTag: req.idTag,
      connectorId: req.connectorId,
      meterStartWh: req.meterStart,
      reservationId: req.reservationId ?? null,
    }),
  });

  const created = await db
    .select()
    .from(chargingSessions)
    .where(eq(chargingSessions.sessionId, sessionId))
    .limit(1);
  const session = created[0];
  if (!session) {
    throw new GridProtocolError(500, 'charging session was not persisted');
  }
  return { transactionId: session.id, idTagInfo: info };
}

export interface StopTransactionRequest {
  transactionId: number;
  idTag?: string;
  meterStop: number;
  timestamp: string;
  reason?: string;
}

/**
 * Closes a session and books the delivered energy from the charge point's own
 * meter registers. A negative delta is treated as exported (V2G) energy rather
 * than clamped, and an unknown transaction is rejected.
 */
export async function handleStopTransaction(
  chargePointId: string,
  req: StopTransactionRequest
): Promise<{ idTagInfo?: IdTagInfo }> {
  const station = await requireStation(chargePointId);
  const db = await requireDb();
  const rows = await db
    .select()
    .from(chargingSessions)
    .where(eq(chargingSessions.id, req.transactionId))
    .limit(1);
  const session = rows[0];
  if (!session || session.stationId !== station.id) {
    throw new GridProtocolError(
      404,
      `transaction ${req.transactionId} does not belong to charge point ${chargePointId}`
    );
  }
  if (session.endTime) {
    throw new GridProtocolError(409, `transaction ${req.transactionId} is already closed`);
  }

  const meterStart = readMeterStart(session.metadata);
  const deltaWh = req.meterStop - meterStart;
  await db
    .update(chargingSessions)
    .set({
      endTime: parseTimestamp(req.timestamp, 'timestamp'),
      energyDeliveredWh: deltaWh >= 0 ? deltaWh : 0,
      energyExportedWh: deltaWh < 0 ? -deltaWh : 0,
      status: 'completed',
      metadata: JSON.stringify({
        ...(safeParse(session.metadata) ?? {}),
        meterStopWh: req.meterStop,
        stopReason: req.reason ?? null,
      }),
    })
    .where(eq(chargingSessions.id, session.id));

  return req.idTag ? { idTagInfo: await authorizeIdTag(req.idTag) } : {};
}

export interface SampledValue {
  value: string;
  measurand?: string;
  unit?: string;
  context?: string;
}

export interface MeterValuesRequest {
  connectorId: number;
  transactionId?: number;
  meterValue: Array<{ timestamp: string; sampledValue: SampledValue[] }>;
}

/**
 * Books metered energy against the transaction the charge point names. Meter
 * values that carry no transaction id are rejected: unattributed energy must
 * not reach settlement.
 */
export async function handleMeterValues(
  chargePointId: string,
  req: MeterValuesRequest
): Promise<{ recorded: number }> {
  const station = await requireStation(chargePointId);
  if (req.transactionId === undefined) {
    throw new GridProtocolError(
      409,
      'meter values without a transactionId cannot be attributed to a session'
    );
  }
  const db = await requireDb();
  const rows = await db
    .select()
    .from(chargingSessions)
    .where(eq(chargingSessions.id, req.transactionId))
    .limit(1);
  const session = rows[0];
  if (!session || session.stationId !== station.id) {
    throw new GridProtocolError(
      404,
      `transaction ${req.transactionId} does not belong to charge point ${chargePointId}`
    );
  }
  if (session.endTime) {
    throw new GridProtocolError(409, `transaction ${req.transactionId} is already closed`);
  }

  const meterStart = readMeterStart(session.metadata);
  let recorded = 0;
  let latestRegisterWh: number | null = null;
  let latestPowerW: number | null = null;
  let latestSoc: number | null = null;

  for (const entry of req.meterValue) {
    for (const sample of entry.sampledValue) {
      const value = Number(sample.value);
      if (!Number.isFinite(value)) {
        throw new GridProtocolError(
          400,
          `sampled value "${sample.value}" is not a number`
        );
      }
      const measurand = sample.measurand ?? 'Energy.Active.Import.Register';
      switch (measurand) {
        case 'Energy.Active.Import.Register':
          latestRegisterWh = toWattHours(value, sample.unit);
          recorded += 1;
          break;
        case 'Power.Active.Import':
          latestPowerW = toWatts(value, sample.unit);
          recorded += 1;
          break;
        case 'SoC':
          latestSoc = toSocPercent(value);
          recorded += 1;
          break;
        default:
          // Other measurands (voltage, current, temperature) are not settlement
          // inputs for a charging session and are intentionally not stored here.
          break;
      }
    }
  }

  if (recorded === 0) {
    throw new GridProtocolError(400, 'no usable measurands in meter values');
  }

  const delta = latestRegisterWh === null ? null : latestRegisterWh - meterStart;
  await db
    .update(chargingSessions)
    .set({
      ...(delta === null
        ? {}
        : {
            energyDeliveredWh: delta >= 0 ? delta : 0,
            energyExportedWh: delta < 0 ? -delta : 0,
          }),
      ...(latestPowerW === null ? {} : { maxPowerKw: Math.round(Math.abs(latestPowerW) / 100) }),
      ...(latestSoc === null ? {} : { endSocPercent: latestSoc }),
      status: latestPowerW !== null && latestPowerW < 0 ? 'discharging' : 'charging',
    })
    .where(eq(chargingSessions.id, session.id));

  return { recorded };
}

function toWattHours(value: number, unit: string | undefined): number {
  switch (unit) {
    case undefined:
    case 'Wh':
      return Math.round(value);
    case 'kWh':
      return Math.round(value * 1000);
    default:
      throw new GridProtocolError(400, `unsupported energy unit ${unit}`);
  }
}

/** charging_sessions.end_soc_percent is a plain 0-100 percentage. */
function toSocPercent(value: number): number {
  if (value < 0 || value > 100) {
    throw new GridProtocolError(400, `state of charge ${value} is not a percentage`);
  }
  return Math.round(value);
}

function toWatts(value: number, unit: string | undefined): number {
  switch (unit) {
    case undefined:
    case 'W':
      return Math.round(value);
    case 'kW':
      return Math.round(value * 1000);
    default:
      throw new GridProtocolError(400, `unsupported power unit ${unit}`);
  }
}

function readMeterStart(metadata: string | null): number {
  const parsed = safeParse(metadata);
  const meterStart = parsed?.meterStartWh;
  if (typeof meterStart !== 'number' || !Number.isFinite(meterStart)) {
    throw new GridProtocolError(
      409,
      'session has no recorded meter start; delivered energy cannot be derived'
    );
  }
  return meterStart;
}

function safeParse(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseTimestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new GridProtocolError(400, `${field} is not a valid timestamp`);
  }
  return parsed;
}

// ============================ OpenADR 2.0b ============================

export interface OpenADREvent {
  eventId: string;
  modificationNumber: number;
  marketContext: string;
  status: string;
  priority: number;
  testEvent: boolean;
  start: string;
  durationSeconds: number;
  signals: Array<{
    name: string;
    type: string;
    intervals: Array<{ start: string; durationSeconds: number; value: number }>;
  }>;
}

export interface OpenADRDecision {
  optType: 'optIn' | 'optOut';
  reason: string;
}

/**
 * Decides participation in a VTN event and records both event and decision.
 *
 * Opt-in requires enrolled flexible capacity: without participants there is
 * nothing to dispatch, and opting in would promise a reduction we cannot
 * deliver (and would be settled for).
 */
export async function handleOpenADREvent(event: OpenADREvent): Promise<OpenADRDecision> {
  const db = await requireDb();
  const start = parseTimestamp(event.start, 'start');
  if (event.durationSeconds <= 0) {
    throw new GridProtocolError(400, 'event duration must be positive');
  }

  const decision = await decideOpenADRParticipation(event);
  const firstInterval = event.signals[0]?.intervals[0];

  await db
    .insert(gridProtocolInstructions)
    .values({
      source: 'openadr',
      externalId: event.eventId,
      modificationNumber: event.modificationNumber,
      programRef: event.marketContext,
      eventStatus: event.status,
      priority: event.priority,
      startTime: start,
      durationSeconds: event.durationSeconds,
      targetPercent:
        firstInterval && event.signals[0]?.type === 'level'
          ? Math.round(firstInterval.value * 100)
          : null,
      decision: decision.optType === 'optIn' ? 'opt_in' : 'opt_out',
      decisionReason: decision.reason,
      payload: JSON.stringify(event),
    })
    .onDuplicateKeyUpdate({
      set: {
        eventStatus: event.status,
        decision: decision.optType === 'optIn' ? 'opt_in' : 'opt_out',
        decisionReason: decision.reason,
        payload: JSON.stringify(event),
      },
    });

  return decision;
}

async function decideOpenADRParticipation(event: OpenADREvent): Promise<OpenADRDecision> {
  if (event.status === 'cancelled') {
    return { optType: 'optOut', reason: 'event cancelled by the VTN' };
  }
  if (event.testEvent) {
    return { optType: 'optIn', reason: 'test event acknowledged without dispatch' };
  }
  if (event.signals.length === 0) {
    return { optType: 'optOut', reason: 'event carries no signal to follow' };
  }

  const db = await requireDb();
  const enrolled = await db
    .select({ count: sql<number>`count(*)` })
    .from(drParticipants)
    .where(and(eq(drParticipants.status, 'active'), eq(drParticipants.autoOptIn, true)));
  const participants = Number(enrolled[0]?.count ?? 0);
  if (participants === 0) {
    return {
      optType: 'optOut',
      reason: 'no enrolled demand response participants available to dispatch',
    };
  }
  return {
    optType: 'optIn',
    reason: `${participants} enrolled demand response participants available`,
  };
}

// ============================ IEEE 2030.5 ============================

export interface Sep2Control {
  mrid: string;
  programMrid: string;
  status: number;
  primacy: number;
  start: string;
  durationSeconds: number;
  targetWatts?: number;
  maxLimitPercent?: number;
  fixedPercent?: number;
}

/**
 * Records DER controls received from a IEEE 2030.5 server. Controls are stored
 * as received; they are not marked as followed, because acknowledgement of a
 * control is not evidence that any DER changed its output.
 */
export async function handleSep2Controls(controls: Sep2Control[]): Promise<{ stored: number }> {
  if (controls.length === 0) {
    return { stored: 0 };
  }
  const db = await requireDb();
  let stored = 0;
  for (const control of controls) {
    const start = parseTimestamp(control.start, 'start');
    if (control.durationSeconds <= 0) {
      throw new GridProtocolError(400, `control ${control.mrid} has a non-positive duration`);
    }
    const percent = control.maxLimitPercent ?? control.fixedPercent;
    if (control.targetWatts === undefined && percent === undefined) {
      throw new GridProtocolError(
        400,
        `control ${control.mrid} carries no supported setpoint`
      );
    }
    await db
      .insert(gridProtocolInstructions)
      .values({
        source: 'sep2',
        externalId: control.mrid,
        modificationNumber: 0,
        programRef: control.programMrid,
        eventStatus: String(control.status),
        priority: control.primacy,
        startTime: start,
        durationSeconds: control.durationSeconds,
        targetWatts:
          control.targetWatts === undefined ? null : Math.round(control.targetWatts),
        targetPercent: percent === undefined ? null : Math.round(percent * 100),
        decision: 'recorded',
        decisionReason: 'DER control recorded for dispatch evaluation',
        payload: JSON.stringify(control),
      })
      .onDuplicateKeyUpdate({
        set: {
          eventStatus: String(control.status),
          startTime: start,
          durationSeconds: control.durationSeconds,
          payload: JSON.stringify(control),
        },
      });
    stored += 1;
  }
  return { stored };
}

// ============================ Modbus ============================

export interface ModbusReading {
  device_id: string;
  name: string;
  value: number;
  unit: string;
  address: number;
  timestamp_ms: number;
}

/**
 * Stores Modbus readings as telemetry for the asset the device is registered
 * to. Readings from unregistered devices are rejected rather than dropped, so
 * a misconfigured poller is visible instead of silently producing no data.
 */
export async function handleModbusReadings(
  readings: ModbusReading[]
): Promise<{ stored: number }> {
  if (readings.length === 0) {
    return { stored: 0 };
  }
  const db = await requireDb();
  const byDevice = new Map<string, ModbusReading[]>();
  for (const reading of readings) {
    if (!Number.isFinite(reading.value)) {
      throw new GridProtocolError(400, `reading ${reading.name} is not a finite number`);
    }
    const list = byDevice.get(reading.device_id);
    if (list) list.push(reading);
    else byDevice.set(reading.device_id, [reading]);
  }

  let stored = 0;
  for (const [deviceId, deviceReadings] of byDevice) {
    const rows = await db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, deviceId))
      .limit(1);
    const device = rows[0];
    if (!device) {
      throw new GridProtocolError(
        404,
        `device ${deviceId} is not registered; its readings cannot be attributed to an asset`
      );
    }
    if (!device.enabled) {
      throw new GridProtocolError(409, `device ${deviceId} is disabled`);
    }

    const measurement = mapReadings(deviceReadings);
    const timestamp = new Date(
      Math.max(...deviceReadings.map(reading => reading.timestamp_ms))
    );
    await db.insert(telemetry).values({
      assetId: device.assetId,
      timestamp,
      ...measurement,
      metadata: JSON.stringify({
        source: 'modbus',
        deviceId,
        registers: deviceReadings.map(reading => ({
          name: reading.name,
          address: reading.address,
          value: reading.value,
          unit: reading.unit,
        })),
      }),
    });
    await db
      .update(devices)
      .set({ status: 'online', lastSeen: timestamp, lastMessageAt: timestamp })
      .where(eq(devices.id, device.id));
    stored += deviceReadings.length;
  }
  return { stored };
}

/**
 * Maps register names to telemetry columns. Only registers whose unit matches
 * the column's unit are mapped; anything else stays in the metadata rather than
 * being coerced into a settlement-relevant column.
 */
function mapReadings(readings: ModbusReading[]): {
  power?: number;
  energy?: number;
  voltage?: number;
  current?: number;
  frequency?: number;
  stateOfCharge?: number;
  temperature?: number;
} {
  const measurement: Record<string, number> = {};
  for (const reading of readings) {
    switch (reading.unit) {
      case 'W':
        if (reading.name.includes('power')) measurement.power = Math.round(reading.value);
        break;
      case 'Wh':
        if (reading.name.includes('energy')) measurement.energy = Math.round(reading.value);
        break;
      case 'V':
        measurement.voltage = Math.round(reading.value * 1000);
        break;
      case 'A':
        measurement.current = Math.round(reading.value * 1000);
        break;
      case 'Hz':
        measurement.frequency = Math.round(reading.value * 1000);
        break;
      case '%':
        if (reading.name.includes('soc')) measurement.stateOfCharge = Math.round(reading.value * 100);
        break;
      case 'C':
        measurement.temperature = Math.round(reading.value * 100);
        break;
      default:
        break;
    }
  }
  return measurement;
}

/** Exported for tests: the readings-to-telemetry mapping is settlement input. */
export const __testables = { mapReadings, decideOpenADRParticipation, toSocPercent };
