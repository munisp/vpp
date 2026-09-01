/**
 * Tests for server/services/novu-service.ts.
 *
 * The adapter is fail-loud: unconfigured env must report unavailable WITH a
 * reason, and trigger attempts must throw rather than drop notifications
 * silently. All tests run without any network access — the Novu client is
 * injected as a test double for request-shape verification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createNovuService,
  getNovuService,
  getNovuStatus,
  novuEnabled,
  NovuNotConfiguredError,
  resetNovuServiceForTests,
  triggerNotification,
  type NovuTriggerClient,
} from './novu-service';

describe('novu configuration status', () => {
  it('is unavailable with reason when both env vars are missing', () => {
    const status = getNovuStatus({});
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('missing env: NOVU_API_KEY, NOVU_BACKEND_URL');
  });

  it('names the single missing variable', () => {
    expect(getNovuStatus({ NOVU_API_KEY: 'key' }).reason).toBe(
      'missing env: NOVU_BACKEND_URL'
    );
    expect(getNovuStatus({ NOVU_BACKEND_URL: 'http://novu:3000' }).reason).toBe(
      'missing env: NOVU_API_KEY'
    );
  });

  it('is enabled when the contract is met', () => {
    const env = { NOVU_API_KEY: 'key', NOVU_BACKEND_URL: 'http://novu:3000' };
    expect(getNovuStatus(env)).toEqual({ enabled: true, backendUrl: 'http://novu:3000' });
    expect(novuEnabled(env)).toBe(true);
  });
});

describe('fail-loud behavior', () => {
  beforeEach(() => {
    delete process.env.NOVU_API_KEY;
    delete process.env.NOVU_BACKEND_URL;
    resetNovuServiceForTests();
  });
  afterEach(() => {
    resetNovuServiceForTests();
  });

  it('getNovuService throws NovuNotConfiguredError when unconfigured', () => {
    expect(() => getNovuService()).toThrow(NovuNotConfiguredError);
    expect(() => getNovuService()).toThrow(/NOVU_API_KEY/);
  });

  it('triggerNotification throws instead of dropping the notification', async () => {
    await expect(
      triggerNotification('payment-receipt', 'user-1', { amount: 10 })
    ).rejects.toThrow(NovuNotConfiguredError);
  });
});

describe('triggerNotification request shape', () => {
  it('calls the Novu events trigger API with the documented payload', async () => {
    const trigger = vi.fn().mockResolvedValue({
      data: { data: { transactionId: 'tx-123' } },
    });
    const client: NovuTriggerClient = { trigger };
    const service = createNovuService({
      apiKey: 'key',
      backendUrl: 'http://novu:3000',
      client,
    });

    const result = await service.triggerNotification('payment-receipt', 'user-42', {
      paymentId: 'pay-9',
      amount: 25.5,
      currency: 'KES',
    });

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith('payment-receipt', {
      to: { subscriberId: 'user-42' },
      payload: { paymentId: 'pay-9', amount: 25.5, currency: 'KES' },
    });
    expect(result).toEqual({
      status: 'sent',
      workflowId: 'payment-receipt',
      subscriberId: 'user-42',
      transactionId: 'tx-123',
    });
  });

  it('omits transactionId when the backend does not return one', async () => {
    const client: NovuTriggerClient = { trigger: vi.fn().mockResolvedValue({}) };
    const service = createNovuService({
      apiKey: 'key',
      backendUrl: 'http://novu:3000',
      client,
    });

    const result = await service.triggerNotification('wf', 'sub', {});
    expect(result.status).toBe('sent');
    expect(result).not.toHaveProperty('transactionId');
  });

  it('rejects invalid arguments before touching the client', async () => {
    const client: NovuTriggerClient = { trigger: vi.fn() };
    const service = createNovuService({
      apiKey: 'key',
      backendUrl: 'http://novu:3000',
      client,
    });

    await expect(service.triggerNotification('', 'sub', {})).rejects.toThrow(/workflowId/);
    await expect(service.triggerNotification('wf', '', {})).rejects.toThrow(/subscriberId/);
    expect(client.trigger).not.toHaveBeenCalled();
  });
});
