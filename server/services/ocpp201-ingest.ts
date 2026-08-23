/**
 * OCPP 2.0.1 ingest.
 *
 * The Go CSMS in services/grid-protocols speaks the wire protocol; every
 * decision that attributes energy to a session, and therefore to money, is made
 * here against the database.
 *
 * 2.0.1 differs from 1.6 in one way that matters most to this file: the charging
 * station owns transaction identity. It generates an opaque transaction id and
 * reports Started/Updated/Ended events against it, so the platform maps that id
 * onto a session row instead of handing an id out. Consequences enforced below:
 *
 *  - a session is only created by a `Started` event from the station;
 *  - events carry a monotonic `seqNo` per transaction, and a station that was
 *    offline replays what it buffered, so an event at or below the last seqNo
 *    already applied is acknowledged and not applied twice;
 *  - an `offline` event is real evidence of what happened, but not evidence of
 *    the state now, so it updates energy and never the station's live status.
 */

import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { chargingSessions, chargingStations } from '../../drizzle/nextgen-vpp-schema';
import { ocppIdTags } from '../../drizzle/grid-protocol-schema';
import {
  GridProtocolError,
  parseTimestamp,
  requireDb,
  requireStation,
  safeParse,
} from './grid-protocol-ingest';

/**
 * ConnectorStatusEnumType (OCPP 2.0.1 part 2). This is a different, smaller set
 * than 1.6's connector statuses, so the 1.6 map is deliberately not reused: it
 * has no `Occupied`, and it would accept 1.6-only values a 2.0.1 station must
 * never send.
 */
export const OCPP201_CONNECTOR_STATUS_MAP: Record<
  string,
  'available' | 'occupied' | 'charging' | 'faulted' | 'offline'
> = {
  Available: 'available',
  Occupied: 'occupied',
  Reserved: 'occupied',
  Unavailable: 'offline',
  Faulted: 'faulted',
};

/** IdTokenInfoType status values (OCPP 2.0.1 part 2, AuthorizationStatusEnumType). */
export type AuthorizationStatus =
  | 'Accepted'
  | 'Blocked'
  | 'ConcurrentTx'
  | 'Expired'
  | 'Invalid'
  | 'NoCredit'
  | 'NotAllowedTypeEVSE'
  | 'NotAtThisLocation'
  | 'NotAtThisTime'
  | 'Unknown';

export interface IdTokenInfo {
  status: AuthorizationStatus;
  cacheExpiryDateTime?: string;
}

export interface IdToken201 {
  idToken: string;
  type: string;
}

export interface BootNotification201 {
  reason: string;
  chargingStation: {
    vendorName: string;
    model: string;
    serialNumber?: string;
    firmwareVersion?: string;
  };
}

export async function handleBootNotification201(
  stationId: string,
  req: BootNotification201
): Promise<{ status: 'Accepted'; currentTime: string; interval: number }> {
  const station = await requireStation(stationId);
  const db = await requireDb();
  await db
    .update(chargingStations)
    .set({
      status: 'available',
      lastHeartbeat: new Date(),
      ocppVersion: '2.0.1',
      metadata: JSON.stringify({
        vendor: req.chargingStation.vendorName,
        model: req.chargingStation.model,
        serialNumber: req.chargingStation.serialNumber ?? null,
        firmwareVersion: req.chargingStation.firmwareVersion ?? null,
        bootReason: req.reason,
      }),
    })
    .where(eq(chargingStations.id, station.id));

  return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
}

export async function handleHeartbeat201(stationId: string): Promise<{ currentTime: string }> {
  const station = await requireStation(stationId);
  const db = await requireDb();
  await db
    .update(chargingStations)
    .set({ lastHeartbeat: new Date() })
    .where(eq(chargingStations.id, station.id));
  return { currentTime: new Date().toISOString() };
}

export interface StatusNotification201 {
  timestamp: string;
  connectorStatus: string;
  evseId: number;
  connectorId: number;
}

/**
 * 2.0.1 reports status per EVSE and connector while `charging_stations` carries
 * one status per station, so the EVSE and connector are kept in metadata rather
 * than discarded: a two-EVSE station's reports are otherwise indistinguishable.
 */
export async function handleStatusNotification201(
  stationId: string,
  req: StatusNotification201
): Promise<void> {
  const station = await requireStation(stationId);
  const mapped = OCPP201_CONNECTOR_STATUS_MAP[req.connectorStatus];
  if (!mapped) {
    throw new GridProtocolError(400, `unknown OCPP 2.0.1 connector status ${req.connectorStatus}`);
  }
  const reportedAt = parseTimestamp(req.timestamp, 'timestamp');
  const db = await requireDb();
  await db
    .update(chargingStations)
    .set({
      status: mapped,
      lastHeartbeat: new Date(),
      metadata: JSON.stringify({
        ...(safeParse(station.metadata) ?? {}),
        lastConnectorStatus: {
          evseId: req.evseId,
          connectorId: req.connectorId,
          status: req.connectorStatus,
          reportedAt: reportedAt.toISOString(),
        },
      }),
    })
    .where(eq(chargingStations.id, station.id));
}

/**
 * Resolves an id token against the database. 2.0.1 tokens are typed, and the
 * type is part of the credential: the same digits presented as a `Central`
 * token are not the RFID card, so the type is recorded with the decision and an
 * unknown token is `Unknown` rather than accepted.
 */
export async function authorizeIdToken201(token: IdToken201): Promise<IdTokenInfo> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(ocppIdTags)
    .where(eq(ocppIdTags.idTag, token.idToken))
    .limit(1);
  const tag = rows[0];
  if (!tag) {
    return { status: 'Unknown' };
  }
  if (tag.status === 'blocked') return { status: 'Blocked' };
  if (tag.status === 'invalid') return { status: 'Invalid' };
  if (tag.status === 'expired') return { status: 'Expired' };
  if (tag.expiryDate && tag.expiryDate.getTime() <= Date.now()) {
    return { status: 'Expired', cacheExpiryDateTime: tag.expiryDate.toISOString() };
  }
  return {
    status: 'Accepted',
    cacheExpiryDateTime: tag.expiryDate ? tag.expiryDate.toISOString() : undefined,
  };
}

export interface SampledValue201 {
  value: number;
  measurand?: string;
  context?: string;
  unitOfMeasure?: { unit?: string; multiplier?: number };
  signedMeterValue?: {
    signedMeterData: string;
    signingMethod: string;
    encodingMethod: string;
    publicKey?: string;
  };
}

export interface MeterValue201 {
  timestamp: string;
  sampledValue: SampledValue201[];
}

export interface MeterValues201 {
  evseId: number;
  meterValue: MeterValue201[];
}

/**
 * MeterValues outside a transaction cannot be attributed to a session, and this
 * platform settles per session. Recording it against the station would create
 * energy with no counterparty, so it is refused loudly instead.
 */
export async function handleMeterValues201(
  stationId: string,
  _req: MeterValues201
): Promise<never> {
  await requireStation(stationId);
  throw new GridProtocolError(
    409,
    'OCPP 2.0.1 MeterValues carries no transaction; in-transaction metering must arrive as TransactionEvent'
  );
}

export interface TransactionEvent201 {
  eventType: 'Started' | 'Updated' | 'Ended';
  timestamp: string;
  triggerReason: string;
  seqNo: number;
  offline?: boolean;
  transactionInfo: {
    transactionId: string;
    chargingState?: string;
    stoppedReason?: string;
    remoteStartId?: number;
  };
  evse?: { id: number; connectorId?: number };
  idToken?: IdToken201;
  meterValue?: MeterValue201[];
}

export interface TransactionEventResult {
  idTokenInfo?: IdTokenInfo;
}

/**
 * Applies one transaction event.
 *
 * `Started` opens the session, `Updated` books metered energy against it and
 * `Ended` closes it. The station's transaction id is stored verbatim in the
 * session metadata; `session_id` is a deterministic 64-character mapping of it,
 * because `charging_sessions.session_id` cannot hold every station id and
 * prefix.
 */
export async function handleTransactionEvent201(
  stationId: string,
  req: TransactionEvent201
): Promise<TransactionEventResult> {
  const station = await requireStation(stationId);
  const db = await requireDb();
  const sessionKey = transactionSessionKey(stationId, req.transactionInfo.transactionId);

  const existingRows = await db
    .select()
    .from(chargingSessions)
    .where(eq(chargingSessions.sessionId, sessionKey))
    .limit(1);
  const existing = existingRows[0];

  const idTokenInfo = req.idToken ? await authorizeIdToken201(req.idToken) : undefined;

  if (req.eventType === 'Started') {
    if (existing) {
      // A replayed Started event: the session already exists, so re-opening it
      // would double-count the transaction.
      return idTokenInfo ? { idTokenInfo } : {};
    }
    if (!req.idToken || !idTokenInfo) {
      throw new GridProtocolError(
        409,
        'a transaction started without an idToken cannot be attributed to a customer'
      );
    }
    if (idTokenInfo.status !== 'Accepted') {
      throw new GridProtocolError(
        403,
        `idToken is not authorized to start a transaction (${idTokenInfo.status})`
      );
    }
    const tagRows = await db
      .select()
      .from(ocppIdTags)
      .where(eq(ocppIdTags.idTag, req.idToken.idToken))
      .limit(1);
    const tag = tagRows[0];
    if (!tag?.evId) {
      throw new GridProtocolError(
        409,
        'idToken has no vehicle assigned; a session cannot be attributed'
      );
    }

    const startedAt = parseTimestamp(req.timestamp, 'timestamp');
    const registerWh = latestRegisterWh(req.meterValue);
    await db.insert(chargingSessions).values({
      evId: tag.evId,
      stationId: station.id,
      userId: tag.userId,
      sessionId: sessionKey,
      startTime: startedAt,
      energyDeliveredWh: 0,
      energyExportedWh: 0,
      sessionType: station.v2gCapable ? 'v2g' : 'standard_charge',
      status: 'charging',
      metadata: JSON.stringify({
        ocppVersion: '2.0.1',
        stationTransactionId: req.transactionInfo.transactionId,
        idToken: req.idToken.idToken,
        idTokenType: req.idToken.type,
        evseId: req.evse?.id ?? null,
        connectorId: req.evse?.connectorId ?? null,
        remoteStartId: req.transactionInfo.remoteStartId ?? null,
        // Absent until the station reports a register reading: energy is derived
        // from the station's own registers, never assumed to start at zero.
        meterStartWh: registerWh,
        lastSeqNo: req.seqNo,
        lastEventOffline: req.offline === true,
      }),
    });
    return { idTokenInfo };
  }

  if (!existing) {
    throw new GridProtocolError(
      404,
      `transaction ${req.transactionInfo.transactionId} has no session on charge point ${stationId}; ` +
        'the Started event was never received'
    );
  }
  if (existing.stationId !== station.id) {
    throw new GridProtocolError(
      404,
      `transaction ${req.transactionInfo.transactionId} does not belong to charge point ${stationId}`
    );
  }

  const metadata = safeParse(existing.metadata) ?? {};
  const lastSeqNo = typeof metadata.lastSeqNo === 'number' ? metadata.lastSeqNo : -1;
  if (req.seqNo <= lastSeqNo) {
    // Replayed event: already applied. Acknowledged so the station stops
    // retrying, but not applied a second time.
    return idTokenInfo ? { idTokenInfo } : {};
  }
  if (existing.endTime && req.eventType === 'Ended') {
    return idTokenInfo ? { idTokenInfo } : {};
  }

  const meterStartWh = typeof metadata.meterStartWh === 'number' ? metadata.meterStartWh : null;
  const registerWh = latestRegisterWh(req.meterValue);
  const powerW = latestPowerW(req.meterValue);
  const soc = latestSoc(req.meterValue);

  const energy =
    registerWh !== null && meterStartWh !== null
      ? {
          energyDeliveredWh: registerWh - meterStartWh >= 0 ? registerWh - meterStartWh : 0,
          energyExportedWh: registerWh - meterStartWh < 0 ? meterStartWh - registerWh : 0,
        }
      : {};

  await db
    .update(chargingSessions)
    .set({
      ...energy,
      ...(powerW === null ? {} : { maxPowerKw: Math.round(Math.abs(powerW) / 100) }),
      ...(soc === null ? {} : { endSocPercent: soc }),
      ...(req.eventType === 'Ended'
        ? { endTime: parseTimestamp(req.timestamp, 'timestamp'), status: 'completed' as const }
        : // An offline event is late evidence: it must not present a buffered
          // reading as the station's state now.
          req.offline === true
          ? {}
          : { status: chargingStateToStatus(req.transactionInfo.chargingState, powerW) }),
      metadata: JSON.stringify({
        ...metadata,
        // Recorded on the first event that carries a register reading, so a
        // station that started without one still yields a real delta.
        meterStartWh: meterStartWh ?? registerWh,
        lastSeqNo: req.seqNo,
        lastEventOffline: req.offline === true,
        ...(req.eventType === 'Ended'
          ? { stoppedReason: req.transactionInfo.stoppedReason ?? null }
          : {}),
        ...(signedMeterValues(req.meterValue).length > 0
          ? // Forwarded verbatim and unverified: this platform does not check the
            // station's signature and must not imply that it did.
            { signedMeterValuesUnverified: signedMeterValues(req.meterValue) }
          : {}),
      }),
    })
    .where(eq(chargingSessions.id, existing.id));

  return idTokenInfo ? { idTokenInfo } : {};
}

function chargingStateToStatus(
  chargingState: string | undefined,
  powerW: number | null
): 'charging' | 'discharging' | 'paused' {
  if (powerW !== null && powerW < 0) return 'discharging';
  switch (chargingState) {
    case 'Charging':
      return 'charging';
    case 'SuspendedEV':
    case 'SuspendedEVSE':
    case 'Idle':
      return 'paused';
    default:
      return 'charging';
  }
}

/**
 * Maps a station-owned transaction id onto `charging_sessions.session_id`.
 * Truncation would collide two transactions onto one session, so the station id
 * and transaction id are hashed; both are stored verbatim in the metadata.
 */
export function transactionSessionKey(stationId: string, transactionId: string): string {
  const digest = createHash('sha256')
    .update(stationId)
    .update('\u0000')
    .update(transactionId)
    .digest('hex');
  return `ocpp201:${digest.slice(0, 48)}`;
}

function scaled(sample: SampledValue201): number {
  const multiplier = sample.unitOfMeasure?.multiplier;
  if (multiplier === undefined) return sample.value;
  if (!Number.isInteger(multiplier)) {
    throw new GridProtocolError(400, 'unitOfMeasure.multiplier must be an integer power of ten');
  }
  return sample.value * 10 ** multiplier;
}

function pick(
  meterValues: MeterValue201[] | undefined,
  measurand: string,
  convert: (sample: SampledValue201) => number
): number | null {
  if (!meterValues) return null;
  let latest: { at: number; value: number } | null = null;
  for (const entry of meterValues) {
    const at = parseTimestamp(entry.timestamp, 'meterValue.timestamp').getTime();
    for (const sample of entry.sampledValue) {
      if ((sample.measurand ?? 'Energy.Active.Import.Register') !== measurand) continue;
      if (!Number.isFinite(sample.value)) {
        throw new GridProtocolError(400, `sampled ${measurand} value is not a finite number`);
      }
      if (!latest || at >= latest.at) {
        latest = { at, value: convert(sample) };
      }
    }
  }
  return latest ? latest.value : null;
}

function latestRegisterWh(meterValues: MeterValue201[] | undefined): number | null {
  const value = pick(meterValues, 'Energy.Active.Import.Register', sample => {
    const scaledValue = scaled(sample);
    switch (sample.unitOfMeasure?.unit) {
      case undefined:
      case 'Wh':
        return scaledValue;
      case 'kWh':
        return scaledValue * 1000;
      default:
        throw new GridProtocolError(400, `unsupported energy unit ${sample.unitOfMeasure?.unit}`);
    }
  });
  return value === null ? null : Math.round(value);
}

function latestPowerW(meterValues: MeterValue201[] | undefined): number | null {
  const value = pick(meterValues, 'Power.Active.Import', sample => {
    const scaledValue = scaled(sample);
    switch (sample.unitOfMeasure?.unit) {
      case undefined:
      case 'W':
        return scaledValue;
      case 'kW':
        return scaledValue * 1000;
      default:
        throw new GridProtocolError(400, `unsupported power unit ${sample.unitOfMeasure?.unit}`);
    }
  });
  return value === null ? null : Math.round(value);
}

function latestSoc(meterValues: MeterValue201[] | undefined): number | null {
  const value = pick(meterValues, 'SoC', sample => scaled(sample));
  if (value === null) return null;
  if (value < 0 || value > 100) {
    throw new GridProtocolError(400, `SoC ${value} is not a percentage`);
  }
  return Math.round(value);
}

function signedMeterValues(
  meterValues: MeterValue201[] | undefined
): Array<{ timestamp: string; signedMeterData: string; signingMethod: string }> {
  if (!meterValues) return [];
  const signed: Array<{ timestamp: string; signedMeterData: string; signingMethod: string }> = [];
  for (const entry of meterValues) {
    for (const sample of entry.sampledValue) {
      if (!sample.signedMeterValue) continue;
      signed.push({
        timestamp: entry.timestamp,
        signedMeterData: sample.signedMeterValue.signedMeterData,
        signingMethod: sample.signedMeterValue.signingMethod,
      });
    }
  }
  return signed;
}
