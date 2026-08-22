/**
 * Outbound commands to the grid protocol service.
 *
 * This is the only path from platform logic to physical charge points: the Go
 * service in services/grid-protocols holds the OCPP WebSocket sessions and
 * exposes an HMAC-authenticated admin API. Commands are reported as successful
 * only when the charge point itself accepted them — a disconnected charge point
 * or an OCPP timeout is an error, never a silent success.
 */

import { createHmac } from 'crypto';

export interface ChargingSchedulePeriod {
  /** Seconds from the start of the schedule. */
  startPeriodSeconds: number;
  /** Watts. Negative discharges the vehicle (V2G). */
  limitWatts: number;
  numberPhases?: number;
}

export interface ChargingProfileCommand {
  chargePointId: string;
  connectorId: number;
  chargingProfileId: number;
  transactionId?: number;
  purpose: 'ChargePointMaxProfile' | 'TxDefaultProfile' | 'TxProfile';
  stackLevel: number;
  periods: ChargingSchedulePeriod[];
  startSchedule?: Date;
  durationSeconds?: number;
}

export class GridCommandError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'GridCommandError';
  }
}

interface GridServiceConfig {
  baseUrl: string;
  sharedSecret: string;
  timeoutMs: number;
}

/**
 * Resolves the protocol service configuration. Absent configuration is fatal:
 * a platform that cannot reach the protocol service cannot control hardware,
 * and pretending otherwise would report dispatches that never happened.
 */
export function gridServiceConfig(): GridServiceConfig {
  const baseUrl = process.env.GRID_PROTOCOL_SERVICE_URL;
  const sharedSecret = process.env.GRID_PROTOCOL_SHARED_SECRET;
  if (!baseUrl) {
    throw new GridCommandError(
      503,
      'GRID_PROTOCOL_SERVICE_URL is not configured; charge points cannot be commanded'
    );
  }
  if (!sharedSecret || sharedSecret.length < 32) {
    throw new GridCommandError(
      503,
      'GRID_PROTOCOL_SHARED_SECRET must be configured with at least 32 characters'
    );
  }
  const timeoutMs = Number(process.env.GRID_PROTOCOL_TIMEOUT_MS ?? '20000');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GridCommandError(503, 'GRID_PROTOCOL_TIMEOUT_MS must be a positive number');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), sharedSecret, timeoutMs };
}

/** Signs a request body exactly as internal/admin in the Go service expects. */
export function signCommand(
  sharedSecret: string,
  timestamp: string,
  body: string
): string {
  return createHmac('sha256', sharedSecret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest('hex');
}

async function call<T>(
  path: string,
  payload: unknown,
  method: 'GET' | 'POST' = 'POST'
): Promise<T> {
  const config = gridServiceConfig();
  const body = method === 'GET' ? '' : JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-grid-timestamp': timestamp,
        'x-grid-signature': signCommand(config.sharedSecret, timestamp, body),
      },
      body: method === 'GET' ? undefined : body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new GridCommandError(
        response.status,
        `grid protocol service rejected ${path}: HTTP ${response.status}: ${text}`
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (error) {
    if (error instanceof GridCommandError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GridCommandError(
        504,
        `grid protocol service did not answer ${path} within ${config.timeoutMs}ms; delivery is unconfirmed`
      );
    }
    throw new GridCommandError(
      502,
      `grid protocol service unreachable for ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Applies a charging profile (an optimizer or V2G schedule) to a charge point.
 *
 * Resolves only when the charge point returned `Accepted`; the service turns
 * `Rejected`, `NotSupported` and OCPP timeouts into non-2xx responses.
 */
export async function setChargingProfile(
  command: ChargingProfileCommand
): Promise<{ status: string }> {
  if (command.periods.length === 0) {
    throw new GridCommandError(400, 'a charging profile needs at least one schedule period');
  }
  for (const period of command.periods) {
    if (!Number.isFinite(period.limitWatts)) {
      throw new GridCommandError(400, 'charging profile limits must be finite');
    }
    if (period.startPeriodSeconds < 0) {
      throw new GridCommandError(400, 'charging profile periods cannot start before the schedule');
    }
  }
  return call<{ status: string }>('/admin/charging-profile', {
    charge_point_id: command.chargePointId,
    request: {
      connectorId: command.connectorId,
      csChargingProfiles: {
        chargingProfileId: command.chargingProfileId,
        transactionId: command.transactionId,
        stackLevel: command.stackLevel,
        chargingProfilePurpose: command.purpose,
        chargingProfileKind: command.startSchedule ? 'Absolute' : 'Relative',
        chargingSchedule: {
          duration: command.durationSeconds,
          startSchedule: command.startSchedule?.toISOString(),
          // Watts throughout the platform; amps would need per-connector
          // voltage and phase data we do not hold.
          chargingRateUnit: 'W',
          chargingSchedulePeriod: command.periods.map(period => ({
            startPeriod: period.startPeriodSeconds,
            limit: period.limitWatts,
            numberPhases: period.numberPhases,
          })),
        },
      },
    },
  });
}

export async function remoteStartTransaction(input: {
  chargePointId: string;
  connectorId: number;
  idTag: string;
}): Promise<{ status: string }> {
  return call<{ status: string }>('/admin/remote-start', {
    charge_point_id: input.chargePointId,
    request: { connectorId: input.connectorId, idTag: input.idTag },
  });
}

export async function remoteStopTransaction(input: {
  chargePointId: string;
  transactionId: number;
}): Promise<{ status: string }> {
  return call<{ status: string }>('/admin/remote-stop', {
    charge_point_id: input.chargePointId,
    request: { transactionId: input.transactionId },
  });
}

export async function connectedChargePoints(): Promise<string[]> {
  const result = await call<{ connected?: string[] }>('/admin/charge-points', undefined, 'GET');
  return result.connected ?? [];
}
