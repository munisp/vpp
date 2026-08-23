/**
 * The buyer has already paid at the provider by the time the platform posts the
 * double entry, so the ledger cannot be allowed to decide whether that payment is
 * remembered. These tests pin that split:
 *
 *  - a posted entry is reported as posted
 *  - a ledger refusal is reported as refused and does not throw away the payment
 *  - an unreachable ledger stays pending for retry, and is never reported as posted
 *  - a ledger the deployment does not have is `unavailable_no_ledger`, not a zero
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LedgerRefusedError } from './services/ledger/tigerbeetle';

const postBuyerPaymentCaptured = vi.fn();

vi.mock('./services/ledger/postings', () => ({
  postBuyerPaymentCaptured: (input: unknown) => postBuyerPaymentCaptured(input),
}));

const capture = {
  paymentId: 51,
  sellerUserId: 9,
  gatewayKey: 'mpesa',
  amountMinor: 25_000,
  providerReference: 'MPESA-REF-1',
};

beforeEach(() => {
  postBuyerPaymentCaptured.mockReset();
});

describe('recording a captured payment on the ledger', () => {
  it('reports a posted entry', async () => {
    postBuyerPaymentCaptured.mockResolvedValue({
      postingId: 1,
      state: 'posted',
      tbTransferId: '123',
      detail: 'posted 25000 TZS minor units.',
    });
    const { recordCaptureOnLedger } = await import('./services/p2p-settlement');
    await expect(recordCaptureOnLedger(capture)).resolves.toMatchObject({ state: 'posted' });
  });

  it('passes the payment through as the source, so a replay re-enters one entry', async () => {
    postBuyerPaymentCaptured.mockResolvedValue({ postingId: 1, state: 'posted', tbTransferId: '1', detail: '' });
    const { recordCaptureOnLedger } = await import('./services/p2p-settlement');
    await recordCaptureOnLedger(capture);
    expect(postBuyerPaymentCaptured).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 51, sellerUserId: 9, gatewayKey: 'mpesa', amountMinor: 25_000 })
    );
  });

  it('keeps the payment and records a refusal when the ledger refuses', async () => {
    postBuyerPaymentCaptured.mockRejectedValue(new LedgerRefusedError('exceeds_credits', 'refused'));
    const { recordCaptureOnLedger } = await import('./services/p2p-settlement');
    const result = await recordCaptureOnLedger(capture);
    expect(result.state).toBe('refused');
    expect(result.detail).toMatch(/exceeds_credits/);
  });

  it('holds the entry pending when the ledger cannot be reached', async () => {
    postBuyerPaymentCaptured.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3200'));
    const { recordCaptureOnLedger } = await import('./services/p2p-settlement');
    const result = await recordCaptureOnLedger(capture);
    expect(result.state).toBe('pending');
    expect(result.detail).toMatch(/retried/);
  });

  it('reports a deployment with no ledger as such', async () => {
    postBuyerPaymentCaptured.mockResolvedValue({
      postingId: 2,
      state: 'unavailable_no_ledger',
      tbTransferId: '456',
      detail: 'No double-entry ledger is configured',
    });
    const { recordCaptureOnLedger } = await import('./services/p2p-settlement');
    const result = await recordCaptureOnLedger(capture);
    expect(result.state).toBe('unavailable_no_ledger');
  });
});
