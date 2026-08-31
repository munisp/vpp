/**
 * IEC 62056-21 (formerly IEC 61107) Mode C readout client over TCP.
 *
 * Nigerian utility meters (and most electricity meters sold into the region)
 * expose an optical or RS-485 port speaking IEC 62056-21. Over TCP the port
 * sits behind a serial device server, so the byte-level protocol is identical
 * and the baud-rate negotiation is advisory — the bridge applies it to its
 * serial side; the TCP framing here is unaffected.
 *
 * Mode C exchange implemented here:
 *
 *   host  →  "/ ? <addr> ! <CR><LF>"          sign-on (address optional)
 *   meter →  "/ MMM Z <ident> <CR><LF>"       identification (manufacturer,
 *                                            baud capability, ident text)
 *   host  →  <ACK> 0 Z 0 <CR><LF>             ack + baud selection + readout
 *   meter →  <STX> <data lines> ! <CR><LF> <ETX> <BCC>
 *
 * BCC is the XOR of every byte after STX up to and including ETX. A mismatch
 * is a corrupt readout: it is rejected with reason 'bcc_mismatch' and NO
 * partial data is returned, because a meter register that feeds billing must
 * never be a guess reconstructed from a damaged frame.
 *
 * Invariants:
 *  - every socket phase has a timeout; nothing hangs forever;
 *  - connection errors and protocol violations throw typed MeterReadoutError
 *    with machine-readable reason strings;
 *  - nothing is fabricated: a failed read produces an error, not a zero, and
 *    a line that cannot be parsed is reported in malformedLines with its
 *    content and reason, never silently dropped or coerced.
 */

import { Socket } from 'node:net';

export const STX = 0x02;
export const ETX = 0x03;
export const ACK = 0x06;
const CR = 0x0d;
const LF = 0x0a;

/** Reason strings are part of the contract; callers and alerts match on them. */
export class MeterReadoutError extends Error {
  constructor(
    readonly reason: string,
    message?: string
  ) {
    super(message ?? reason);
    this.name = 'MeterReadoutError';
  }
}

/** IEC 62056-21 baud-rate characters from the identification message. */
export const BAUD_RATES: Record<string, number> = {
  '0': 300,
  '1': 600,
  '2': 1200,
  '3': 2400,
  '4': 4800,
  '5': 9600,
  '6': 19200,
};

export interface Iec62056Timeouts {
  connectMs: number;
  /** Waiting for the identification message after the sign-on request. */
  signonMs: number;
  /** Waiting for the data message after the ACK. */
  readoutMs: number;
}

export interface Iec62056Options {
  host: string;
  port: number;
  /** Device address for multi-drop buses; omitted for a point-to-point meter. */
  address?: string;
  /**
   * Baud-rate character to request in the ACK ('0'..'6'). Defaults to the
   * meter's own advertised maximum when it is a standard rate, else '5'
   * (9600 baud). Advisory over TCP; it programs the serial bridge.
   */
  baudChar?: string;
  timeouts?: Partial<Iec62056Timeouts>;
}

export interface MeterIdentification {
  /** Three-letter manufacturer code (e.g. 'LGZ', 'ELS', 'MMX'). */
  manufacturer: string;
  /** Raw baud-rate character from the identification message. */
  baudChar: string;
  /** Maximum baud rate in bit/s, when the character is a standard rate. */
  maxBaudRate: number | null;
  /** Free-form identification text (model/serial as the meter reports it). */
  identification: string;
  /** The raw identification line, kept as evidence. */
  raw: string;
}

export interface ObisValue {
  value: number;
  unit?: string;
}

/**
 * One data-set line from the readout: an OBIS address with one or more
 * parenthesized values, e.g. `1.8.0(001234.567*kWh)`.
 */
export interface ParsedRegister {
  /** OBIS code as printed by the meter, e.g. '1.8.0' or 'F.F'. */
  obis: string;
  /** Numeric value of the first parenthesized group. */
  value: number;
  /** Unit of the first group, when the meter printed one (`value*unit`). */
  unit?: string;
  /** Every parenthesized group, for multi-value entries. */
  values: ObisValue[];
  /** The raw line, kept as evidence. */
  raw: string;
}

export interface MalformedLine {
  /** 1-based line number within the readout block. */
  line: number;
  /** The offending line content. */
  content: string;
  /** Why it was rejected, e.g. 'malformed_line:no_parenthesized_value'. */
  reason: string;
}

export interface ReadoutResult {
  identification: MeterIdentification;
  registers: ParsedRegister[];
  malformedLines: MalformedLine[];
  /** When the ETX+1 bytes of the verified block were received. */
  readAt: Date;
}

const DEFAULT_TIMEOUTS: Iec62056Timeouts = {
  connectMs: 5000,
  signonMs: 5000,
  readoutMs: 30000,
};

/**
 * Buffered byte reader over the socket. Each protocol phase consumes exactly
 * the bytes belonging to it (leftovers stay buffered for the next phase) and
 * carries its own deadline, so a meter that stalls mid-phase fails with the
 * phase name rather than as a generic hang.
 */
class MeterWire {
  private buffer: Buffer = Buffer.alloc(0);
  private socketError: Error | null = null;
  private socketClosed = false;
  private waiter: (() => void) | null = null;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    socket.on('error', err => {
      this.socketError = err;
      this.notify();
    });
    socket.on('close', () => {
      this.socketClosed = true;
      this.notify();
    });
  }

  private notify(): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter();
    }
  }

  private failure(phase: string): MeterReadoutError | null {
    if (this.socketError) {
      return new MeterReadoutError(
        `socket_error:${this.socketError.message}`,
        `socket error during ${phase}: ${this.socketError.message}`
      );
    }
    if (this.socketClosed) {
      return new MeterReadoutError(
        `connection_closed:${phase}`,
        `meter closed the connection during ${phase}`
      );
    }
    return null;
  }

  /**
   * Waits until `consume` reports how many leading bytes belong to the phase
   * (or throws), returning those bytes and keeping the remainder buffered.
   */
  async readPhase(
    phase: string,
    timeoutMs: number,
    consume: (buf: Buffer) => number
  ): Promise<Buffer> {
    for (;;) {
      const consumed = consume(this.buffer);
      if (consumed > 0) {
        const out = this.buffer.subarray(0, consumed);
        this.buffer = this.buffer.subarray(consumed);
        return out;
      }
      const failure = this.failure(phase);
      if (failure) throw failure;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(
            new MeterReadoutError(
              `timeout_${phase}`,
              `meter did not complete the ${phase} phase within ${timeoutMs}ms`
            )
          );
        }, timeoutMs);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

/** Builds the sign-on request: "/ ? <addr> ! CR LF" (space shown in the spec is notation). */
export function buildSignOnRequest(address?: string): Buffer {
  return Buffer.from(`/?${address ?? ''}!\r\n`, 'latin1');
}

/** Builds the acknowledgement message: ACK, protocol control, baud char, mode control, CR LF. */
export function buildAckMessage(baudChar: string): Buffer {
  return Buffer.from([ACK, 0x30, baudChar.charCodeAt(0), 0x30, CR, LF]);
}

/**
 * Parses the identification message "/ MMM Z <ident> CR LF". The manufacturer
 * field is up to three characters; Z is the baud-rate character naming the
 * highest rate the meter supports.
 */
export function parseIdentification(raw: Buffer): MeterIdentification {
  const text = raw.toString('latin1');
  const line = text.replace(/\r\n$/, '');
  const match = /^\/(.{3})(.)(.*)$/.exec(line);
  if (!match) {
    throw new MeterReadoutError(
      'malformed_identification',
      `identification message is not "/<manufacturer><baud><ident>": ${JSON.stringify(line)}`
    );
  }
  const baudChar = match[2];
  return {
    manufacturer: match[1].trim(),
    baudChar,
    maxBaudRate: BAUD_RATES[baudChar] ?? null,
    identification: match[3],
    raw: line,
  };
}

/** XOR of every byte after STX up to and including ETX. */
export function computeBcc(block: Buffer): number {
  let bcc = 0;
  for (const byte of block) bcc ^= byte;
  return bcc;
}

const OBIS_LINE = /^([0-9A-Za-z.*:-]+)\((.*)\)$/;

/**
 * Parses the verified data block into typed registers. Lines that do not
 * parse are collected in malformedLines with their content and reason rather
 * than thrown away — a partially damaged (but checksum-valid) readout keeps
 * its evidence. Empty lines and the terminating '!' are not data and are
 * skipped.
 */
export function parseDataLines(block: Buffer): {
  registers: ParsedRegister[];
  malformedLines: MalformedLine[];
} {
  const text = block.toString('latin1');
  const registers: ParsedRegister[] = [];
  const malformedLines: MalformedLine[] = [];
  const lines = text.split('\r\n');
  for (let i = 0; i < lines.length; i += 1) {
    const content = lines[i];
    const lineNumber = i + 1;
    if (content === '' || content === '!') continue;

    const match = OBIS_LINE.exec(content);
    if (!match || match[1] === '' || !/^[0-9A-Za-z]/.test(match[1])) {
      malformedLines.push({
        line: lineNumber,
        content,
        reason: 'malformed_line:expected <obis>(<value>[*<unit>])',
      });
      continue;
    }
    const obis = match[1];
    const groups: string[] = [];
    const groupRe = /\(([^)]*)\)/g;
    let g: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((g = groupRe.exec(content)) !== null) groups.push(g[1]);
    if (groups.length === 0) {
      malformedLines.push({
        line: lineNumber,
        content,
        reason: 'malformed_line:no_parenthesized_value',
      });
      continue;
    }

    const values: ObisValue[] = [];
    let badReason: string | null = null;
    for (const group of groups) {
      const parts = group.split('*');
      if (parts.length > 2) {
        badReason = `malformed_line:too_many_fields_in_value:${group}`;
        break;
      }
      const value = Number(parts[0]);
      if (parts[0] === '' || !Number.isFinite(value)) {
        badReason = `malformed_line:non_numeric_value:${parts[0]}`;
        break;
      }
      values.push(parts.length === 2 && parts[1] !== '' ? { value, unit: parts[1] } : { value });
    }
    if (badReason) {
      malformedLines.push({ line: lineNumber, content, reason: badReason });
      continue;
    }

    registers.push({
      obis,
      value: values[0].value,
      unit: values[0].unit,
      values,
      raw: content,
    });
  }
  return { registers, malformedLines };
}

function writeAll(socket: Socket, bytes: Buffer, phase: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, err => {
      if (err) {
        reject(
          new MeterReadoutError(
            `socket_error:${err.message}`,
            `could not send the ${phase} message: ${err.message}`
          )
        );
      } else {
        resolve();
      }
    });
  });
}

/**
 * Performs one full Mode C readout: sign-on, identification, ACK with baud
 * selection, then the checksum-verified data block.
 *
 * The data block is verified (BCC) before any line is parsed, so a corrupt
 * frame yields 'bcc_mismatch' and no registers — never partial data from a
 * frame the meter did not actually send.
 */
export async function readIec62056(options: Iec62056Options): Promise<ReadoutResult> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new MeterReadoutError('invalid_options', `port ${options.port} is not a TCP port`);
  }
  const timeouts: Iec62056Timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

  const socket = new Socket();
  socket.setNoDelay(true);

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new MeterReadoutError(
            'timeout_connect',
            `no TCP connection to ${options.host}:${options.port} within ${timeouts.connectMs}ms`
          )
        );
      }, timeouts.connectMs);
      socket.connect(options.port, options.host, () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', err => {
        clearTimeout(timer);
        reject(
          new MeterReadoutError(
            `connect_error:${(err as NodeJS.ErrnoException).code ?? err.message}`,
            `could not reach meter at ${options.host}:${options.port}: ${err.message}`
          )
        );
      });
    });

    const wire = new MeterWire(socket);

    // 1. Sign-on request, then the identification message (one CRLF line).
    await writeAll(socket, buildSignOnRequest(options.address), 'sign-on request');
    const identRaw = await wire.readPhase('signon', timeouts.signonMs, buf => {
      const end = buf.indexOf(LF);
      return end >= 0 ? end + 1 : 0;
    });
    const identification = parseIdentification(identRaw);

    // 2. ACK: data readout (protocol control '0'), requested baud, mode '0'.
    const baudChar =
      options.baudChar ?? (BAUD_RATES[identification.baudChar] ? identification.baudChar : '5');
    await writeAll(socket, buildAckMessage(baudChar), 'acknowledgement');

    // 3. Data message: STX ... ETX BCC.
    const frame = await wire.readPhase('readout', timeouts.readoutMs, buf => {
      const etx = buf.indexOf(ETX);
      return etx >= 0 && buf.length >= etx + 2 ? etx + 2 : 0;
    });
    const readAt = new Date();

    if (frame[0] !== STX) {
      throw new MeterReadoutError(
        'malformed_readout:no_stx',
        'data message does not start with STX'
      );
    }
    const etxIndex = frame.length - 2;
    if (frame[etxIndex] !== ETX) {
      throw new MeterReadoutError(
        'malformed_readout:no_etx',
        'data message does not end with ETX'
      );
    }
    const payload = frame.subarray(1, etxIndex + 1); // after STX, through ETX
    const receivedBcc = frame[frame.length - 1];
    const computedBcc = computeBcc(payload);
    if (computedBcc !== receivedBcc) {
      throw new MeterReadoutError(
        'bcc_mismatch',
        `readout checksum mismatch: meter sent BCC 0x${receivedBcc
          .toString(16)
          .padStart(2, '0')}, computed 0x${computedBcc
          .toString(16)
          .padStart(2, '0')} over the block; the readout is rejected and nothing is stored`
      );
    }

    const { registers, malformedLines } = parseDataLines(payload.subarray(0, payload.length - 1));
    return { identification, registers, malformedLines, readAt };
  } finally {
    socket.destroy();
  }
}
