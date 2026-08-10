import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { PaymentReconciliationEngine } from '../payment-reconciliation';
import { getDb } from '../db';
import { paymentReconciliations, reconciliationReports, reconciliationAuditLogs } from '../../drizzle/schema';
import { eq, desc, and, gte, lte } from 'drizzle-orm';

/**
 * Admin-only procedure
 */
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  return next({ ctx });
});

/**
 * Payment Reconciliation Router
 */
export const reconciliationRouter = router({
  /**
   * Get unresolved discrepancies
   */
  getUnresolvedDiscrepancies: adminProcedure.query(async () => {
    return await PaymentReconciliationEngine.getUnresolvedDiscrepancies();
  }),

  /**
   * Get reconciliation by ID
   */
  getReconciliation: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const result = await db
        .select()
        .from(paymentReconciliations)
        .where(eq(paymentReconciliations.id, input.id))
        .limit(1);

      if (!result.length) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Reconciliation not found',
        });
      }

      return result[0];
    }),

  /**
   * Get reconciliations with filters
   */
  getReconciliations: adminProcedure
    .input(
      z.object({
        status: z.enum(['matched', 'unmatched', 'discrepancy', 'manual_review']).optional(),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        limit: z.number().default(50),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const conditions = [];
      if (input.status) {
        conditions.push(eq(paymentReconciliations.status, input.status));
      }
      if (input.startDate) {
        conditions.push(gte(paymentReconciliations.reconciliationDate, input.startDate));
      }
      if (input.endDate) {
        conditions.push(lte(paymentReconciliations.reconciliationDate, input.endDate));
      }

      let query = db.select().from(paymentReconciliations);

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as any;
      }

      return await query
        .orderBy(desc(paymentReconciliations.reconciliationDate))
        .limit(input.limit);
    }),

  /**
   * Resolve discrepancy
   */
  resolveDiscrepancy: adminProcedure
    .input(
      z.object({
        reconciliationId: z.number(),
        notes: z.string(),
        newStatus: z.enum(['matched', 'unmatched']),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await PaymentReconciliationEngine.resolveDiscrepancy(
        input.reconciliationId,
        ctx.user.id,
        input.notes,
        input.newStatus
      );

      return { success: true };
    }),

  /**
   * Reconcile payment manually
   */
  reconcilePayment: adminProcedure
    .input(z.object({ paymentId: z.number() }))
    .mutation(async ({ input }) => {
      const result = await PaymentReconciliationEngine.reconcilePayment(input.paymentId);
      return result;
    }),

  /**
   * Generate daily report
   */
  generateDailyReport: adminProcedure
    .input(z.object({ date: z.date() }))
    .mutation(async ({ input }) => {
      const reportId = await PaymentReconciliationEngine.generateDailyReport(input.date);
      return { reportId };
    }),

  /**
   * Get reconciliation reports
   */
  getReports: adminProcedure
    .input(
      z.object({
        reportType: z.enum(['daily', 'weekly', 'monthly']).optional(),
        limit: z.number().default(30),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      let query = db.select().from(reconciliationReports);

      if (input.reportType) {
        query = query.where(eq(reconciliationReports.reportType, input.reportType)) as any;
      }

      return await query
        .orderBy(desc(reconciliationReports.reportDate))
        .limit(input.limit);
    }),

  /**
   * Get audit logs for reconciliation
   */
  getAuditLogs: adminProcedure
    .input(z.object({ reconciliationId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      return await db
        .select()
        .from(reconciliationAuditLogs)
        .where(eq(reconciliationAuditLogs.reconciliationId, input.reconciliationId))
        .orderBy(desc(reconciliationAuditLogs.createdAt));
    }),

  /**
   * Get reconciliation statistics
   */
  getStatistics: adminProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const reconciliations = await db
        .select()
        .from(paymentReconciliations)
        .where(
          and(
            gte(paymentReconciliations.reconciliationDate, input.startDate),
            lte(paymentReconciliations.reconciliationDate, input.endDate)
          )
        );

      const total = reconciliations.length;
      const matched = reconciliations.filter(r => r.status === 'matched').length;
      const unmatched = reconciliations.filter(r => r.status === 'unmatched').length;
      const discrepancies = reconciliations.filter(r => r.status === 'discrepancy').length;
      const manualReview = reconciliations.filter(r => r.status === 'manual_review').length;

      const totalAmountDiscrepancy = reconciliations
        .filter(r => r.amountDifference)
        .reduce((sum, r) => sum + Math.abs(r.amountDifference || 0), 0);

      return {
        total,
        matched,
        unmatched,
        discrepancies,
        manualReview,
        matchRate: total > 0 ? (matched / total) * 100 : 0,
        totalAmountDiscrepancy,
      };
    }),
});
