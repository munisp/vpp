/**
 * Physical dispatch of a settled P2P energy trade.
 *
 * A trade is an energy quantity (Wh); hardware takes a power setpoint. The
 * transfer window is what makes the two commensurable, and it doubles as the
 * control validity window, so a trade dispatched while the platform is healthy
 * cannot keep a seller's asset exporting after the platform goes away.
 *
 * Escrow is never released on the strength of this dispatch: MQTT devices do not
 * acknowledge commands, so the trade stays `pending` with a `broker_queued`
 * transfer status until settlement verifies delivered energy from telemetry.
 */

import { getDb } from '../db';
import { trades, assets } from '../../drizzle/schema';
import { and, eq } from 'drizzle-orm';
import { dispatchDeviceSetpoint } from '../services/control-delivery';
import { mqttBrokerService } from '../integration/mqtt-broker';
import { MIN_VALIDITY_SECONDS, maxValiditySeconds } from '../services/control-validity';

/**
 * Dispatch adds to a trade's evidence; it does not replace it. The prior keys
 * hold the match and the buyer's confirmed payment, and settlement reads them
 * later, so overwriting the whole document would erase the payment evidence.
 */
function mergeTradeMetadata(existing: string | null, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object') base = parsed as Record<string, unknown>;
    } catch {
      // A malformed document is kept out of the way rather than silently dropped.
      base = { unparsedMetadata: existing };
    }
  }
  return JSON.stringify({ ...base, ...patch });
}

export interface EnergyTransferInput {
  tradeId: number;
  sellerId: number;
  buyerId: number;
  /** Traded energy in watt-hours. */
  energyAmount: number;
}

export interface EnergyTransferResult {
  success: boolean;
  transferId?: string;
  error?: string;
}

/**
 * Window a P2P transfer is dispatched over. It must stay inside the platform's
 * control bounds: a transfer window longer than the maximum validity would be a
 * setpoint nothing expires, so the cap is also the default — the longest window
 * the deployment allows is the gentlest export rate for a given trade.
 */
export function p2pTransferWindowSeconds(): number {
  const raw = process.env.P2P_TRANSFER_WINDOW_SECONDS;
  const max = maxValiditySeconds();
  const configured = raw === undefined || raw === '' ? max : Number(raw);
  if (!Number.isFinite(configured) || configured < MIN_VALIDITY_SECONDS) {
    throw new Error(
      `P2P_TRANSFER_WINDOW_SECONDS must be a number >= ${MIN_VALIDITY_SECONDS}; got ${raw}`
    );
  }
  if (configured > max) {
    throw new Error(
      `P2P_TRANSFER_WINDOW_SECONDS (${configured}) exceeds ` +
      `GRID_CONTROL_MAX_VALIDITY_SECONDS (${max})`
    );
  }
  return Math.floor(configured);
}

export async function executeEnergyTransfer(
  input: EnergyTransferInput
): Promise<EnergyTransferResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const [tradeRow] = await db
    .select({ metadata: trades.metadata })
    .from(trades)
    .where(eq(trades.id, input.tradeId));
  const priorMetadata = tradeRow?.metadata ?? null;

  const markDispatchFailed = async (error: string): Promise<EnergyTransferResult> => {
    console.error(`[TradingActivity] Dispatch failed for trade ${input.tradeId}: ${error}`);
    await db.update(trades).set({
      status: 'pending', // escrow stays held — never settle an undispatched trade
      metadata: mergeTradeMetadata(priorMetadata, {
        transferStatus: 'dispatch_failed',
        dispatchError: error,
        stage: 'dispatch',
        failedAt: new Date(),
      }),
    }).where(eq(trades.id, input.tradeId));
    return { success: false, error };
  };

  // Resolve the seller's dispatchable device (serial number is the MQTT device id)
  const sellerAssets = await db
    .select()
    .from(assets)
    .where(and(eq(assets.userId, input.sellerId), eq(assets.status, 'active')));

  let deviceId: string | undefined;
  let assetId: number | undefined;
  let assetCapacity: number | undefined;
  for (const asset of sellerAssets) {
    if (asset.serialNumber) {
      deviceId = asset.serialNumber;
      assetId = asset.id;
      assetCapacity = asset.capacity;
      break;
    }
    if (asset.metadata) {
      try {
        const meta = JSON.parse(asset.metadata);
        if (meta.deviceId) {
          deviceId = meta.deviceId;
          assetId = asset.id;
          assetCapacity = asset.capacity;
          break;
        }
      } catch {
        // ignore malformed asset metadata and keep looking
      }
    }
  }

  if (!deviceId) {
    return markDispatchFailed('Seller has no active asset with a registered device ID');
  }

  // The worker is a separate process, so the broker connection may be cold.
  if (!mqttBrokerService.isConnected()) {
    try {
      await mqttBrokerService.connect();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return markDispatchFailed(`MQTT broker unreachable: ${detail}`);
    }
    // connect() resolves before the 'connect' event; wait briefly for it
    const waitDeadline = Date.now() + 10_000;
    while (!mqttBrokerService.isConnected() && Date.now() < waitDeadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  if (!mqttBrokerService.isConnected()) {
    return markDispatchFailed('MQTT broker not connected');
  }

  const windowSeconds = p2pTransferWindowSeconds();
  const exportWatts = Math.round((input.energyAmount * 3600) / windowSeconds);
  if (exportWatts <= 0) {
    return markDispatchFailed(`Trade energy ${input.energyAmount} Wh is too small to dispatch`);
  }
  // Refuse rather than quietly dispatch a rate the asset cannot sustain: for
  // generation `capacity` is watts, for a battery it is watt-hours, so this also
  // caps a battery at a 1C discharge.
  if (assetCapacity !== undefined && exportWatts > assetCapacity) {
    return markDispatchFailed(
      `Trade needs ${exportWatts} W of export over ${windowSeconds}s but asset ${assetId} ` +
      `is rated ${assetCapacity}; lengthen P2P_TRANSFER_WINDOW_SECONDS or split the trade`
    );
  }

  // Bounded control path: the setpoint carries its window and a resume_local
  // fallback, and the assignment is recorded so the sweeper releases the asset
  // when the transfer window closes.
  const dispatch = await dispatchDeviceSetpoint({
    deviceId,
    setpointWatts: exportWatts,
    validForSeconds: windowSeconds,
    fallbackPolicy: 'resume_local',
    source: 'p2p_trade',
    sourceId: input.tradeId,
    assetId,
    userId: input.sellerId,
  });

  if (!dispatch.published) {
    return markDispatchFailed(
      `Setpoint delivery ${dispatch.status}: ${dispatch.reason ?? 'no broker acknowledgement'}`
    );
  }

  const transferId = `dispatch-${input.tradeId}-${dispatch.assignmentId ?? Date.now()}`;
  await db.update(trades).set({
    status: 'pending', // still pending until settlement verifies delivery
    metadata: mergeTradeMetadata(priorMetadata, {
      transferId,
      // The broker took the message; the device never acknowledges, so this is
      // not evidence the seller's asset exported anything.
      transferStatus: 'broker_queued',
      controlAssignmentId: dispatch.assignmentId,
      deviceId,
      assetId,
      exportWatts,
      validFrom: dispatch.validFrom,
      validTo: dispatch.validTo,
      fallbackPolicy: dispatch.fallbackPolicy,
      transferStartedAt: new Date(),
      energyAmount: input.energyAmount,
      stage: 'executing',
    }),
  }).where(eq(trades.id, input.tradeId));


  console.log(
    `[TradingActivity] Bounded setpoint queued for device ${deviceId}: ` +
    `${exportWatts} W until ${dispatch.validTo.toISOString()} (${transferId})`
  );
  return { success: true, transferId };
}
