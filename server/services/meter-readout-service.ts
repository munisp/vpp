/**
 * Meter readout service: IEC 62056-21 (Mode C) revenue-meter readouts mapped
 * into the platform's telemetry path.
 *
 * This is the adapter for the meters Nigerian distribution utilities deploy
 * on MV/LV feeders and customer premises. It reads the meter over TCP
 * (serial device server in front of the optical/RS-485 port) using
 * ./iec62056-client, maps well-known OBIS registers into the telemetry shape
 * that server/services/grid-protocol-ingest.ts writes (telemetry table:
 * power in W, energy in Wh, voltage in mV, current in mA, frequency in mHz),
 * and persists through the real ingestion path.
 *
 * Protocol scope and the DLMS/COSEM gap, stated plainly:
 *  - 'iec62056' is fully implemented here (Mode C ASCII readout).
 *  - 'dlms_cosem' is NOT supported by this adapter. DLMS/COSEM meters speak
 *    an HDLC (or wrapper) session protocol with A-XDR-encoded responses; a
 *    correct implementation needs association setup, security material and
 *    obis-object model negotiation that do not fit this pass. Selecting
 *    'dlms_cosem' fails loudly with reason 'dlms_cosem_not_supported: ...'.
 *    Procurement guidance for meters not offering IEC 62056-21 Mode C: either
 *    require IEC 62056-21 readout capability in the tender, or fund a
 *    dedicated DLMS/COSEM adapter. What will never happen is a stub returning
 *    invented registers.
 *
 * Invariants (same discipline as grid-protocol-ingest.ts):
 *  - the database being down is an error, never a dropped readout;
 *  - an unreachable or protocol-violating meter throws a typed
 *    MeterReadoutError; no reading is fabricated;
 *  - OBIS codes we do not know are passed through in `raw`, never dropped
 *    silently and never guessed into a semantic slot;
 *  - lines that fail parsing come back in `malformedLines` with line numbers
 *    and reasons: fail loud, keep the evidence.
 */

import { getDb } from '../db';
import { telemetry } from '../../drizzle/schema';
import { recordObservation } from './degraded-operation';
import {
  MeterReadoutError,
  readIec62056,
  type Iec62056Timeouts,
  type MalformedLine,
  type MeterIdentification,
  type ParsedRegister,
  type ReadoutResult,
} from './iec62056-client';

export { MeterReadoutError } from './iec62056-client';
export type { MalformedLine, MeterIdentification, ParsedRegister } from './iec62056-client';

export type MeterProtocol = 'iec62056' | 'dlms_cosem';

export interface MeterTarget {
  host: string;
  port: number;
  /** IEC 62056-21 device address for multi-drop buses. */
  address?: string;
  /** Asset the readings are booked against; required for ingestion. */
  assetId?: number;
  /** Operator-facing meter identifier, recorded in telemetry metadata. */
  meterId?: string;
  protocol?: MeterProtocol;
  /** Requested baud-rate character for the ACK ('0'..'6'). */
  baudChar?: string;
  timeouts?: Partial<Iec62056Timeouts>;
}

export interface MeterReadout {
  registers: ParsedRegister[];
  identification: MeterIdentification;
  readAt: Date;
  malformedLines: MalformedLine[];
}

/** One telemetry row in the exact units of the telemetry table, plus metadata. */
export interface TelemetryRow {
  timestamp: Date;
  power?: number; // watts
  energy?: number; // watt-hours, cumulative import
  voltage?: number; // millivolts (phase L1; all phases in metadata)
  current?: number; // milliamps (phase L1; all phases in metadata)
  frequency?: number; // millihertz
  metadata: string;
}

/** An OBIS register the mapping does not claim to understand, kept verbatim. */
export interface RawRegister {
  obis: string;
  value: number;
  unit?: string;
  raw: string;
  /** Set when the code is known but the unit cannot be converted honestly. */
  reason?: string;
}

export interface MappedTelemetry {
  row: TelemetryRow;
  raw: RawRegister[];
}

export interface IngestResult {
  rowsWritten: number;
  identification: MeterIdentification;
  readAt: Date;
  raw: RawRegister[];
  malformedLines: MalformedLine[];
}

function requireProtocol(meter: MeterTarget): void {
  const protocol = meter.protocol ?? 'iec62056';
  if (protocol === 'dlms_cosem') {
    throw new MeterReadoutError(
      'dlms_cosem_not_supported: hdlc_axdr_adapter_missing',
      'DLMS/COSEM meters require an HDLC/A-XDR adapter that this platform does not ' +
        'have yet. Either procure IEC 62056-21 (Mode C) capable meters or fund the ' +
        'DLMS/COSEM adapter; no reading is fabricated in the meantime.'
    );
  }
}

/**
 * Reads one meter and returns the parsed registers. Nothing is stored here;
 * ingestion is a separate, explicit step so callers can inspect first.
 */
export async function readMeter(meter: MeterTarget): Promise<MeterReadout> {
  requireProtocol(meter);
  const result: ReadoutResult = await readIec62056({
    host: meter.host,
    port: meter.port,
    address: meter.address,
    baudChar: meter.baudChar,
    timeouts: meter.timeouts,
  });
  return {
    registers: result.registers,
    identification: result.identification,
    readAt: result.readAt,
    malformedLines: result.malformedLines,
  };
}

interface ObisMapping {
  semantic: string;
  /** Telemetry column this register feeds, or null for metadata-only. */
  column: 'energy' | 'power' | 'voltage' | 'current' | 'frequency' | null;
  /** Converts to the column unit, or returns null when the unit is unknown. */
  convert: (value: number, unit: string | undefined) => number | null;
}

function wattHours(value: number, unit: string | undefined): number | null {
  switch (unit) {
    case undefined:
    case 'Wh':
      return Math.round(value);
    case 'kWh':
      return Math.round(value * 1000);
    default:
      return null;
  }
}

function watts(value: number, unit: string | undefined): number | null {
  switch (unit) {
    case undefined:
    case 'W':
      return Math.round(value);
    case 'kW':
      return Math.round(value * 1000);
    default:
      return null;
  }
}

function millivolts(value: number, unit: string | undefined): number | null {
  switch (unit) {
    case undefined:
    case 'V':
      return Math.round(value * 1000);
    case 'mV':
      return Math.round(value);
    default:
      return null;
  }
}

function milliamps(value: number, unit: string | undefined): number | null {
  switch (unit) {
    case undefined:
    case 'A':
      return Math.round(value * 1000);
    case 'mA':
      return Math.round(value);
    default:
      return null;
  }
}

function millihertz(value: number, unit: string | undefined): number | null {
  switch (unit) {
    case undefined:
    case 'Hz':
      return Math.round(value * 1000);
    case 'mHz':
      return Math.round(value);
    default:
      return null;
  }
}

/**
 * Well-known OBIS registers (IEC 62056-61 / IDIS code table) and where they
 * land. Only registers listed here get a semantic slot; a unit this table
 * cannot convert honestly sends the register to `raw` with a reason instead
 * of being coerced.
 */
const OBIS_MAP: Record<string, ObisMapping> = {
  '1.8.0': { semantic: 'active_energy_import', column: 'energy', convert: wattHours },
  '2.8.0': { semantic: 'active_energy_export', column: null, convert: wattHours },
  '15.8.0': { semantic: 'active_energy_absolute', column: null, convert: wattHours },
  '31.7.0': { semantic: 'current_l1', column: 'current', convert: milliamps },
  '51.7.0': { semantic: 'current_l2', column: null, convert: milliamps },
  '71.7.0': { semantic: 'current_l3', column: null, convert: milliamps },
  '32.7.0': { semantic: 'voltage_l1', column: 'voltage', convert: millivolts },
  '52.7.0': { semantic: 'voltage_l2', column: null, convert: millivolts },
  '72.7.0': { semantic: 'voltage_l3', column: null, convert: millivolts },
  '14.7.0': { semantic: 'supply_frequency', column: 'frequency', convert: millihertz },
  '16.7.0': { semantic: 'total_active_power', column: 'power', convert: watts },
};

/**
 * Maps parsed OBIS registers into one telemetry row in the telemetry table's
 * units (W / Wh / mV / mA / mHz). The single voltage/current columns carry
 * phase L1 (the dominant phase on Nigerian single-phase-dominated feeders);
 * all three phases are preserved in metadata. Unknown codes land in `raw`.
 */
export function mapMeterRegistersToTelemetry(
  registers: ParsedRegister[],
  readAt: Date,
  meterId?: string
): MappedTelemetry {
  const row: TelemetryRow = { timestamp: readAt, metadata: '' };
  const raw: RawRegister[] = [];
  const detail: Record<string, number> = {};

  for (const register of registers) {
    const mapping = OBIS_MAP[register.obis];
    if (!mapping) {
      raw.push({
        obis: register.obis,
        value: register.value,
        unit: register.unit,
        raw: register.raw,
      });
      continue;
    }
    const converted = mapping.convert(register.value, register.unit);
    if (converted === null) {
      raw.push({
        obis: register.obis,
        value: register.value,
        unit: register.unit,
        raw: register.raw,
        reason: `unconvertible_unit:${register.unit ?? 'none'}_for_${mapping.semantic}`,
      });
      continue;
    }
    detail[mapping.semantic] = converted;
    if (mapping.column) row[mapping.column] = converted;
  }

  row.metadata = JSON.stringify({
    source: 'iec62056',
    meterId: meterId ?? null,
    ...detail,
  });
  return { row, raw };
}

/**
 * Reads a meter and stores one telemetry sample through the same table and
 * units the Modbus/OCPP ingestion paths use. The database is checked before
 * the meter is touched: when there is nowhere to persist, the readout is not
 * taken and silently lost — the caller gets 'database_unavailable' instead.
 */
export async function ingestMeterReadout(meter: MeterTarget): Promise<IngestResult> {
  requireProtocol(meter);
  if (meter.assetId === undefined) {
    throw new MeterReadoutError(
      'asset_required',
      'assetId is required: meter readings must be attributed to a registered asset, not booked into the void'
    );
  }
  const db = await getDb();
  if (!db) {
    throw new MeterReadoutError(
      'database_unavailable',
      'database unavailable: the meter readout is not taken because there is nowhere to persist it'
    );
  }

  const readout = await readMeter(meter);
  const { row, raw } = mapMeterRegistersToTelemetry(
    readout.registers,
    readout.readAt,
    meter.meterId
  );

  await db.insert(telemetry).values({
    assetId: meter.assetId,
    timestamp: row.timestamp,
    power: row.power ?? null,
    energy: row.energy ?? null,
    voltage: row.voltage ?? null,
    current: row.current ?? null,
    frequency: row.frequency ?? null,
    metadata: JSON.stringify({
      ...JSON.parse(row.metadata),
      ...(raw.length > 0 ? { raw } : {}),
      ...(readout.malformedLines.length > 0 ? { malformedLines: readout.malformedLines } : {}),
    }),
  });

  // A stored meter sample is the only honest evidence the meter path works —
  // the same rule grid-protocol-ingest applies to Modbus readings.
  await recordObservation({
    dependency: 'meter_telemetry',
    observation: 'reachable',
    observedBy: 'server',
    operation: 'iec62056 meter readout stored',
  });

  return {
    rowsWritten: 1,
    identification: readout.identification,
    readAt: readout.readAt,
    raw,
    malformedLines: readout.malformedLines,
  };
}
