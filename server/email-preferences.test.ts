/**
 * Pinning tests for P12: sendEmailNotification honors the user's email*
 * notification preferences. Until the fix the preference columns were never
 * read and every email went out regardless. A disabled category now skips the
 * send, and the skip is explicit (skipped: 'preference_disabled'), not a
 * silent drop.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

type Row = Record<string, unknown>;

function mockDeps(prefs: Row | null, sent: Row[]) {
  vi.doMock('./db', () => ({
    getDb: async () => ({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => (prefs ? [prefs] : []) }) }),
      }),
    }),
  }));
  vi.doMock('./_core/emailService', () => ({
    sendEmail: async (options: Row) => {
      sent.push(options);
      return { success: true, messageId: 'msg-1' };
    },
  }));
}

const email = { to: 'user@example.com', subject: 'Trade executed', html: '<p>hi</p>' };

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./_core/emailService');
});

describe('sendEmailNotification honors email preferences (P12)', () => {
  it('does not send when the category preference is disabled', async () => {
    const sent: Row[] = [];
    mockDeps({ userId: 7, emailTradeExecuted: false }, sent);
    const { sendEmailNotification } = await import('./_core/sendNotification');

    const result = await sendEmailNotification(7, email, 'emailTradeExecuted');

    expect(result).toEqual({ success: true, skipped: 'preference_disabled' });
    expect(sent).toHaveLength(0);
  });

  it('sends when the category preference is enabled', async () => {
    const sent: Row[] = [];
    mockDeps({ userId: 7, emailTradeExecuted: true }, sent);
    const { sendEmailNotification } = await import('./_core/sendNotification');

    const result = await sendEmailNotification(7, email, 'emailTradeExecuted');

    expect(result).toEqual({ success: true, messageId: 'msg-1' });
    expect(sent).toHaveLength(1);
  });

  it('sends when no preference row exists (defaults are on)', async () => {
    const sent: Row[] = [];
    mockDeps(null, sent);
    const { sendEmailNotification } = await import('./_core/sendNotification');

    await sendEmailNotification(7, email, 'emailTradeExecuted');
    expect(sent).toHaveLength(1);
  });

  it('a disabled category does not block other categories', async () => {
    const sent: Row[] = [];
    mockDeps({ userId: 7, emailTradeExecuted: false, emailSystemAlert: true }, sent);
    const { sendEmailNotification } = await import('./_core/sendNotification');

    await sendEmailNotification(7, email, 'emailSystemAlert');
    expect(sent).toHaveLength(1);
  });
});
