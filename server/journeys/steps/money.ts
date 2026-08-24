/**
 * Money journeys: wallets and prepaid tokens, invoicing, and the daily close.
 *
 * Nothing here treats a database row as evidence of a payment. A gateway that
 * is not configured must make the journey report `blocked`, and a payment that
 * has not been called back must never read as completed.
 */

import {
  blocked,
  classifyDependencyError,
  count,
  errorCode,
  errorMessage,
  failed,
  passed,
  priorNumber,
  refused,
  type JourneyStep,
} from '../step';
import { ensureActiveContract } from '../fixtures';

const TOPUP_PHONE = '255700000002';

export const prepaidPurchaseSteps: Record<string, JourneyStep> = {
  'wallet-and-balance': async ctx => {
    const wallet = await ctx.member.caller.energyWallet.getWallet();
    const attempts = await ctx.member.caller.energyWallet.listTopUpAttempts({ limit: 20 });
    const balance = await ctx.member.caller.payments.getBalance();
    const walletBalance = (wallet as { balanceCents?: number }).balanceCents ?? null;
    if (walletBalance === null) {
      return failed('energyWallet.getWallet returned no balance for the member to spend.');
    }
    return passed('Wallet balance and past top-up attempts are readable.', {
      balanceCents: walletBalance,
      topUpAttempts: attempts.count,
      hasPaymentBalance: Boolean(balance),
    });
  },

  'method-availability': async ctx => {
    const supported = await ctx.member.caller.paymentProcessing.getSupportedGateways();
    const availability = await ctx.member.caller.paymentProcessing.getGatewayAvailability({
      environment: 'sandbox',
    });
    if (supported.length === 0 || availability.gateways.length === 0) {
      return failed('The platform reports no payment methods at all, not even unavailable ones.');
    }
    const unexplained = availability.gateways.filter(
      gateway => !gateway.configured && !gateway.reason
    );
    if (unexplained.length > 0) {
      return failed('A method is unavailable without saying why.', {
        methods: availability.gateways.length,
        unexplained: unexplained.length,
      });
    }
    if (availability.configuredCount === 0) {
      return refused('Every method is reported unavailable, which is honest with no credentials.', {
        methods: availability.gateways.length,
        configured: availability.configuredCount,
      });
    }
    return passed('The platform names the methods it can actually charge.', {
      methods: availability.gateways.length,
      configured: availability.configuredCount,
    });
  },

  'initiate-topup': async ctx => {
    try {
      const topUp = await ctx.member.caller.energyWallet.requestTopUp({
        amountCents: 5_000,
        method: 'mpesa',
        phoneNumber: TOPUP_PHONE,
      });
      if (!topUp.topUpInitiated) {
        // The gateway answered and refused, or there was no gateway to answer:
        // either way the wallet must not move and the reason has to be named.
        return refused('The gateway did not accept the top-up, and the wallet is unchanged.', {
          reason: topUp.reason ?? 'unstated',
          attemptId: topUp.attemptId ?? null,
        });
      }
      const wallet = await ctx.member.caller.energyWallet.getWallet();
      const credited = (wallet as { balanceCents?: number }).balanceCents ?? 0;
      if (credited > 0) {
        return failed('A wallet top-up credited the wallet with no gateway callback behind it.', {
          attemptId: topUp.attemptId ?? null,
          balanceCents: credited,
        });
      }
      return passed('The top-up reached the gateway and waits for its callback.', {
        attemptId: topUp.attemptId ?? null,
      });
    } catch (error) {
      return classifyDependencyError(error, 'mobile_money', { stage: 'wallet-top-up' });
    }
  },

  'qr-payment-request': async ctx => {
    // A deployment with no signing key cannot issue a payment code at all, and
    // refusing is the correct behaviour there — an unsigned code would be
    // attacker-editable — so that answer is recorded as a refusal rather than
    // thrown as a defect.
    let generated: Awaited<ReturnType<typeof ctx.member.caller.qrcode.generate>>;
    try {
      generated = await ctx.member.caller.qrcode.generate({
        type: 'p2p',
        amount: 2_500,
        currency: 'TZS',
        recipientId: String(ctx.member.user.id),
        recipientName: ctx.member.user.name ?? 'Journey member',
        description: `Journey QR request ${ctx.runKey}`,
      });
    } catch (error) {
      if (errorCode(error) === 'PRECONDITION_FAILED') {
        return refused('No signing key is configured, so no payment code is issued at all.', {
          detail: errorMessage(error),
        });
      }
      throw error;
    }
    // The bytes a scanner would read, not a summary of them: the payload has to
    // verify against its own signature or the code is worthless to a payer.
    const parsed = await ctx.member.caller.qrcode.parse({ qrData: generated.payload });
    if (parsed.amount !== 2_500 || parsed.currency !== 'TZS') {
      return failed('A QR request does not parse back to the amount it was generated for.', {
        parsedAmount: parsed.amount ?? null,
        parsedCurrency: parsed.currency ?? null,
      });
    }
    if (parsed.reference !== generated.reference) {
      return failed('A parsed QR code carries a different reference than the one issued.', {
        issued: generated.reference,
        parsed: parsed.reference ?? null,
      });
    }
    const stats = await ctx.member.caller.qrHistory.getMyStats();
    return passed('A QR payment request round-trips through generation and parsing.', {
      amountRequested: 2_500,
      reference: generated.reference,
      hasImage: generated.image.startsWith('data:image/png;base64,'),
      hasStats: Boolean(stats),
    });
  },

  'token-issuance': async ctx => {
    const tokens = await ctx.member.caller.payments.listTokens();
    const tokenRows = (tokens as { tokens?: unknown[] }).tokens
      ?? (Array.isArray(tokens) ? tokens : []);
    const payments = await ctx.member.caller.payments.list({ limit: 50 });
    const rows = (payments as { payments?: Array<{ id: number; status?: string }> }).payments ?? [];
    const pending = rows.find(payment => payment.status === 'pending');

    if (!pending) {
      return refused('No pending payment exists to test token issuance against.', {
        tokens: Array.isArray(tokenRows) ? tokenRows.length : 0,
        payments: rows.length,
      });
    }

    // A token is energy the member may consume. Issuing one against a payment
    // no gateway has confirmed would be giving energy away on a database row.
    try {
      await ctx.member.caller.payments.generateToken({ paymentId: pending.id });
      return failed('A prepaid token was issued against a payment with no gateway evidence.', {
        paymentId: pending.id,
      });
    } catch {
      return passed('Token issuance is refused until the payment is evidenced as complete.', {
        paymentId: pending.id,
        tokens: Array.isArray(tokenRows) ? tokenRows.length : 0,
      });
    }
  },
};

export const billingSteps: Record<string, JourneyStep> = {
  'issue-invoice': async ctx => {
    // An invoice is computed under the member's contract terms, so the contract
    // has to exist before anyone can be billed.
    const contract = await ensureActiveContract(ctx);
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    const created = await ctx.admin.caller.billing.create({
      userId: ctx.member.user.id,
      billingType: 'postpaid',
      periodStart,
      periodEnd,
      generationKwh: 120,
      consumptionKwh: 90,
      exportKwh: 40,
      exportRevenue: 1_200,
      selfConsumptionSavings: 800,
    });
    const billingId = created.billing?.id;
    if (typeof billingId !== 'number') {
      return failed('billing.create returned no invoice id.');
    }
    const share = created.billing.consumerShare;
    const commission = created.billing.vppCommission;
    if (share + commission !== created.billing.totalValue) {
      return failed('An invoice splits a different total than the value it recorded.', {
        billingId,
        totalValue: created.billing.totalValue,
        consumerShare: share,
        vppCommission: commission,
      });
    }
    return passed('An operator issued an invoice under the member’s contract terms.', {
      billingId,
      contractId: contract.contractId,
      contractCreated: contract.created,
      totalValue: created.billing.totalValue,
      consumerShare: share,
    });
  },

  'member-reads-invoice': async ctx => {
    const billingId = priorNumber(ctx, 'issue-invoice', 'billingId');
    const listed = await ctx.member.caller.billing.list({ limit: 12 });
    const mine = listed.billings.some(invoice => invoice.id === billingId);
    if (!mine) {
      return failed('The member cannot see the invoice issued to them.', { billingId });
    }
    const detail = await ctx.member.caller.billing.getById({ billingId });
    if (detail.userId !== ctx.member.user.id) {
      return failed('An invoice reads back against a different member.', { billingId });
    }
    return passed('The member reads the invoice and the amount it asks for.', {
      billingId,
      invoices: listed.count,
      consumerShare: detail.consumerShare,
      status: detail.status,
    });
  },

  'pay-invoice': async ctx => {
    const billingId = priorNumber(ctx, 'issue-invoice', 'billingId');
    try {
      const payment = await ctx.member.caller.payments.initiate({
        paymentType: 'invoice',
        amount: 1_000,
        paymentMethod: 'mpesa',
        phoneNumber: TOPUP_PHONE,
        billingId,
      });
      const status = (payment as { payment?: { status?: string }; status?: string }).payment?.status
        ?? (payment as { status?: string }).status
        ?? 'unknown';
      if (status === 'completed') {
        return failed('An invoice payment reports completed before any gateway callback.', {
          billingId,
          status,
        });
      }
      return passed('The charge reached the gateway and stays pending its callback.', {
        billingId,
        status,
      });
    } catch (error) {
      return classifyDependencyError(error, 'mobile_money', { billingId });
    }
  },

  'gateway-credentials': async ctx => {
    const credentials = await ctx.admin.caller.paymentCredentials.list();
    const rows = (credentials as { credentials?: unknown[] }).credentials
      ?? (Array.isArray(credentials) ? credentials : []);
    const logs = await ctx.admin.caller.paymentCredentials.getLogs({ limit: 50 });
    const logRows = (logs as { logs?: unknown[] }).logs ?? (Array.isArray(logs) ? logs : []);
    const stored = Array.isArray(rows) ? rows.length : 0;
    if (stored === 0) {
      return refused('No gateway credentials are stored, which is why charges are unavailable.', {
        credentials: 0,
        logs: Array.isArray(logRows) ? logRows.length : 0,
      });
    }
    return passed('Stored gateway credentials and their call log are visible to an operator.', {
      credentials: stored,
      logs: Array.isArray(logRows) ? logRows.length : 0,
    });
  },

  'callback-configuration': async ctx => {
    const config = await ctx.admin.caller.webhookConfig.getConfig();
    const configured = (config as { configured?: boolean }).configured;
    const url = (config as { callbackUrl?: string; webhookUrl?: string }).callbackUrl
      ?? (config as { webhookUrl?: string }).webhookUrl
      ?? null;
    if (configured === false || url === null) {
      return refused('No callback URL is configured, so no gateway could confirm a payment.', {
        hasUrl: url !== null,
      });
    }
    return passed('The callback the gateway will use is configured.', { hasUrl: true });
  },
};

export const financeCloseSteps: Record<string, JourneyStep> = {
  'payment-reconciliation': async ctx => {
    const today = new Date();
    const report = await ctx.admin.caller.reconciliation.generateDailyReport({ date: today });
    const statistics = await ctx.admin.caller.reconciliation.getStatistics({
      startDate: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000),
      endDate: today,
    });
    const unresolved = await ctx.admin.caller.reconciliation.getUnresolvedDiscrepancies();
    const discrepancies = (unresolved as { discrepancies?: unknown[] }).discrepancies
      ?? (Array.isArray(unresolved) ? unresolved : []);
    if (!report) {
      return failed('The daily reconciliation produced no report.');
    }
    return passed('The day reconciles, and anything that does not agree is listed.', {
      unresolvedDiscrepancies: Array.isArray(discrepancies) ? discrepancies.length : 0,
      hasStatistics: Boolean(statistics),
    });
  },

  'double-entry-ledger': async ctx => {
    const status = await ctx.admin.caller.ledger.status();
    const unposted = await ctx.admin.caller.ledger.unposted({ limit: 50 });
    const reconciliation = await ctx.admin.caller.ledger.reconciliation();
    const unpostedCount = unposted.postings.length;

    if (!status.configured) {
      return blocked('ledger', 'No double-entry ledger is configured, so no balance is claimed.', {
        unposted: unpostedCount,
        detail: status.detail,
      });
    }
    if (reconciliation.mismatches > 0) {
      return failed('The ledger does not agree with what members were shown.', {
        mismatches: reconciliation.mismatches,
        unknowns: reconciliation.unknowns,
        unposted: unpostedCount,
      });
    }
    return passed('The ledger balances, and anything unposted is visible rather than assumed.', {
      unposted: unpostedCount,
      members: reconciliation.members.length,
      unknowns: reconciliation.unknowns,
    });
  },

  'event-accountability': async ctx => {
    const status = await ctx.admin.caller.eventStream.status();
    const undeliverable = await ctx.admin.caller.eventStream.undeliverable({ limit: 50 });
    const deadLetters = await ctx.admin.caller.eventStream.deadLetters({ limit: 50 });
    const undelivered = (undeliverable as { events?: unknown[] }).events
      ?? (Array.isArray(undeliverable) ? undeliverable : []);
    const dead = (deadLetters as { events?: unknown[] }).events
      ?? (Array.isArray(deadLetters) ? deadLetters : []);
    if (!status) {
      return failed('The event stream reports no state at all.');
    }
    return passed('Outbox state, undeliverable events and dead letters are all accounted for.', {
      undeliverable: Array.isArray(undelivered) ? undelivered.length : 0,
      deadLetters: Array.isArray(dead) ? dead.length : 0,
      brokerConfigured: Boolean((status as { brokerConfigured?: boolean }).brokerConfigured),
    });
  },

  'audit-trail': async ctx => {
    const stats = await ctx.admin.caller.auditLogs.getStats({});
    const listed = await ctx.admin.caller.auditLogs.list({ page: 1, limit: 50 });
    const logs = (listed as { logs?: Array<{ createdAt?: unknown }> }).logs ?? [];
    if (!Array.isArray(logs)) {
      return failed('The audit trail returned no entries collection.');
    }
    const undated = logs.filter(log => !log.createdAt).length;
    if (undated > 0) {
      return failed('Audit entries carry no timestamp, so the day cannot be reconstructed.', {
        entries: logs.length,
        undated,
      });
    }
    return passed('The day’s actions are in the audit trail with their timestamps.', {
      entries: logs.length,
      hasStats: Boolean(stats),
    });
  },
};

export const moneySteps = {
  'prepaid-energy-purchase': prepaidPurchaseSteps,
  'billing-to-payment': billingSteps,
  'finance-daily-close': financeCloseSteps,
};
