/**
 * Device credential authentication for telemetry ingestion.
 *
 * Telemetry drives settlement, compensation and carbon credit issuance, so a
 * measurement is only accepted when it is presented with the credential that
 * was issued to the registered device for that asset. Account-level login is
 * not sufficient: it would let an asset owner self-report the energy they are
 * paid for.
 */

import { scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import type { Request } from 'express';
import * as devicesDb from '../devices-db';

const scryptAsync = promisify(scrypt);

export const DEVICE_ID_HEADER = 'x-device-id';
export const DEVICE_KEY_HEADER = 'x-device-key';

/**
 * Verify a stored "salt:hash" scrypt digest against a presented secret.
 */
export async function verifyDeviceSecret(secret: string, storedHash: string): Promise<boolean> {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;

  const derived = (await scryptAsync(secret, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, 'hex');

  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

export type DeviceAuthResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: string };

/**
 * Authenticate the caller as a device registered against `assetId`.
 */
export async function authenticateDeviceForAsset(
  req: Pick<Request, 'headers'>,
  assetId: number
): Promise<DeviceAuthResult> {
  const presentedId = req.headers[DEVICE_ID_HEADER];
  const presentedKey = req.headers[DEVICE_KEY_HEADER];

  if (typeof presentedId !== 'string' || typeof presentedKey !== 'string') {
    return {
      ok: false,
      reason: `Telemetry ingestion requires the ${DEVICE_ID_HEADER} and ${DEVICE_KEY_HEADER} headers issued when the device was registered.`,
    };
  }

  const devices = await devicesDb.getDevicesByAssetId(assetId);
  const device = devices.find(d => d.deviceId === presentedId);

  if (!device) {
    return { ok: false, reason: 'Device is not registered for this asset.' };
  }

  if (!device.enabled) {
    return { ok: false, reason: 'Device is disabled.' };
  }

  if (!device.mqttPasswordHash) {
    return { ok: false, reason: 'Device has no credential on record; re-register the device.' };
  }

  const valid = await verifyDeviceSecret(presentedKey, device.mqttPasswordHash);
  if (!valid) {
    return { ok: false, reason: 'Device credential is invalid.' };
  }

  return { ok: true, deviceId: device.deviceId };
}
