/**
 * The OpenPAYGO vending boundary.
 *
 * This is the only place in the platform that turns credit into digits a meter
 * will accept. It wraps the reference implementation of the OpenPAYGO Token
 * standard (`openpaygo`, MIT, EnAccess) rather than reimplementing the algorithm,
 * so a token vended here is the same token any other OpenPAYGO vending system
 * would produce for the same device, count and value — which is the entire point
 * of using an open standard: the customer's meter need not have been sold by us.
 *
 * Secret keys are not in the database. Each account names a key in the
 * deployment's keyring (`PREPAID_OPENPAYGO_KEYS`, a JSON object of
 * `keyRef -> 32 hex characters`, or `PREPAID_OPENPAYGO_KEYRING_FILE` pointing at
 * the same JSON). A key that is not configured means this deployment cannot vend
 * for that device, and the caller is told exactly that instead of being handed a
 * code no meter will accept.
 */

import { readFileSync } from 'fs';
import openpaygo from 'openpaygo';
import { tokenValueUnitsFor } from './prepaid-accounting';

// `openpaygo` is CommonJS and assigns its exports from `require` calls, which
// Node's named-export detection for CJS cannot see; the default import is the
// only form that resolves at runtime under this project's ESM output.
const { Encoder, Decoder, TokenTypes } = openpaygo;

/** Why a vend could not happen. Each one is a refusal, never a fabricated token. */
export type VendingRefusal =
  | 'unavailable_no_token_key'
  | 'unavailable_keyring_unreadable'
  | 'unavailable_scheme_not_implemented'
  | 'invalid_device_key';

export class VendingUnavailableError extends Error {
  readonly refusal: VendingRefusal;

  constructor(refusal: VendingRefusal, message: string) {
    super(message);
    this.name = 'VendingUnavailableError';
    this.refusal = refusal;
  }
}

const HEX_KEY = /^[0-9a-fA-F]{32}$/;

interface Keyring {
  keys: Map<string, string>;
  source: string;
}

let cached: Keyring | null = null;

function parseKeyring(raw: string, source: string): Keyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new VendingUnavailableError(
      'unavailable_keyring_unreadable',
      `The OpenPAYGO keyring at ${source} is not readable JSON: ${error instanceof Error ? error.message : 'unknown parse failure'}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new VendingUnavailableError(
      'unavailable_keyring_unreadable',
      `The OpenPAYGO keyring at ${source} must be a JSON object of key reference to 32 hex characters`
    );
  }

  const keys = new Map<string, string>();
  for (const [ref, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || !HEX_KEY.test(value)) {
      throw new VendingUnavailableError(
        'invalid_device_key',
        `The OpenPAYGO key "${ref}" in ${source} is not 32 hexadecimal characters (a 128-bit device key)`
      );
    }
    keys.set(ref, value.toLowerCase());
  }
  return { keys, source };
}

function loadKeyring(): Keyring {
  if (cached) return cached;

  const inline = process.env.PREPAID_OPENPAYGO_KEYS;
  const file = process.env.PREPAID_OPENPAYGO_KEYRING_FILE;

  if (inline && inline.trim().length > 0) {
    cached = parseKeyring(inline, 'PREPAID_OPENPAYGO_KEYS');
    return cached;
  }
  if (file && file.trim().length > 0) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      throw new VendingUnavailableError(
        'unavailable_keyring_unreadable',
        `The OpenPAYGO keyring file ${file} could not be read: ${error instanceof Error ? error.message : 'unknown read failure'}`
      );
    }
    cached = parseKeyring(raw, file);
    return cached;
  }

  cached = { keys: new Map(), source: 'unconfigured' };
  return cached;
}

/** Drops the cached keyring so a rotated key is picked up, and so tests can set one. */
export function resetKeyringCache(): void {
  cached = null;
}

/** Whether this deployment can vend for a device at all. */
export function vendingConfigured(): boolean {
  try {
    return loadKeyring().keys.size > 0;
  } catch {
    return false;
  }
}

function keyFor(keyRef: string): string {
  const keyring = loadKeyring();
  const key = keyring.keys.get(keyRef);
  if (!key) {
    throw new VendingUnavailableError(
      'unavailable_no_token_key',
      `No OpenPAYGO key named "${keyRef}" is configured in this deployment (${keyring.source}), so no token can be vended for that meter`
    );
  }
  return key;
}

export interface VendRequest {
  keyRef: string;
  startingCode: number;
  /** The count last vended for this device; the token is vended at count + 1. */
  lastCount: number;
  energyWh: number;
  whPerValueUnit: number;
}

export interface VendResult {
  tokenCode: string;
  tokenCount: number;
  tokenType: 'ADD_TIME';
  valueUnits: number;
}

/**
 * Vend one token adding value to a device.
 *
 * `ADD_TIME` is the standard's additive token type; on an energy device the value
 * it adds is read in the device's own units, which is why an account must declare
 * a device profile and a watt-hours-per-unit before it can be vended for.
 *
 * Standard (9-digit) tokens only. The library's extended-token path is broken in
 * 0.0.6 — the encoder throws for larger values and its own decoder rejects the
 * tokens it does produce — so a purchase beyond one standard token's range is
 * refused upstream instead of being vended in a form nothing verifies.
 *
 * The value passed to the encoder is already whole (`valueDivider: 1`), so no
 * rounding happens inside the library.
 */
export function vendAddValueToken(request: VendRequest): VendResult {
  const key = keyFor(request.keyRef);
  const valueUnits = tokenValueUnitsFor({
    energyWh: request.energyWh,
    whPerValueUnit: request.whPerValueUnit,
  });

  const encoder = new Encoder();
  const { newCount, finalToken } = encoder.generateToken({
    secretKeyHex: key,
    count: request.lastCount,
    value: valueUnits,
    tokenType: TokenTypes.ADD_TIME,
    startingCode: request.startingCode,
    valueDivider: 1,
    restrictDigitSet: false,
    extendToken: false,
  });

  return {
    tokenCode: finalToken,
    tokenCount: newCount,
    tokenType: 'ADD_TIME',
    valueUnits,
  };
}

export interface MeterAcceptance {
  accepted: boolean;
  /** Device units the token carries, as the device reads it. */
  valueUnits: number | null;
  tokenType: number;
  count: number | null;
  /** Counts the simulated device has now seen, for the next check. */
  usedCounts: number[];
  reason: MeterAcceptanceReason;
}

/**
 * `undecidable` is the reference decoder itself failing (version 0.0.6 carries a
 * Python `return True` in its older-token branch, which throws a
 * `ReferenceError`). A decoder that cannot answer is not a device rejecting the
 * token, and it is certainly not a device accepting it, so it is named as its own
 * outcome rather than folded into `invalid`.
 */
export type MeterAcceptanceReason = 'accepted' | 'already_used' | 'invalid' | 'undecidable';

/**
 * Decode a token the way a device would, given the counts that device has
 * already accepted.
 *
 * This is how a redemption is checked without asserting anything about real
 * hardware: the standard's own decoder decides, and a count the device has seen
 * before comes back `already_used`. It is used by the meter simulator and to
 * validate a code a customer reports as rejected — never as evidence that a
 * physical meter accepted anything.
 */
export function decodeTokenAsDevice(input: {
  keyRef: string;
  startingCode: number;
  token: string;
  lastCount: number;
  usedCounts: number[];
}): MeterAcceptance {
  const key = keyFor(input.keyRef);
  const decoder = new Decoder();
  let result: ReturnType<InstanceType<typeof Decoder>['decodeToken']>;
  try {
    result = decoder.decodeToken({
      token: input.token,
      secretKeyHex: key,
      count: input.lastCount,
      usedCounts: input.usedCounts,
      startingCode: input.startingCode,
      valueDivider: 1,
      restrictedDigitSet: false,
    });
  } catch {
    return {
      accepted: false,
      valueUnits: null,
      tokenType: Number(TokenTypes.INVALID),
      count: null,
      usedCounts: input.usedCounts,
      reason: 'undecidable',
    };
  }

  const tokenType = Number(result.tokenType);
  if (tokenType === Number(TokenTypes.ALREADY_USED)) {
    return {
      accepted: false,
      valueUnits: null,
      tokenType,
      count: result.count ?? null,
      usedCounts: input.usedCounts,
      reason: 'already_used',
    };
  }
  if (tokenType === Number(TokenTypes.INVALID) || result.value === undefined) {
    return {
      accepted: false,
      valueUnits: null,
      tokenType,
      count: result.count ?? null,
      usedCounts: input.usedCounts,
      reason: 'invalid',
    };
  }

  return {
    accepted: true,
    valueUnits: Number(result.value),
    tokenType,
    count: result.count ?? null,
    usedCounts: result.updatedCounts ?? input.usedCounts,
    reason: 'accepted',
  };
}
