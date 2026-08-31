import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MeterReadoutError,
  buildSignOnRequest,
  computeBcc,
  parseIdentification,
  readIec62056,
} from './iec62056-client';
import {
  ingestMeterReadout,
  mapMeterRegistersToTelemetry,
  readMeter,
} from './meter-readout-service';

/**
 * The fake meter is a real TCP server scripted to speak IEC 62056-21 Mode C:
 * it waits for the sign-on request, answers with an identification message,
 * waits for the ACK and returns a data block with a correctly computed BCC.
 * Corrupt-BCC and never-answering variants exercise the rejection paths.
 */

const STX = 0x02;
const ETX = 0x03;
const ACK = 0x06;

const IDENTIFICATION = '/LGZ5ZMD1104407.B11\r\n';

const HAPPY_LINES = [
  '1.8.0(001234.567*kWh)',
  '2.8.0(000012.345*kWh)',
  '16.7.0(004.321*kW)',
  '14.7.0(50.01*Hz)',
  '32.7.0(231.4*V)',
  '31.7.0(012.3*A)',
  '0.0(0424711)',
  'F.F(00000000)',
];

function bccOf(block: Buffer): number {
  let bcc = 0;
  for (const byte of block) bcc ^= byte;
  return bcc;
}

/** STX + lines + "!"+CRLF + ETX + BCC, BCC computed over (after STX..ETX). */
function buildDataMessage(lines: string[], corruptBcc = false): Buffer {
  const payload = Buffer.from(`${lines.join('\r\n')}\r\n!\r\n`, 'latin1');
  const covered = Buffer.concat([payload, Buffer.from([ETX])]);
  const bcc = corruptBcc ? bccOf(covered) ^ 0xff : bccOf(covered);
  return Buffer.concat([Buffer.from([STX]), covered, Buffer.from([bcc])]);
}

interface FakeMeterOptions {
  /** Answer the sign-on at all? false → the meter never speaks (timeout test). */
  answerSignOn?: boolean;
  corruptBcc?: boolean;
  lines?: string[];
}

const openServers: Server[] = [];

function startFakeMeter(options: FakeMeterOptions = {}): Promise<number> {
  const { answerSignOn = true, corruptBcc = false, lines = HAPPY_LINES } = options;
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      socket.setEncoding('latin1');
      let stage: 'signon' | 'ack' = 'signon';
      socket.on('data', (data: string) => {
        if (stage === 'signon') {
          if (!data.endsWith('!\r\n')) return;
          stage = 'ack';
          if (answerSignOn) socket.write(IDENTIFICATION, 'latin1');
        } else if (data.charCodeAt(0) === ACK) {
          socket.write(buildDataMessage(lines, corruptBcc));
        }
      });
    });
    openServers.push(server);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('fake meter has no port'));
    });
  });
}

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const FAST = { connectMs: 2000, signonMs: 300, readoutMs: 2000 };

describe('iec62056-client framing helpers', () => {
  it('builds the sign-on request with and without a device address', () => {
    expect(buildSignOnRequest().toString('latin1')).toBe('/?!\r\n');
    expect(buildSignOnRequest('12345678').toString('latin1')).toBe('/?12345678!\r\n');
  });

  it('parses the identification message into manufacturer and baud capability', () => {
    const ident = parseIdentification(Buffer.from(IDENTIFICATION, 'latin1'));
    expect(ident.manufacturer).toBe('LGZ');
    expect(ident.baudChar).toBe('5');
    expect(ident.maxBaudRate).toBe(9600);
    expect(ident.identification).toBe('ZMD1104407.B11');
  });

  it('computes the BCC as the XOR of the covered bytes', () => {
    expect(computeBcc(Buffer.from([0x10, 0x20, 0x04]))).toBe(0x34);
  });
});

describe('iec62056-client readout over a fake meter', () => {
  it('(a) reads a happy-path readout with >= 6 typed OBIS registers', async () => {
    const port = await startFakeMeter();
    const result = await readIec62056({ host: '127.0.0.1', port, timeouts: FAST });

    expect(result.identification.manufacturer).toBe('LGZ');
    expect(result.identification.maxBaudRate).toBe(9600);
    expect(result.malformedLines).toEqual([]);
    expect(result.registers.length).toBeGreaterThanOrEqual(6);

    const byObis = new Map(result.registers.map(r => [r.obis, r]));
    expect(byObis.get('1.8.0')).toMatchObject({ value: 1234.567, unit: 'kWh' });
    expect(byObis.get('2.8.0')).toMatchObject({ value: 12.345, unit: 'kWh' });
    expect(byObis.get('16.7.0')).toMatchObject({ value: 4.321, unit: 'kW' });
    expect(byObis.get('14.7.0')).toMatchObject({ value: 50.01, unit: 'Hz' });
    expect(byObis.get('32.7.0')).toMatchObject({ value: 231.4, unit: 'V' });
    expect(byObis.get('31.7.0')).toMatchObject({ value: 12.3, unit: 'A' });
    expect(byObis.get('0.0')).toMatchObject({ value: 424711, unit: undefined });
    expect(byObis.get('F.F')).toMatchObject({ value: 0, unit: undefined });
    expect(result.readAt).toBeInstanceOf(Date);
  });

  it('(b) rejects a corrupt-BCC readout and returns no partial data', async () => {
    const port = await startFakeMeter({ corruptBcc: true });
    let caught: unknown;
    try {
      await readIec62056({ host: '127.0.0.1', port, timeouts: FAST });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeterReadoutError);
    expect((caught as MeterReadoutError).reason).toBe('bcc_mismatch');
    expect((caught as MeterReadoutError).message).toContain('nothing is stored');
  });

  it('(c) times out with timeout_signon when the meter never answers', async () => {
    const port = await startFakeMeter({ answerSignOn: false });
    let caught: unknown;
    try {
      await readIec62056({ host: '127.0.0.1', port, timeouts: FAST });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeterReadoutError);
    expect((caught as MeterReadoutError).reason).toBe('timeout_signon');
  });

  it('(c2) fails with a connect error when nothing listens', async () => {
    let caught: unknown;
    try {
      await readIec62056({ host: '127.0.0.1', port: 1, timeouts: FAST });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeterReadoutError);
    expect((caught as MeterReadoutError).reason).toMatch(/^connect_error:/);
  });

  it('(d) keeps parsed registers and reports a malformed line with its reason', async () => {
    const port = await startFakeMeter({
      lines: ['1.8.0(001234.567*kWh)', 'THIS IS NOT OBIS', '16.7.0(004.321*kW)'],
    });
    const result = await readIec62056({ host: '127.0.0.1', port, timeouts: FAST });

    expect(result.registers.map(r => r.obis)).toEqual(['1.8.0', '16.7.0']);
    expect(result.malformedLines).toEqual([
      {
        line: 2,
        content: 'THIS IS NOT OBIS',
        reason: 'malformed_line:expected <obis>(<value>[*<unit>])',
      },
    ]);
  });

  it('(d2) reports a non-numeric value as malformed with the value in the reason', async () => {
    const port = await startFakeMeter({
      lines: ['1.8.0(001234.567*kWh)', '9.9.9(notanumber*kWh)'],
    });
    const result = await readIec62056({ host: '127.0.0.1', port, timeouts: FAST });
    expect(result.registers.map(r => r.obis)).toEqual(['1.8.0']);
    expect(result.malformedLines[0].line).toBe(2);
    expect(result.malformedLines[0].reason).toBe('malformed_line:non_numeric_value:notanumber');
  });
});

describe('meter-readout-service', () => {
  it('readMeter returns registers, identification and readAt', async () => {
    const port = await startFakeMeter();
    const readout = await readMeter({ host: '127.0.0.1', port, meterId: 'MD-001', timeouts: FAST });
    expect(readout.registers.length).toBeGreaterThanOrEqual(6);
    expect(readout.identification.manufacturer).toBe('LGZ');
    expect(readout.readAt).toBeInstanceOf(Date);
    expect(readout.malformedLines).toEqual([]);
  });

  it('(e) maps 1.8.0/16.7.0 into the telemetry shape and keeps unknown OBIS in raw', async () => {
    const port = await startFakeMeter();
    const readout = await readMeter({ host: '127.0.0.1', port, meterId: 'MD-001', timeouts: FAST });
    const { row, raw } = mapMeterRegistersToTelemetry(
      readout.registers,
      readout.readAt,
      'MD-001'
    );

    // Telemetry units per the schema: Wh, W, mV, mA, mHz.
    expect(row.timestamp).toBe(readout.readAt);
    expect(row.energy).toBe(1234567); // 1234.567 kWh → Wh
    expect(row.power).toBe(4321); // 4.321 kW → W
    expect(row.voltage).toBe(231400); // 231.4 V → mV (phase L1)
    expect(row.current).toBe(12300); // 12.3 A → mA (phase L1)
    expect(row.frequency).toBe(50010); // 50.01 Hz → mHz

    const metadata = JSON.parse(row.metadata);
    expect(metadata.source).toBe('iec62056');
    expect(metadata.meterId).toBe('MD-001');
    expect(metadata.active_energy_export).toBe(12345); // 12.345 kWh → Wh

    // Unknown codes are passed through, never guessed into a semantic slot.
    expect(raw).toEqual([
      { obis: '0.0', value: 424711, unit: undefined, raw: '0.0(0424711)' },
      { obis: 'F.F', value: 0, unit: undefined, raw: 'F.F(00000000)' },
    ]);
  });

  it('moves a known OBIS code with an unconvertible unit into raw with a reason', () => {
    const { row, raw } = mapMeterRegistersToTelemetry(
      [
        {
          obis: '1.8.0',
          value: 10,
          unit: 'kVAh',
          values: [{ value: 10, unit: 'kVAh' }],
          raw: '1.8.0(10*kVAh)',
        },
      ],
      new Date('2026-01-01T00:00:00Z')
    );
    expect(row.energy).toBeUndefined();
    expect(raw[0].reason).toBe('unconvertible_unit:kVAh_for_active_energy_import');
  });

  it('ingestMeterReadout throws database_unavailable when there is no database', async () => {
    const port = await startFakeMeter();
    let caught: unknown;
    try {
      await ingestMeterReadout({
        host: '127.0.0.1',
        port,
        assetId: 1,
        meterId: 'MD-001',
        timeouts: FAST,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeterReadoutError);
    expect((caught as MeterReadoutError).reason).toBe('database_unavailable');
  });

  it('dlms_cosem fails loud with a named error, never a stub', async () => {
    let caught: unknown;
    try {
      await readMeter({ host: '127.0.0.1', port: 1, protocol: 'dlms_cosem' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeterReadoutError);
    expect((caught as MeterReadoutError).reason).toBe(
      'dlms_cosem_not_supported: hdlc_axdr_adapter_missing'
    );
  });
});
