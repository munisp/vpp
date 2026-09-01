/**
 * Novu notification adapter.
 *
 * Configuration (both required):
 *   NOVU_API_KEY       Novu API key (secret key)
 *   NOVU_BACKEND_URL   Novu API base URL (self-hosted or https://api.novu.co)
 *
 * Fail-loud contract: when either variable is missing, novuEnabled() is false
 * and getNovuStatus() says exactly why; triggerNotification() throws instead
 * of silently dropping the notification. Status is meant to be surfaced (e.g.
 * in diagnostics) rather than inferred from missing notifications.
 *
 * SDK choice: the official @novu/node SDK. It is deprecated upstream in favor
 * of @novu/api, but it is the stable documented v2 surface and rides on
 * axios, which this repo already ships — raw fetch would re-implement the
 * trigger payload types and auth-header handling for no real saving.
 *
 * NOT wired into any business flow yet — that routing decision (which events
 * notify which subscribers) is intentionally left for a follow-up. Example
 * call site (documented, do not uncomment blindly):
 *
 *   import { triggerNotification } from '../services/novu-service';
 *   // e.g. inside a payment success handler:
 *   await triggerNotification('payment-receipt', String(user.id), {
 *     paymentId, amount, currency,
 *   });
 */

import { Novu } from '@novu/node';

export interface NovuStatus {
  enabled: boolean;
  /** Why the adapter is unavailable, when it is. */
  reason?: string;
  backendUrl?: string;
}

/** Minimal shape of the Novu client this adapter needs (for test doubles). */
export interface NovuTriggerClient {
  trigger(
    workflowIdentifier: string,
    data: {
      to: { subscriberId: string };
      payload: Record<string, unknown>;
    }
  ): Promise<unknown>;
}

export interface TriggerNotificationResult {
  status: 'sent';
  workflowId: string;
  subscriberId: string;
  /** Novu transaction id, when the backend returns one. */
  transactionId?: string;
}

/**
 * Honest availability check. Never throws, never touches the network.
 */
export function getNovuStatus(env: NodeJS.ProcessEnv = process.env): NovuStatus {
  const missing: string[] = [];
  if (!env.NOVU_API_KEY) missing.push('NOVU_API_KEY');
  if (!env.NOVU_BACKEND_URL) missing.push('NOVU_BACKEND_URL');

  if (missing.length > 0) {
    return {
      enabled: false,
      reason: `missing env: ${missing.join(', ')}`,
    };
  }
  return { enabled: true, backendUrl: env.NOVU_BACKEND_URL };
}

export function novuEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getNovuStatus(env).enabled;
}

export class NovuNotConfiguredError extends Error {
  readonly code = 'NOVU_NOT_CONFIGURED';
  constructor(reason: string) {
    super(`Novu notifications are not configured (${reason})`);
    this.name = 'NovuNotConfiguredError';
  }
}

export interface NovuService {
  status(): NovuStatus;
  triggerNotification(
    workflowId: string,
    subscriberId: string,
    payload: Record<string, unknown>
  ): Promise<TriggerNotificationResult>;
}

/**
 * Build an adapter instance. `client` is injectable so tests can verify the
 * request shape without any network access.
 */
export function createNovuService(config: {
  apiKey: string;
  backendUrl: string;
  client?: NovuTriggerClient;
}): NovuService {
  const client: NovuTriggerClient =
    config.client ??
    (() => {
      const novu = new Novu(config.apiKey, { backendUrl: config.backendUrl });
      return {
        // ITriggerPayload is narrower than Record<string, unknown>; Novu
        // accepts arbitrary JSON payload values at runtime.
        trigger: (workflowIdentifier, data) =>
          novu.trigger(workflowIdentifier, data as never),
      };
    })();
  const status: NovuStatus = { enabled: true, backendUrl: config.backendUrl };

  return {
    status: () => status,
    async triggerNotification(workflowId, subscriberId, payload) {
      if (!workflowId) throw new Error('triggerNotification: workflowId is required');
      if (!subscriberId) throw new Error('triggerNotification: subscriberId is required');

      const response = await client.trigger(workflowId, {
        to: { subscriberId },
        payload,
      });

      const transactionId = (response as {
        data?: { data?: { transactionId?: string } };
      })?.data?.data?.transactionId;

      return {
        status: 'sent',
        workflowId,
        subscriberId,
        ...(transactionId ? { transactionId } : {}),
      };
    },
  };
}

let singleton: NovuService | null = null;

/**
 * Process-wide adapter built from env. Throws NovuNotConfiguredError when the
 * env contract is unmet — callers must check novuEnabled() first or handle
 * the throw; a notification that never had a backend must not fail silently.
 */
export function getNovuService(): NovuService {
  const status = getNovuStatus();
  if (!status.enabled) {
    throw new NovuNotConfiguredError(status.reason ?? 'unknown');
  }
  if (!singleton) {
    singleton = createNovuService({
      apiKey: process.env.NOVU_API_KEY!,
      backendUrl: process.env.NOVU_BACKEND_URL!,
    });
  }
  return singleton;
}

/**
 * Convenience wrapper over getNovuService(). Fail-loud by design.
 */
export async function triggerNotification(
  workflowId: string,
  subscriberId: string,
  payload: Record<string, unknown>
): Promise<TriggerNotificationResult> {
  return getNovuService().triggerNotification(workflowId, subscriberId, payload);
}

/** Test hook: drop the cached singleton. */
export function resetNovuServiceForTests(): void {
  singleton = null;
}
