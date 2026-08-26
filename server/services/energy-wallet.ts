/**
 * Energy Wallet + Auto Top-Up Service
 *
 * The wallet balance is DERIVED from the real ledger on every read:
 *   balance = Σ(payments completed) + Σ(top-ups completed)
 *             − Σ(billings issued) − Σ(token purchases)
 * and each computation is persisted as an append-only snapshot for audit.
 *
 * Auto top-up: when the derived balance falls below the user's threshold and
 * autoTopUp is enabled, a REAL top-up is initiated through
 * server/_core/paymentGateway.ts. Gateway functions throw *_NOT_CONFIGURED
 * when credentials are missing — that error is recorded on the attempt and
 * propagated. An attempt is 'initiated' only after the gateway accepted the
 * request, and becomes 'completed' only through reconciliation against the
 * gateway's own status API (the same verification path the webhooks use) —
 * never optimistically.
 */

import { getDb } from '../db';
import { sql, desc, eq } from 'drizzle-orm';
import {
  energyWallets,
  walletBalanceSnapshots,
  walletTopUpAttempts,
  EnergyWallet,
  WalletBalanceSnapshot,
} from '../../drizzle/grid-intel-schema';
import {
  initiateMpesaPayment,
  initiateAirtelPayment,
  initiateTigoPesaPayment,
  verifyPaymentStatus,
  PaymentResponse,
} from '../_core/paymentGateway';
import type { SqlRow } from '../sql-row';

export type TopUpMethod = 'mpesa' | 'airtel_money' | 'tigo_pesa';

export interface WalletView {
  userId: number;
  balanceCents: number;
  ledger: {
    paymentsCompletedCents: number;
    topUpsCompletedCents: number;
    billingsIssuedCents: number;
    tokenPurchasesCents: number;
  };
  settings: EnergyWallet | null;
  belowThreshold: boolean | null; // null when no threshold is configured
  snapshot: WalletBalanceSnapshot;
}

export interface TopUpResult {
  topUpInitiated: boolean;
  reason?: string;
  attemptId?: number;
  gatewayMessage?: string;
}

export function deriveWalletBalanceCents(input: {
  paymentsCompletedCents: number;
  topUpsCompletedCents: number;
  billingsPayableCents: number;
  tokenPurchasesCents: number;
}): number {
  return (
    input.paymentsCompletedCents +
    input.topUpsCompletedCents -
    input.billingsPayableCents -
    input.tokenPurchasesCents
  );
}

const GATEWAY_INITIATORS: Record<TopUpMethod, (req: { amount: number; phoneNumber: string; accountReference: string; description: string }) => Promise<PaymentResponse>> = {
  mpesa: initiateMpesaPayment,
  airtel_money: initiateAirtelPayment,
  tigo_pesa: initiateTigoPesaPayment,
};

export class EnergyWalletService {
  /**
   * Compute the wallet balance from the real ledger and persist a snapshot.
   */
  async computeBalanceSnapshot(userId: number, reason: string): Promise<WalletBalanceSnapshot> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const paymentsResult = await db.execute<SqlRow>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) as completed_cents,
        COALESCE(SUM(CASE WHEN status = 'completed' AND "paymentType" = 'token_purchase' THEN amount ELSE 0 END), 0) as token_purchases_cents
      FROM payments
      WHERE "userId" = ${userId}
    `);
    const ledger = paymentsResult.rows[0] || {};

    const billingsResult = await db.execute<SqlRow>(sql`
      SELECT COALESCE(SUM("consumerShare"), 0) as issued_cents
      FROM billings
      WHERE "userId" = ${userId} AND status IN ('issued', 'paid', 'overdue')
    `);
    const billingRow = billingsResult.rows[0] || {};

    // Wallet top-ups are charged through the gateway without creating a
    // `payments` row, so they have to be credited explicitly — otherwise a
    // confirmed top-up leaves the balance unchanged and auto top-up refires.
    const topUpsResult = await db.execute<SqlRow>(sql`
      SELECT COALESCE(SUM(amount_cents), 0) as completed_cents
      FROM wallet_top_up_attempts
      WHERE user_id = ${userId} AND status = 'completed'
    `);
    const topUpRow = topUpsResult.rows[0] || {};

    const paymentsCompletedCents = Number(ledger.completed_cents || 0);
    const tokenPurchasesCents = Number(ledger.token_purchases_cents || 0);
    const billingsIssuedCents = Number(billingRow.issued_cents || 0);
    const topUpsCompletedCents = Number(topUpRow.completed_cents || 0);
    const balanceCents = deriveWalletBalanceCents({
      paymentsCompletedCents,
      topUpsCompletedCents,
      billingsPayableCents: billingsIssuedCents,
      tokenPurchasesCents,
    });

    const insertResult = await db.insert(walletBalanceSnapshots).values({
      userId,
      balanceCents,
      paymentsCompletedCents,
      billingsIssuedCents,
      tokenPurchasesCents,
      topUpsCompletedCents,
      reason,
    }).returning({ id: walletBalanceSnapshots.id });
    const snapshotId = Number(insertResult[0].id);

    // Update the cached balance on the wallet row (create the row if absent)
    await db
      .insert(energyWallets)
      .values({ userId, balanceCents, lastComputedAt: new Date() })
      .onConflictDoUpdate({
        target: energyWallets.userId,
        set: { balanceCents, lastComputedAt: new Date() },
      });

    const rows = await db.select().from(walletBalanceSnapshots).where(eq(walletBalanceSnapshots.id, snapshotId)).limit(1);
    return rows[0];
  }

  /**
   * Full wallet view: freshly derived balance + settings.
   */
  async getWallet(userId: number): Promise<WalletView> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const snapshot = await this.computeBalanceSnapshot(userId, 'read');
    const settings = await this.getSettings(userId);

    return {
      userId,
      balanceCents: snapshot.balanceCents,
      ledger: {
        paymentsCompletedCents: snapshot.paymentsCompletedCents,
        topUpsCompletedCents: snapshot.topUpsCompletedCents,
        billingsIssuedCents: snapshot.billingsIssuedCents,
        tokenPurchasesCents: snapshot.tokenPurchasesCents,
      },
      settings,
      belowThreshold: settings?.lowBalanceThresholdCents != null
        ? snapshot.balanceCents < settings.lowBalanceThresholdCents
        : null,
      snapshot,
    };
  }

  async getSettings(userId: number): Promise<EnergyWallet | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    const rows = await db.select().from(energyWallets).where(eq(energyWallets.userId, userId)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or update wallet settings (threshold, auto top-up, method, phone).
   */
  async updateSettings(
    userId: number,
    settings: {
      lowBalanceThresholdCents?: number | null;
      autoTopUp?: boolean;
      topUpAmountCents?: number | null;
      preferredMethod?: TopUpMethod | null;
      phoneNumber?: string | null;
    }
  ): Promise<EnergyWallet> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    if (settings.autoTopUp) {
      // Fail loud at configuration time when auto top-up lacks what it needs
      const existing = await this.getSettings(userId);
      const method = settings.preferredMethod ?? existing?.preferredMethod;
      const phone = settings.phoneNumber ?? existing?.phoneNumber;
      const amount = settings.topUpAmountCents ?? existing?.topUpAmountCents;
      if (!method || !phone || !amount) {
        throw new Error('autoTopUp requires preferredMethod, phoneNumber and topUpAmountCents to be configured');
      }
    }

    const updateSet: Record<string, unknown> = {};
    if (settings.lowBalanceThresholdCents !== undefined) updateSet.lowBalanceThresholdCents = settings.lowBalanceThresholdCents;
    if (settings.autoTopUp !== undefined) updateSet.autoTopUp = settings.autoTopUp;
    if (settings.topUpAmountCents !== undefined) updateSet.topUpAmountCents = settings.topUpAmountCents;
    if (settings.preferredMethod !== undefined) updateSet.preferredMethod = settings.preferredMethod;
    if (settings.phoneNumber !== undefined) updateSet.phoneNumber = settings.phoneNumber;

    await db
      .insert(energyWallets)
      .values({ userId, ...updateSet } as any)
      .onConflictDoUpdate({ target: energyWallets.userId, set: updateSet });

    const updated = await this.getSettings(userId);
    return updated!;
  }

  /**
   * Check the derived balance against the user's threshold and, when below
   * and autoTopUp is enabled, initiate a real top-up.
   */
  async maybeAutoTopUp(userId: number): Promise<TopUpResult> {
    const snapshot = await this.computeBalanceSnapshot(userId, 'top_up_check');
    const settings = await this.getSettings(userId);

    if (!settings || !settings.autoTopUp) {
      return { topUpInitiated: false, reason: 'auto_top_up_disabled' };
    }
    if (settings.lowBalanceThresholdCents == null) {
      return { topUpInitiated: false, reason: 'no_threshold_configured' };
    }
    if (snapshot.balanceCents >= settings.lowBalanceThresholdCents) {
      return { topUpInitiated: false, reason: 'balance_above_threshold' };
    }
    if (!settings.preferredMethod || !settings.phoneNumber || !settings.topUpAmountCents) {
      throw new Error('autoTopUp is enabled but preferredMethod, phoneNumber or topUpAmountCents is missing');
    }

    return this.initiateTopUp(userId, settings.topUpAmountCents, settings.preferredMethod, settings.phoneNumber, 'auto');
  }

  /**
   * Initiate a real top-up through the configured gateway.
   * - Gateway *_NOT_CONFIGURED / network throws are recorded as 'failed' and rethrown.
   * - Gateway rejection (success:false) is recorded as 'failed' and reported.
   * - Gateway acceptance (success:true) is recorded as 'initiated'. Completion
   *   arrives only via reconciliation against the gateway status API.
   */
  async initiateTopUp(
    userId: number,
    amountCents: number,
    method: TopUpMethod,
    phoneNumber: string,
    triggerType: 'auto' | 'manual'
  ): Promise<TopUpResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    if (triggerType !== 'auto') {
      return this.startTopUp(db, userId, amountCents, method, phoneNumber, triggerType);
    }

    // A threshold check and provider request are separated by network I/O. Hold
    // a transaction-scoped per-user lock across that narrow sequence so two
    // callers cannot both observe a low balance and create two automatic
    // charges before either attempt is recorded. This is intentionally limited
    // to auto top-ups; consecutive manual purchases remain user-directed.
    return db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId})`);

      const existing = await tx
        .select({ id: walletTopUpAttempts.id })
        .from(walletTopUpAttempts)
        .where(
          sql`${walletTopUpAttempts.userId} = ${userId}
            AND ${walletTopUpAttempts.triggerType} = 'auto'
            AND ${walletTopUpAttempts.status} = 'initiated'`
        )
        .orderBy(desc(walletTopUpAttempts.createdAt))
        .limit(1);

      if (existing.length > 0) {
        return {
          topUpInitiated: false,
          reason: 'auto_top_up_pending',
          attemptId: Number(existing[0].id),
        };
      }

      return this.startTopUp(tx, userId, amountCents, method, phoneNumber, triggerType);
    });
  }

  private async startTopUp(
    db: any,
    userId: number,
    amountCents: number,
    method: TopUpMethod,
    phoneNumber: string,
    triggerType: 'auto' | 'manual'
  ): Promise<TopUpResult> {
    const accountReference = `WALLET-${userId}-${Date.now().toString(36)}`;

    let gatewayResponse: PaymentResponse;
    try {
      gatewayResponse = await GATEWAY_INITIATORS[method]({
        amount: amountCents,
        phoneNumber,
        accountReference,
        description: `Energy wallet top-up (${triggerType})`,
      });
    } catch (error: any) {
      // e.g. MPESA_NOT_CONFIGURED / AIRTEL_NOT_CONFIGURED / TIGO_NOT_CONFIGURED
      await db.insert(walletTopUpAttempts).values({
        userId,
        amountCents,
        method,
        phoneNumber,
        triggerType,
        status: 'failed',
        errorMessage: error.message || String(error),
      });
      throw error;
    }

    if (!gatewayResponse.success) {
      const insertResult = await db.insert(walletTopUpAttempts).values({
        userId,
        amountCents,
        method,
        phoneNumber,
        triggerType,
        status: 'failed',
        errorMessage: gatewayResponse.error || gatewayResponse.message,
      }).returning({ id: walletTopUpAttempts.id });
      return {
        topUpInitiated: false,
        reason: 'gateway_rejected',
        attemptId: Number(insertResult[0].id),
        gatewayMessage: gatewayResponse.message,
      };
    }

    const insertResult = await db.insert(walletTopUpAttempts).values({
      userId,
      amountCents,
      method,
      phoneNumber,
      triggerType,
      status: 'initiated',
      gatewayTransactionId: gatewayResponse.transactionId || null,
      gatewayCheckoutId: gatewayResponse.checkoutRequestId || null,
    }).returning({ id: walletTopUpAttempts.id });

    console.log(`[EnergyWallet] Top-up initiated for user ${userId}: ${amountCents}c via ${method} (${triggerType})`);

    return {
      topUpInitiated: true,
      attemptId: Number(insertResult[0].id),
      gatewayMessage: gatewayResponse.message,
    };
  }

  /**
   * Reconcile a user's initiated top-ups against the real gateway status API.
   * Only an explicit gateway 'completed' moves an attempt to 'completed' and
   * triggers a fresh balance snapshot.
   */
  async reconcileTopUps(userId: number): Promise<{ checked: number; completed: number; failed: number; stillPending: number }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const initiated = await db
      .select()
      .from(walletTopUpAttempts)
      .where(eq(walletTopUpAttempts.userId, userId))
      .orderBy(desc(walletTopUpAttempts.createdAt));

    let completed = 0;
    let failed = 0;
    let stillPending = 0;
    let checked = 0;

    for (const attempt of initiated.filter(a => a.status === 'initiated')) {
      const txnRef = attempt.method === 'mpesa'
        ? (attempt.gatewayCheckoutId || attempt.gatewayTransactionId)
        : (attempt.gatewayTransactionId || attempt.gatewayCheckoutId);
      if (!txnRef) {
        stillPending++;
        continue;
      }
      checked++;
      const verification = await verifyPaymentStatus(txnRef, attempt.method);
      if (verification.status === 'completed') {
        await this.markAttemptCompleted(attempt.id, txnRef);
        completed++;
      } else if (verification.status === 'failed') {
        await db.execute<SqlRow>(sql`
          UPDATE wallet_top_up_attempts SET status = 'failed', error_message = ${verification.message}
          WHERE id = ${attempt.id}
        `);
        failed++;
      } else {
        stillPending++;
      }
    }

    return { checked, completed, failed, stillPending };
  }

  /**
   * Mark an attempt completed (called by reconciliation or by an existing
   * payment webhook) and refresh the wallet snapshot.
   */
  async markAttemptCompleted(attemptId: number, gatewayTransactionId?: string): Promise<WalletBalanceSnapshot> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const rows = await db.select().from(walletTopUpAttempts).where(eq(walletTopUpAttempts.id, attemptId)).limit(1);
    const attempt = rows[0];
    if (!attempt) throw new Error(`Top-up attempt ${attemptId} not found`);
    if (attempt.status === 'completed') {
      // Idempotent: just return a fresh snapshot
      return this.computeBalanceSnapshot(attempt.userId, 'reconciliation');
    }

    await db.execute<SqlRow>(sql`
      UPDATE wallet_top_up_attempts SET
        status = 'completed',
        completed_at = NOW(),
        gateway_transaction_id = COALESCE(${gatewayTransactionId || null}, gateway_transaction_id)
      WHERE id = ${attemptId}
    `);

    return this.computeBalanceSnapshot(attempt.userId, 'reconciliation');
  }

  /** List a user's top-up attempts, newest first. */
  async listTopUpAttempts(userId: number, limit: number = 20) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');
    return db
      .select()
      .from(walletTopUpAttempts)
      .where(eq(walletTopUpAttempts.userId, userId))
      .orderBy(desc(walletTopUpAttempts.createdAt))
      .limit(limit);
  }
}

export const energyWallet = new EnergyWalletService();
